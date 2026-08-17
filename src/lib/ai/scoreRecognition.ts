// Orchestrates score recognition: given the chosen engine, turn a rendered score
// image into a draft song and merge it onto an existing Song without clobbering
// anything the user has already typed.
import type { Section, Song } from '../utils/types';
import type { BatchRecognitionMode, ParsedScore } from './scoreParser';
import type { AiSettings, RecognitionAttempt, RecognitionEngine } from './aiSettings';
import { recognizeBatchWithGemini, recognizeWithGemini } from './scoreAi';
import { recognizeBatchWithOpenRouter, recognizeWithOpenRouter } from './scoreNvidia';
import { RecognitionError, isTransientRecognitionError } from './recognitionError';
import { classifyRecognitionError, type RecognitionObservation } from './recognitionObservation';
import {
  SAME_LINE_THRESHOLD,
  adoptSplitVerses,
  adoptTruncatedTails,
  buildWeightedConsensus,
} from './weightedConsensus';
import { modelKeyFor, type ModelReliability } from './modelReliability';
import { lineKey, lineSimilarity } from '../lyrics/textSimilarity';
import { findSection, sortSectionsByOrder } from '../utils/slidePlanner';

/**
 * Base URL of the optional shared recognition proxy (see worker/), baked into
 * the build at deploy time. Non-secret — safe to expose in client code, since
 * the actual API keys live only on the proxy server.
 */
const PROXY_URL = import.meta.env.VITE_RECOGNITION_PROXY_URL?.trim() || undefined;

/** Wait before the single transient-failure retry (rate limit bursts, 5xx). */
const TRANSIENT_RETRY_DELAY_MS = 1500;

/**
 * Hard cap on one model's batch call.
 *
 * Consensus needs every model's answer, so the batch waits for all of them
 * rather than finishing on the first. That makes a provider that accepts a
 * request and never answers able to hang the whole job, which the cap
 * prevents: a model past the cap is recorded as a timeout observation and the
 * remaining models decide the page.
 */
const ATTEMPT_TIMEOUT_MS = 120_000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Run an engine call, retrying once after a short pause when the failure is
 * transient (408/5xx/network). One retry rescues brief provider hiccups while
 * the rest of the model pool continues independently.
 */
async function withTransientRetry<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (!isTransientRecognitionError(error)) throw error;
    await delay(TRANSIENT_RETRY_DELAY_MS);
    return call();
  }
}

/**
 * Return the complete shared model pool. Every recognition phase launches
 * this entire pool concurrently; array order is display-only and never gates
 * which provider starts first.
 */
function planAttempts(settings: AiSettings): RecognitionAttempt[] {
  return settings.attempts;
}

async function recognizeWithEngine(
  attempt: RecognitionAttempt,
  dataUrl: string,
  settings: AiSettings,
): Promise<ParsedScore> {
  if (attempt.engine === 'gemini') {
    const key = settings.geminiApiKey.trim();
    if (!key && !PROXY_URL) throw new Error('Gemini API 키가 설정되지 않았습니다.');
    return recognizeWithGemini(dataUrl, key, attempt.model, settings.geminiUseSearch, PROXY_URL);
  }
  if (attempt.engine === 'openrouter') {
    const key = settings.openrouterApiKey.trim();
    if (!key && !PROXY_URL) throw new Error('OpenRouter API 키가 설정되지 않았습니다.');
    return recognizeWithOpenRouter(dataUrl, key, attempt.model, PROXY_URL);
  }
  throw new Error('자동 인식이 꺼져 있습니다.');
}

export interface RecognitionResult {
  score: ParsedScore;
  /** Which engine actually produced the result, so the UI can say so. */
  engine: RecognitionEngine;
}

export interface BatchRecognitionResult {
  /** Results remain aligned with the input image order. */
  scores: ParsedScore[];
  engine: RecognitionEngine;
  /** Every model's settled answer for each page, in the same page order. */
  observations: RecognitionObservation[][];
  /** Weighted consensus confidence per page (0–1). */
  confidence: number[];
  /** Pages whose answer is not settled enough to save without a look. */
  needsReview: boolean[];
}

