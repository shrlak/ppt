// Orchestrates score recognition: given the chosen engine, turn a rendered score
// image into a draft song and merge it onto an existing Song without clobbering
// anything the user has already typed.
import type { Song } from '../utils/types';
import type { ParsedScore } from './scoreParser';
import type { AiSettings, RecognitionEngine } from './aiSettings';
import { recognizeWithGemini } from './scoreAi';
import { recognizeWithHuggingFace } from './scoreHuggingFace';
import { recognizeWithTesseract, type OcrProgress } from './scoreOcr';

export type { OcrProgress } from './scoreOcr';

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
  onProgress?: OcrProgress,
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
  if (engine === 'tesseract') {
    return recognizeWithTesseract(dataUrl, onProgress);
  }
  throw new Error('자동 인식이 꺼져 있습니다.');
}

export interface RecognitionResult {
  score: ParsedScore;
  /** Which engine actually produced the result, so the UI can say so. */
  engine: RecognitionEngine;
}

/**
 * Run recognition on one score image in priority order — Gemini, then
 * Hugging Face, then on-device Tesseract OCR (per DEFAULT_AI_SETTINGS) —
 * falling through to the next engine whenever one fails or is unavailable.
 */
export async function recognizeScore(
  dataUrl: string,
  settings: AiSettings,
  onProgress?: OcrProgress,
): Promise<RecognitionResult> {
  const engines = [settings.engine, ...settings.fallbackEngines].filter((e) => e !== 'off');
  if (engines.length === 0) {
    throw new Error('자동 인식이 꺼져 있습니다.');
  }

  let lastError: Error | null = null;
  for (const engine of engines) {
    try {
      return { score: await recognizeWithEngine(engine, dataUrl, settings, onProgress), engine };
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
    next.sections = parsed.sections.map((s) => ({ label: s.label, lines: [...s.lines] }));
    if (parsed.order.length > 0) {
      next.order = [...parsed.order];
    } else {
      // Derive an order from the recognized parts (title slide handled by "I").
      next.order = ['I', ...parsed.sections.map((s) => s.label)];
    }
  } else if (parsed.order.length > 0 && song.order.join('-') === 'I') {
    // Lyrics already present but order is still the default — accept the order.
    next.order = [...parsed.order];
  }

  return next;
}
