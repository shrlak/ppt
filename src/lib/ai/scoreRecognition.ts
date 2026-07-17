// Orchestrates score recognition: given the chosen engine, turn a rendered score
// image into a draft song and merge it onto an existing Song without clobbering
// anything the user has already typed.
import type { Song } from '../utils/types';
import type { BatchRecognitionMode, ParsedScore } from './scoreParser';
import type { AiSettings, RecognitionAttempt, RecognitionEngine } from './aiSettings';
import { recognizeBatchWithGemini, recognizeWithGemini } from './scoreAi';
import { recognizeBatchWithNvidia, recognizeWithNvidia } from './scoreNvidia';
import { recognizeBatchWithHuggingFace, recognizeWithHuggingFace } from './scoreHuggingFace';
import { isTransientRecognitionError } from './recognitionError';
import { sortSectionsByOrder } from '../utils/slidePlanner';

/**
 * Base URL of the optional shared recognition proxy (see worker/), baked into
 * the build at deploy time. Non-secret — safe to expose in client code, since
 * the actual API keys live only on the proxy server.
 */
const PROXY_URL = import.meta.env.VITE_RECOGNITION_PROXY_URL?.trim() || undefined;

/** Wait before the single transient-failure retry (rate limit bursts, 5xx). */
const TRANSIENT_RETRY_DELAY_MS = 1500;

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
  if (attempt.engine === 'nvidia') {
    const key = settings.openrouterApiKey.trim();
    if (!key && !PROXY_URL) throw new Error('OpenRouter API 키가 설정되지 않았습니다.');
    return recognizeWithNvidia(dataUrl, key, attempt.model, PROXY_URL);
  }
  if (attempt.engine === 'huggingface') {
    const key = settings.huggingfaceApiKey.trim();
    if (!key && !PROXY_URL) throw new Error('Hugging Face API 키가 설정되지 않았습니다.');
    return recognizeWithHuggingFace(dataUrl, key, attempt.model, PROXY_URL);
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
  if (attempt.engine === 'nvidia') {
    const key = settings.openrouterApiKey.trim();
    if (!key && !PROXY_URL) throw new Error('OpenRouter API 키가 설정되지 않았습니다.');
    return recognizeBatchWithNvidia(dataUrls, key, mode, attempt.model, PROXY_URL, hints);
  }
  if (attempt.engine === 'huggingface') {
    const key = settings.huggingfaceApiKey.trim();
    if (!key && !PROXY_URL) throw new Error('Hugging Face API 키가 설정되지 않았습니다.');
    return recognizeBatchWithHuggingFace(dataUrls, key, mode, attempt.model, PROXY_URL, hints);
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
): Promise<BatchRecognitionResult> {
  return recognizeBatchWithAllModels(dataUrls, settings, mode, hints);
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
  for (const candidate of candidates) {
    if (merged.pageType && candidate.pageType && candidate.pageType !== merged.pageType) continue;
    if (!merged.title && candidate.title) merged.title = candidate.title;
    if (!merged.key && candidate.key) merged.key = candidate.key;
    if (merged.order.length === 0 && candidate.order.length > 0) merged.order = [...candidate.order];
    if (merged.sections.length === 0 && candidate.sections.length > 0) {
      merged.sections = candidate.sections.map((section) => ({ label: section.label, lines: [...section.lines] }));
    }
    if (!merged.sermonTitle && candidate.sermonTitle) merged.sermonTitle = candidate.sermonTitle;
    if (!merged.scripture && candidate.scripture) merged.scripture = candidate.scripture;
  }
  return merged;
}

/**
 * Start every model together and make them WORK TOGETHER on the answer:
 *
 * - Each page's final result comes from the highest-priority (pool-order)
 *   model that actually read it — a fast-but-weak model can no longer
 *   displace a stronger model's answer just by finishing first. A page
 *   finalizes as soon as every higher-priority model has settled, so a
 *   failed or rate-limited top model never blocks the rest.
 * - The winning answer is then completed from the other models: a missing
 *   key, 진행 순서, lyric sections, or sermon field is filled from the next
 *   model that read it, so one page can be assembled from several models.
 *
 * The call resolves once every page is final (or every model has settled);
 * provider calls still in flight keep running in the background and remain
 * accounted for by the Worker.
 */
function recognizeBatchWithAllModels(
  dataUrls: string[],
  settings: AiSettings,
  mode: BatchRecognitionMode,
  hints?: (string | undefined)[],
): Promise<BatchRecognitionResult> {
  if (dataUrls.length === 0) {
    return Promise.resolve({ scores: [], engine: settings.attempts[0]?.engine ?? 'off' });
  }
  const attempts = planAttempts(settings);
  if (attempts.length === 0) return Promise.reject(new Error('자동 인식이 꺼져 있습니다.'));

  return new Promise((resolve, reject) => {
    // undefined = still running, null = failed, array = that model's answers.
    const answers: (ParsedScore[] | null | undefined)[] = new Array(attempts.length).fill(undefined);
    let finished = false;
    let lastError: Error | null = null;

    /** The page's final answer, or undefined while a higher-priority model
     * that could still claim the page is running (also undefined when every
     * model settled without reading the page — the caller resolves that). */
    const finalWinner = (page: number): { score: ParsedScore; attemptIndex: number } | undefined => {
      for (let index = 0; index < attempts.length; index += 1) {
        const answer = answers[index];
        if (answer === undefined) return undefined;
        if (answer && !isEmptyScore(answer[page])) return { score: answer[page], attemptIndex: index };
      }
      return undefined;
    };

    const tryFinish = () => {
      if (finished) return;
      const allSettled = answers.every((answer) => answer !== undefined);
      const winners = dataUrls.map((_, page) => finalWinner(page));
      if (!allSettled && winners.some((winner) => winner === undefined)) return;
      if (winners.every((winner) => winner === undefined)) {
        finished = true;
        reject(lastError || new Error('모든 인식 엔진이 실패했습니다.'));
        return;
      }
      const contributions = new Map<number, number>();
      const scores = winners.map((winner, page) => {
        if (!winner) return { order: [], sections: [] } as ParsedScore;
        contributions.set(winner.attemptIndex, (contributions.get(winner.attemptIndex) ?? 0) + 1);
        const others = answers
          .map((answer, index) => (index === winner.attemptIndex ? undefined : answer?.[page]))
          .filter((score): score is ParsedScore => score !== undefined && !isEmptyScore(score));
        return fillScoreGaps(winner.score, others);
      });
      const primary = [...contributions.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 0;
      finished = true;
      resolve({ scores, engine: attempts[primary].engine });
    };

    attempts.forEach((attempt, index) => {
      void withTransientRetry(() => recognizeBatchWithEngine(attempt, dataUrls, settings, mode, hints))
        .then((scores) => {
          answers[index] = scores;
        })
        .catch((error) => {
          answers[index] = null;
          lastError = error instanceof Error ? error : new Error(String(error));
          console.warn(`${attempt.engine} (${attempt.model}) 동시 일괄 인식 실패:`, lastError.message);
        })
        .finally(tryFinish);
    });
  });
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
): Promise<BatchRecognitionResult> {
  return recognizeBatchWithAllModels(dataUrls, settings, mode, hints);
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
