// Orchestrates score recognition: given the chosen engine, turn a rendered score
// image into a draft song and merge it onto an existing Song without clobbering
// anything the user has already typed.
import type { Song } from '../utils/types';
import type { ParsedScore } from './scoreParser';
import type { AiSettings, RecognitionEngine } from './aiSettings';
import { recognizeBatchWithGemini, recognizeWithGemini, type BatchRecognitionMode } from './scoreAi';
import { recognizeBatchWithHuggingFace, recognizeWithHuggingFace } from './scoreHuggingFace';
import { sortSectionsByOrder } from '../utils/slidePlanner';

/**
 * Base URL of the optional shared recognition proxy (see worker/), baked into
 * the build at deploy time. Non-secret — safe to expose in client code, since
 * the actual API keys live only on the proxy server.
 */
const PROXY_URL = import.meta.env.VITE_RECOGNITION_PROXY_URL?.trim() || undefined;

async function recognizeWithEngine(
  engine: RecognitionEngine,
  dataUrl: string,
  settings: AiSettings,
): Promise<ParsedScore> {
  if (engine === 'gemini') {
    const key = settings.geminiApiKey.trim();
    if (!key && !PROXY_URL) throw new Error('Gemini API 키가 설정되지 않았습니다.');
    return recognizeWithGemini(dataUrl, key, settings.geminiModel, settings.geminiUseSearch, PROXY_URL);
  }
  if (engine === 'huggingface') {
    const key = settings.huggingfaceApiKey.trim();
    if (!key && !PROXY_URL) throw new Error('Hugging Face API 키가 설정되지 않았습니다.');
    return recognizeWithHuggingFace(dataUrl, key, undefined, PROXY_URL);
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
  engine: RecognitionEngine,
  dataUrls: string[],
  settings: AiSettings,
  mode: BatchRecognitionMode,
): Promise<ParsedScore[]> {
  if (engine === 'gemini') {
    const key = settings.geminiApiKey.trim();
    if (!key && !PROXY_URL) throw new Error('Gemini API 키가 설정되지 않았습니다.');
    return recognizeBatchWithGemini(
      dataUrls,
      key,
      settings.geminiModel,
      mode,
      mode === 'full' && settings.geminiUseSearch,
      PROXY_URL,
    );
  }
  if (engine === 'huggingface') {
    const key = settings.huggingfaceApiKey.trim();
    if (!key && !PROXY_URL) throw new Error('Hugging Face API 키가 설정되지 않았습니다.');
    return recognizeBatchWithHuggingFace(dataUrls, key, mode, undefined, PROXY_URL);
  }
  throw new Error('자동 인식이 꺼져 있습니다.');
}

/**
 * Recognize a set of score pages as one operation. Gemini and Hugging Face
 * each use one multimodal request for the entire set.
 */
export async function recognizeScoreBatch(
  dataUrls: string[],
  settings: AiSettings,
  mode: BatchRecognitionMode,
): Promise<BatchRecognitionResult> {
  if (dataUrls.length === 0) return { scores: [], engine: settings.engine };
  const engines = [settings.engine, ...settings.fallbackEngines].filter((e) => e !== 'off');
  if (engines.length === 0) throw new Error('자동 인식이 꺼져 있습니다.');

  let lastError: Error | null = null;
  for (const engine of engines) {
    try {
      const scores = await recognizeBatchWithEngine(engine, dataUrls, settings, mode);
      return { scores, engine };
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      console.warn(`${engine} 일괄 인식 실패, 다음 엔진 시도:`, lastError.message);
    }
  }
  throw lastError || new Error('모든 인식 엔진이 실패했습니다.');
}

/**
 * Run recognition on one score image in priority order — Gemini until its
 * tokens/quota run out or it otherwise fails, then Hugging Face (per
 * DEFAULT_AI_SETTINGS).
 */
export async function recognizeScore(dataUrl: string, settings: AiSettings): Promise<RecognitionResult> {
  const engines = [settings.engine, ...settings.fallbackEngines].filter((e) => e !== 'off');
  if (engines.length === 0) {
    throw new Error('자동 인식이 꺼져 있습니다.');
  }

  let lastError: Error | null = null;
  for (const engine of engines) {
    try {
      return { score: await recognizeWithEngine(engine, dataUrl, settings), engine };
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      console.warn(`${engine} 인식 실패, 다음 엔진 시도:`, lastError.message);
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
