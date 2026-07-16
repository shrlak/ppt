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
 * transient (429/408/5xx/network). One retry rescues rate-limit bursts and
 * hiccups without materially delaying the fallback to the next engine.
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
 * Plan which engine+model attempts to run, in order. Lyric passes follow the
 * administrator-configured attempt list exactly (every catalog model in the
 * shared priority order). The quick title pass instead visits each engine
 * once — Gemini on its fast default model — because title identification
 * doesn't need the expensive models.
 */
function planAttempts(settings: AiSettings, lyricPass: boolean): RecognitionAttempt[] {
  if (lyricPass) return settings.attempts;
  const seen = new Set<string>();
  const attempts: RecognitionAttempt[] = [];
  for (const attempt of settings.attempts) {
    if (seen.has(attempt.engine)) continue;
    seen.add(attempt.engine);
    attempts.push(
      attempt.engine === 'gemini' ? { engine: 'gemini', model: settings.geminiModel } : attempt,
    );
  }
  return attempts;
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
    const key = settings.nvidiaApiKey.trim();
    if (!key && !PROXY_URL) throw new Error('NVIDIA API 키가 설정되지 않았습니다.');
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
    const key = settings.nvidiaApiKey.trim();
    if (!key && !PROXY_URL) throw new Error('NVIDIA API 키가 설정되지 않았습니다.');
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
  return !score.title && !score.key && score.order.length === 0 && score.sections.length === 0;
}

/**
 * Recognize a set of score pages as one operation. Each engine uses one
 * multimodal request for the entire set. An engine answer where every page
 * came back completely empty counts as a failure — a well-formed but blank
 * response must fall through to the next engine, not silently produce blank
 * cards.
 */
export async function recognizeScoreBatch(
  dataUrls: string[],
  settings: AiSettings,
  mode: BatchRecognitionMode,
  /** Optional per-image title hints (e.g. from the conti cover), advisory only. */
  hints?: (string | undefined)[],
): Promise<BatchRecognitionResult> {
  if (dataUrls.length === 0) return { scores: [], engine: settings.attempts[0]?.engine ?? 'off' };
  const attempts = planAttempts(settings, mode === 'full');
  if (attempts.length === 0) throw new Error('자동 인식이 꺼져 있습니다.');

  let lastError: Error | null = null;
  for (const attempt of attempts) {
    try {
      const scores = await withTransientRetry(() =>
        recognizeBatchWithEngine(attempt, dataUrls, settings, mode, hints),
      );
      if (scores.every((score) => isEmptyScore(score))) {
        throw new Error('인식 결과가 비어 있습니다.');
      }
      return { scores, engine: attempt.engine };
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      console.warn(`${attempt.engine} (${attempt.model}) 일괄 인식 실패, 다음 시도:`, lastError.message);
    }
  }
  throw lastError || new Error('모든 인식 엔진이 실패했습니다.');
}

/**
 * Run recognition on one score image, walking the administrator-configured
 * attempt list (engine+model pairs) top to bottom until one produces a
 * non-empty result. An empty answer also moves on to the next attempt.
 */
export async function recognizeScore(dataUrl: string, settings: AiSettings): Promise<RecognitionResult> {
  const attempts = planAttempts(settings, true);
  if (attempts.length === 0) {
    throw new Error('자동 인식이 꺼져 있습니다.');
  }

  let lastError: Error | null = null;
  for (const attempt of attempts) {
    try {
      const score = await withTransientRetry(() => recognizeWithEngine(attempt, dataUrl, settings));
      if (isEmptyScore(score)) throw new Error('인식 결과가 비어 있습니다.');
      return { score, engine: attempt.engine };
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      console.warn(`${attempt.engine} (${attempt.model}) 인식 실패, 다음 시도:`, lastError.message);
    }
  }

  throw lastError || new Error('모든 인식 엔진이 실패했습니다.');
}

