// Parses free-text verse references like "행1:8-10 요3:16 롬8:28" into
// structured BibleRef entries. Ported from kccp-bible-slide's
// src/app/api/generate/route.ts (parseInput), adapted to be reusable
// for both the live preview and the actual generation request.
import { findBookByAbbr, SORTED_ABBRS } from './books';
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

/** Human-readable display of a ref for the live preview list, e.g. "로마서 8:28". */
export function displayRef(token: string): string {
  const split = splitBookToken(token);
  if (!split) return `"${token}" 알 수 없음`;
  const book = findBookByAbbr(split.abbr);
  if (!book) return `"${token}" 알 수 없음`;
  return `${book.nameKo} ${split.rest}`.trim();
}
