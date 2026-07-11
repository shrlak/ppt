// Parses free-text verse references like "행1:8-10 요3:16 롬8:28" into
// structured BibleRef entries. Ported from kccp-bible-slide's
// src/app/api/generate/route.ts (parseInput), adapted to be reusable
// for both the live preview and the actual generation request.
import { BIBLE_BOOKS, findBookByAbbr, SORTED_ABBRS } from './books';
import type { BibleRef } from './types';

/** Splits a token into its leading book abbreviation and the rest, e.g. "삼상1:1" -> ["삼상","1:1"]. */
function splitBookToken(token: string): { abbr: string; rest: string } | null {
  for (const abbr of SORTED_ABBRS) {
    if (token.startsWith(abbr)) return { abbr, rest: token.slice(abbr.length).trim() };
  }
  return null;
}

function parseChapterVerse(s: string): [number, number | undefined] {
  const parts = s.split(':');
  return [parseInt(parts[0], 10), parts[1] ? parseInt(parts[1], 10) : undefined];
}

export interface ParsedToken {
  token: string;
  ref: BibleRef | null;
}

/** Parse one whitespace-separated token, e.g. "행1:8-10". Returns null if unrecognized. */
export function parseRefToken(token: string): BibleRef | null {
  const split = splitBookToken(token);
  if (!split) return null;
  const book = findBookByAbbr(split.abbr);
  if (!book) return null;
  const rest = split.rest;

  if (!rest) {
    return { bookId: book.id, ko: book.nameKo, en: book.nameEn, startChapter: 1, endChapter: book.chapters };
  }

  const parts = rest.split('-');
  if (parts.length === 1) {
    const [ch, v] = parseChapterVerse(parts[0]);
    return {
      bookId: book.id,
      ko: book.nameKo,
      en: book.nameEn,
      startChapter: ch,
      startVerse: v,
      endChapter: ch,
      endVerse: v,
    };
  }

  const [startChapter, startVerse] = parseChapterVerse(parts[0]);
  if (parts[1].includes(':')) {
    const [endChapter, endVerse] = parseChapterVerse(parts[1]);
    return { bookId: book.id, ko: book.nameKo, en: book.nameEn, startChapter, startVerse, endChapter, endVerse };
  }
  const n = parseInt(parts[1], 10);
  return startVerse !== undefined
    ? { bookId: book.id, ko: book.nameKo, en: book.nameEn, startChapter, startVerse, endChapter: startChapter, endVerse: n }
    : { bookId: book.id, ko: book.nameKo, en: book.nameEn, startChapter, endChapter: n };
}

/** Parse a whole input string into refs + the raw tokens that failed to parse. */
export function parseVerseInput(input: string): { refs: BibleRef[]; invalidTokens: string[] } {
  const refs: BibleRef[] = [];
  const invalidTokens: string[] = [];
  for (const token of input.trim().split(/\s+/).filter(Boolean)) {
    const ref = parseRefToken(token);
    if (ref) refs.push(ref);
    else invalidTokens.push(token);
  }
  return { refs, invalidTokens };
}

/**
 * Convert the human-readable scripture style used on a worship conti cover
 * into the compact tokens accepted by parseVerseInput.
 *
 * Examples:
 *   로마서 5장 1-11절 -> 롬5:1-11
 *   시편 13편 1-6절   -> 시13:1-6
 *   요한복음 20장 21절 -> 요20:21
 */
export function normalizeContiScripture(input: string): string {
  let value = input
    .replace(/^\s*본문\s*[:：]\s*/, '')
    .replace(/[–—~〜]/g, '-')
    .replace(/[，,;；]+/g, ' ')
    .trim();

  const books = [...BIBLE_BOOKS].sort((a, b) => b.nameKo.length - a.nameKo.length);
  for (const book of books) {
    const abbr = book.abbrKo[0];
    value = value.replaceAll(book.nameKo, abbr);
  }

  value = value
    // Cross-chapter range: 롬8장 28절-9장 1절
    .replace(/(\d+)\s*[장편]\s*(\d+)\s*절?\s*-\s*(\d+)\s*[장편]\s*(\d+)\s*절?/g, '$1:$2-$3:$4')
    // Same-chapter verse range: 롬8장 28-30절
    .replace(/(\d+)\s*[장편]\s*(\d+)\s*절?\s*-\s*(\d+)\s*절?/g, '$1:$2-$3')
    // One verse: 요3장 16절
    .replace(/(\d+)\s*[장편]\s*(\d+)\s*절/g, '$1:$2')
    // Whole chapter range: 시23-24편
    .replace(/(\d+)\s*-\s*(\d+)\s*[장편]/g, '$1-$2')
    // One whole chapter: 시23편
    .replace(/(\d+)\s*[장편]/g, '$1')
    .replace(/절/g, '')
    .replace(/\s*:\s*/g, ':')
    .replace(/\s*-\s*/g, '-')
    .replace(/([가-힣]+)\s+(?=\d)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();

  return value;
}

/** Human-readable display of a ref for the live preview list, e.g. "로마서 8:28". */
export function displayRef(token: string): string {
  const split = splitBookToken(token);
  if (!split) return `"${token}" 알 수 없음`;
  const book = findBookByAbbr(split.abbr);
  if (!book) return `"${token}" 알 수 없음`;
  return `${book.nameKo} ${split.rest}`.trim();
}
