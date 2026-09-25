// Resolves the typed 성경 구절 범위 into 개역개정 verses.
//
// The Wednesday service reads the same translation as the Sunday one, and the
// operator types only a range ("시18:1-12" or "시편 18편 1-12절"), so the
// whole job is parsing the reference and pulling the verses out of the
// translation file the Sunday flow already ships and caches.
import { getVerseUnits, lastVerseOf, loadTranslation } from '../bible/bibleData';
import { normalizeContiScripture, parseVerseInput } from '../bible/refParser';
import type { BibleRef, Verse } from '../bible/types';
import { formatRangeFromVerses } from './fields';

/** 개역개정. */
export const WEDNESDAY_TRANSLATION = 'nkrv';

export interface ResolvedPassage {
  refs: BibleRef[];
  verses: Verse[];
  /** The reference as the deck spells it, e.g. "시편 18편 1-12절". */
  rangeKo: string;
  /** Tokens that could not be read as a reference, for the input's hint line. */
  invalidTokens: string[];
}

export const EMPTY_PASSAGE: ResolvedPassage = { refs: [], verses: [], rangeKo: '', invalidTokens: [] };

/** Parse the input without loading the translation — used for the live hint. */
export function parsePassageInput(input: string): { refs: BibleRef[]; invalidTokens: string[] } {
  const text = input.trim();
  if (!text) return { refs: [], invalidTokens: [] };
  return parseVerseInput(normalizeContiScripture(text));
}

/** Parse the range and read its verses. Throws with a Korean message. */
export async function resolvePassage(input: string, baseUrl: string): Promise<ResolvedPassage> {
  const { refs, invalidTokens } = parsePassageInput(input);
  if (refs.length === 0) return { ...EMPTY_PASSAGE, invalidTokens };

  const bible = await loadTranslation(baseUrl, WEDNESDAY_TRANSLATION);
  const verses: Verse[] = [];
  for (const ref of refs) {
    verses.push(
      ...getVerseUnits(bible, ref.bookId, ref.startChapter, ref.startVerse, ref.endChapter, ref.endVerse),
    );
  }
  if (verses.length === 0) throw new Error('해당 구절을 찾을 수 없습니다.');

  return { refs, verses, rangeKo: formatRangeFromVerses(refs, verses), invalidTokens };
}

/** How many verse numbers the passage covers — a joined "18-19" counts as two. */
export function countVerses(verses: Verse[]): number {
  return verses.reduce((count, verse) => count + lastVerseOf(verse) - verse.verse + 1, 0);
}
