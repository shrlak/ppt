// Orchestrates score recognition: given the chosen engine, turn a rendered score
// image into a draft song and merge it onto an existing Song without clobbering
// anything the user has already typed.
import type { Song } from './types';
import type { ParsedScore } from './scoreParser';
import type { AiSettings } from './aiSettings';
import { recognizeWithGemini } from './scoreAi';
import { recognizeWithTesseract, type OcrProgress } from './scoreOcr';

export type { OcrProgress } from './scoreOcr';

/** Run the configured recognition engine on one score image. */
export async function recognizeScore(
  dataUrl: string,
  settings: AiSettings,
  onProgress?: OcrProgress,
): Promise<ParsedScore> {
  if (settings.engine === 'gemini') {
    const key = settings.geminiApiKey.trim();
    if (!key) throw new Error('Gemini API 키가 설정되지 않았습니다.');
    return recognizeWithGemini(dataUrl, key, settings.geminiModel);
  }
  if (settings.engine === 'tesseract') {
    return recognizeWithTesseract(dataUrl, onProgress);
  }
  throw new Error('자동 인식이 꺼져 있습니다.');
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