async function recognizeBatchWithEngine(
  attempt: RecognitionAttempt,
  dataUrls: string[],
  settings: AiSettings,
  mode: BatchRecognitionMode,
  hints?: (string | undefined)[],
): Promise<ParsedScore[]> {
  if (attempt.engine === 'gemini') {
    const key = settings.geminiApiKey.trim();
    if (!key && !PROXY_URL) throw new Error('Gemini API 키가 설정되지 않았습니다.');
    return recognizeBatchWithGemini(
      dataUrls,
      key,
      attempt.model,
      mode,
      mode === 'full' && settings.geminiUseSearch,
      PROXY_URL,
      hints,
    );
  }
  if (attempt.engine === 'openrouter') {
    const key = settings.openrouterApiKey.trim();
    if (!key && !PROXY_URL) throw new Error('OpenRouter API 키가 설정되지 않았습니다.');
    return recognizeBatchWithOpenRouter(dataUrls, key, mode, attempt.model, PROXY_URL, hints);
  }
  throw new Error('자동 인식이 꺼져 있습니다.');
}

/** True when the result carries nothing usable at all. */
function isEmptyScore(score: ParsedScore | undefined): boolean {
  if (!score) return true;
  // A confidently classified non-score page is useful even when it contains
  // neither requested field: the caller must still keep it out of 찬양 가사.
  if (score.pageType === 'non_score') return false;
  return (
    !score.sermonTitle &&
    !score.scripture &&
    !score.title &&
    !score.key &&
    score.order.length === 0 &&
    score.sections.length === 0
  );
}

/**
 * Recognize a set of score pages as one operation. Every model receives one
 * multimodal batch request at the same time; blank answers never claim a page.
 */
export async function recognizeScoreBatch(
  dataUrls: string[],
  settings: AiSettings,
  mode: BatchRecognitionMode,
  /** Optional per-image title hints (e.g. from the conti cover), advisory only. */
  hints?: (string | undefined)[],
  reliabilities: ModelReliability[] = [],
): Promise<BatchRecognitionResult> {
  return recognizeBatchWithAllModels(dataUrls, settings, mode, hints, reliabilities);
}

/**
 * Run every configured model on one score image at the same time and make
 * them work together: the highest-priority model that produced a usable
 * answer wins (a failed or empty higher model just yields to the next), and
 * whatever the winner missed is filled from the other models' answers.
 */
export async function recognizeScore(dataUrl: string, settings: AiSettings): Promise<RecognitionResult> {
  const attempts = planAttempts(settings);
  if (attempts.length === 0) {
    throw new Error('자동 인식이 꺼져 있습니다.');
  }

  return new Promise((resolve, reject) => {
    // undefined = still running, null = failed, ParsedScore = that model's answer.
    const answers: (ParsedScore | null | undefined)[] = new Array(attempts.length).fill(undefined);
    let finished = false;
    let lastError: Error | null = null;

    const tryFinish = () => {
      if (finished) return;
      for (let index = 0; index < attempts.length; index += 1) {
        const answer = answers[index];
        if (answer === undefined) return; // a higher-priority model may still answer
        if (answer && !isEmptyScore(answer)) {
          const others = answers.filter(
            (score, other): score is ParsedScore => other !== index && !!score && !isEmptyScore(score),
          );
          finished = true;
          resolve({ score: fillScoreGaps(answer, others), engine: attempts[index].engine });
          return;
        }
      }
      finished = true;
      reject(lastError || new Error('모든 인식 엔진이 실패했습니다.'));
    };

    attempts.forEach((attempt, index) => {
      void withTransientRetry(() => recognizeWithEngine(attempt, dataUrl, settings))
        .then((score) => {
          answers[index] = score;
        })
        .catch((error) => {
          answers[index] = null;
          lastError = error instanceof Error ? error : new Error(String(error));
          console.warn(`${attempt.engine} (${attempt.model}) 동시 인식 실패:`, lastError.message);
        })
        .finally(tryFinish);
    });
  });
}

/**
 * Merge one page's winning answer with the other models' answers for that
 * page: whatever the winner missed (title, key, order, sections, sermon
 * fields) is filled from the next candidate that read it. Candidates whose
 * page classification contradicts the winner's are skipped — a model that
 * thinks the page is 악보 must not inject lyrics into a non-score verdict.
 */
function fillScoreGaps(winner: ParsedScore, candidates: ParsedScore[]): ParsedScore {
  const merged: ParsedScore = { ...winner, order: [...winner.order], sections: [...winner.sections] };
  const usable: ParsedScore[] = [];
  for (const candidate of candidates) {
    if (merged.pageType && candidate.pageType && candidate.pageType !== merged.pageType) continue;
    usable.push(candidate);
    if (!merged.title && candidate.title) merged.title = candidate.title;
    if (!merged.key && candidate.key) merged.key = candidate.key;
    if (merged.order.length === 0 && candidate.order.length > 0) merged.order = [...candidate.order];
    if (merged.sections.length === 0 && candidate.sections.length > 0) {
      merged.sections = candidate.sections.map((section) => ({ label: section.label, lines: [...section.lines] }));
    }
    if (!merged.lyricRowCount && candidate.lyricRowCount) merged.lyricRowCount = candidate.lyricRowCount;
    if (!merged.sermonTitle && candidate.sermonTitle) merged.sermonTitle = candidate.sermonTitle;
    if (!merged.scripture && candidate.scripture) merged.scripture = candidate.scripture;
  }
  return adoptLineConsensus(adoptTruncatedTails(adoptSplitVerses(merged, usable), usable), usable);
}