/**
 * Recognize a set of score pages with several models AT ONCE: the top
 * `groupSize` attempts run in parallel, and the answers merge per song —
 * each page takes the highest-priority model's non-empty result, and pages
 * that model missed are filled from the next model's answer. One weak spot
 * in one model no longer decides the whole conti, and the extra models cost
 * no extra wall time because they run simultaneously. Falls through to the
 * next parallel group when an entire group produced nothing.
 */
export async function recognizeScoreBatchEnsemble(
  dataUrls: string[],
  settings: AiSettings,
  mode: BatchRecognitionMode,
  hints?: (string | undefined)[],
  groupSize = 2,
): Promise<BatchRecognitionResult> {
  if (dataUrls.length === 0) return { scores: [], engine: settings.attempts[0]?.engine ?? 'off' };
  const attempts = planAttempts(settings, mode === 'full');
  if (attempts.length === 0) throw new Error('자동 인식이 꺼져 있습니다.');

  let lastError: Error | null = null;
  for (let start = 0; start < attempts.length; start += groupSize) {
    const group = attempts.slice(start, start + groupSize);
    const settled = await Promise.allSettled(
      group.map((attempt) =>
        withTransientRetry(() => recognizeBatchWithEngine(attempt, dataUrls, settings, mode, hints)),
      ),
    );

    // Merge per song in priority order: first non-empty answer wins.
    const merged: (ParsedScore | undefined)[] = Array.from({ length: dataUrls.length });
    const contributions = new Array(group.length).fill(0);
    settled.forEach((result, attemptIndex) => {
      if (result.status === 'rejected') {
        lastError = result.reason instanceof Error ? result.reason : new Error(String(result.reason));
        console.warn(
          `${group[attemptIndex].engine} (${group[attemptIndex].model}) 동시 일괄 인식 실패:`,
          lastError.message,
        );
        return;
      }
      result.value.forEach((score, songIndex) => {
        if (merged[songIndex] === undefined && !isEmptyScore(score)) {
          merged[songIndex] = score;
          contributions[attemptIndex] += 1;
        }
      });
    });

    if (merged.some((score) => score !== undefined)) {
      // Report the engine that contributed the most songs.
      const primary = contributions.indexOf(Math.max(...contributions));
      return {
        scores: merged.map((score) => score ?? { order: [], sections: [] }),
        engine: group[primary >= 0 ? primary : 0].engine,
      };
    }
    console.warn(
      `동시 일괄 인식 그룹 (${group.map((attempt) => attempt.model).join(', ')}) 전체 실패, 다음 그룹 시도`,
    );
  }
  throw lastError || new Error('모든 인식 엔진이 실패했습니다.');
}

/**
 * Recognize one score image by running several models AT ONCE. Used for
 * pages that already failed the batch pass ("if needed"): attempts run in
 * parallel groups of `groupSize` in priority order, and the first non-empty
 * answer wins — a hard page gets multiple strong readers immediately
 * instead of waiting out the ladder one model at a time.
 */
export async function recognizeScoreRaced(
  dataUrl: string,
  settings: AiSettings,
  groupSize = 3,
): Promise<RecognitionResult> {
  const attempts = planAttempts(settings, true);
  if (attempts.length === 0) throw new Error('자동 인식이 꺼져 있습니다.');

  let lastError: Error | null = null;
  for (let start = 0; start < attempts.length; start += groupSize) {
    const group = attempts.slice(start, start + groupSize);
    try {
      return await Promise.any(
        group.map(async (attempt) => {
          const score = await withTransientRetry(() => recognizeWithEngine(attempt, dataUrl, settings));
          if (isEmptyScore(score)) throw new Error('인식 결과가 비어 있습니다.');
          return { score, engine: attempt.engine };
        }),
      );
    } catch (error) {
      const causes = error instanceof AggregateError ? error.errors : [error];
      lastError = causes[0] instanceof Error ? causes[0] : new Error(String(causes[0]));
      console.warn(
        `동시 인식 실패 (${group.map((attempt) => attempt.model).join(', ')}), 다음 그룹 시도:`,
        causes.map((cause) => (cause instanceof Error ? cause.message : String(cause))).join(' / '),
      );
    }
  }
  throw lastError || new Error('모든 인식 엔진이 실패했습니다.');
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