/**
 * Let the models outvote each other line by line, one vote each.
 *
 * This is the unweighted fallback used where no reliability data is available
 * — the per-page rescue path and any pool with no measurements yet. Once a
 * model has verified evaluations behind it, buildWeightedConsensus supersedes
 * this by weighting each vote by that model's measured lyric accuracy.
 *
 * Most of what recognition still gets wrong is not structural — it is a
 * syllable or two inside an otherwise correct line. Those slips are
 * independent per model, so when two other models read a line the same way and
 * the winner reads it differently, the agreement is more likely to be the page.
 * A vote needs at least two other readings to beat the winner's one, so this is
 * inert for a single-model pool and for a pool of two.
 */
function adoptLineConsensus(score: ParsedScore, candidates: ParsedScore[]): ParsedScore {
  if (candidates.length < 2) return score;
  let touched = false;
  const sections = score.sections.map((section) => {
    // Only sections the candidate read with the same number of lines can be
    // aligned line-for-line; anything else would compare across a shifted part.
    const aligned = candidates
      .map((candidate) => findSection(candidate.sections, section.label))
      .filter((found): found is Section => !!found && found.lines.length === section.lines.length);
    if (aligned.length < 2) return section;

    let replaced = false;
    const lines = section.lines.map((line, index) => {
      const votes = new Map<string, { text: string; count: number }>();
      const add = (text: string) => {
        if (!text.trim()) return;
        const key = lineKey(text);
        const seen = votes.get(key);
        if (seen) seen.count += 1;
        else votes.set(key, { text, count: 1 });
      };
      add(line);
      for (const other of aligned) add(other.lines[index]);

      const own = votes.get(lineKey(line))?.count ?? 0;
      const best = [...votes.values()].sort((a, b) => b.count - a.count)[0];
      if (!best || best.count <= own) return line;
      if (lineSimilarity(best.text, line) < SAME_LINE_THRESHOLD) return line;
      replaced = true;
      return best.text;
    });

    if (!replaced) return section;
    touched = true;
    return { label: section.label, lines };
  });
  return touched ? { ...score, sections } : score;
}

/**
 * Start every model together and reconcile their answers page by page.
 *
 * Nothing is thrown away any more: every model's settled answer becomes an
 * observation, and buildWeightedConsensus decides each field by weighted vote
 * among them. Keeping the losing answers is what lets a later verified
 * correction score each model, and what lets two models outvote a third.
 *
 * The call waits for every model rather than finishing on the first usable
 * answer, because a vote needs the votes.
 */
async function recognizeBatchWithAllModels(
  dataUrls: string[],
  settings: AiSettings,
  mode: BatchRecognitionMode,
  hints?: (string | undefined)[],
  reliabilities: ModelReliability[] = [],
): Promise<BatchRecognitionResult> {
  if (dataUrls.length === 0) {
    return {
      scores: [],
      engine: settings.attempts[0]?.engine ?? 'off',
      observations: [],
      confidence: [],
      needsReview: [],
    };
  }
  const attempts = planAttempts(settings);
  if (attempts.length === 0) throw new Error('자동 인식이 꺼져 있습니다.');

  const perModel = await Promise.all(
    attempts.map((attempt) => runBatchAttempt(attempt, dataUrls, settings, mode, hints)),
  );

  const assembled = assembleBatchConsensus(attempts, perModel, dataUrls.length, reliabilities);
  // An answer for no page at all is a failed job, not a job with empty pages:
  // the caller falls back to the per-page rescue pass rather than showing the
  // user a conti of blank songs.
  if (assembled.observations.every((page) => page.every((observation) => !observation.score))) {
    throw new Error('모든 인식 엔진이 실패했습니다.');
  }
  return assembled;
}

/** One model's whole batch: its answers, or the category of its failure. */
interface BatchAttemptResult {
  attempt: RecognitionAttempt;
  scores?: ParsedScore[];
  error?: ReturnType<typeof classifyRecognitionError>;
  latencyMs: number;
}

async function runBatchAttempt(
  attempt: RecognitionAttempt,
  dataUrls: string[],
  settings: AiSettings,
  mode: BatchRecognitionMode,
  hints?: (string | undefined)[],
): Promise<BatchAttemptResult> {
  const startedAt = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const scores = await Promise.race([
      withTransientRetry(() => recognizeBatchWithEngine(attempt, dataUrls, settings, mode, hints)),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new RecognitionError('인식 응답 시간 초과', 408)), ATTEMPT_TIMEOUT_MS);
      }),
    ]);
    return { attempt, scores, latencyMs: Date.now() - startedAt };
  } catch (error) {
    const category = classifyRecognitionError(error);
    // Only the CATEGORY is kept. A provider body can echo the prompt back, and
    // the prompt carries lyrics.
    console.warn(`${attempt.engine} (${attempt.model}) 동시 일괄 인식 실패: ${category}`);
    return { attempt, error: category, latencyMs: Date.now() - startedAt };
  } finally {
    clearTimeout(timer);
  }
}

/** Turn per-model batch answers into per-page observations and consensus. */
export function assembleBatchConsensus(
  attempts: RecognitionAttempt[],
  perModel: BatchAttemptResult[],
  pageCount: number,
  reliabilities: ModelReliability[] = [],
): BatchRecognitionResult {
  const observations: RecognitionObservation[][] = [];
  const scores: ParsedScore[] = [];
  const confidence: number[] = [];
  const needsReview: boolean[] = [];
  const contributions = new Map<string, number>();

  for (let page = 0; page < pageCount; page += 1) {
    const pageObservations: RecognitionObservation[] = perModel.map((result) => {
      const score = result.scores?.[page];
      return {
        attempt: result.attempt,
        score: score && !isEmptyScore(score) ? score : undefined,
        error: result.scores ? (score && !isEmptyScore(score) ? undefined : 'format') : result.error,
        latencyMs: result.latencyMs,
      };
    });
    observations.push(pageObservations);

    const consensus = buildWeightedConsensus(pageObservations, reliabilities);
    scores.push(consensus.score);
    confidence.push(consensus.confidence);
    needsReview.push(consensus.needsReview);
    for (const modelKey of consensus.usedModels) {
      contributions.set(modelKey, (contributions.get(modelKey) ?? 0) + 1);
    }
  }

  const leadKey = [...contributions.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  const engine =
    attempts.find((attempt) => modelKeyFor(attempt) === leadKey)?.engine ?? attempts[0]?.engine ?? 'off';

  return { scores, engine, observations, confidence, needsReview };
}

/**
 * Compatibility name used by the full-lyrics flow. All models now launch in
 * one concurrent pool; there are no priority groups.
 */
export async function recognizeScoreBatchEnsemble(
  dataUrls: string[],
  settings: AiSettings,
  mode: BatchRecognitionMode,
  hints?: (string | undefined)[],
  reliabilities: ModelReliability[] = [],
): Promise<BatchRecognitionResult> {
  return recognizeBatchWithAllModels(dataUrls, settings, mode, hints, reliabilities);
}

/**
 * Compatibility name used by the rescue flow. All configured models start
 * together and cooperate on the answer (see recognizeScore).
 */
export async function recognizeScoreRaced(
  dataUrl: string,
  settings: AiSettings,
): Promise<RecognitionResult> {
  return recognizeScore(dataUrl, settings);
}

function hasLyrics(song: Song): boolean {
  return song.sections.some((s) => s.lines.some((l) => l.trim().length > 0));
}

/** A stub title like "새 찬양 (p.3)" that recognition may replace. */
function isStubTitle(title: string): boolean {
  return !title.trim() || /^새 찬양/.test(title.trim());
}

/**
 * Merge a recognition result onto a song. Recognized lyrics/sections replace the
 * blank scaffold, but a title/key/order the user already set is kept. Returns a
 * new Song (never mutates the input).
 */
export function applyScoreToSong(song: Song, parsed: ParsedScore): Song {
  const next: Song = { ...song };

  if (parsed.title && isStubTitle(song.title)) next.title = parsed.title;
  if (parsed.key && !song.key) next.key = parsed.key;

  // Only fill sections/order if the user hasn't started writing lyrics.
  if (!hasLyrics(song) && parsed.sections.length > 0) {
    const recognized = parsed.sections.map((s) => ({ label: s.label, lines: [...s.lines] }));
    const order =
      parsed.order.length > 0
        ? parsed.order
        : ['I', ...recognized.map((s) => s.label)]; // no printed order: derive one (title slide is "I")
    next.sections = sortSectionsByOrder(recognized, order);
    next.order = [...order];
  } else if (parsed.order.length > 0 && song.order.join('-') === 'I') {
    // Lyrics already present but order is still the default — accept the order.
    next.order = [...parsed.order];
  }

  return next;
}
