// The 설교말씀 of a 수련회 session: the typed range read in 개역개정 and ESV,
// verse by verse, spelled the way the retreat decks print it —
// "마태복음 14장 22-33절" over "Matthew 14:22-33".
import { getVerseRange } from '../bible/bibleData';
import type { BibleRef, BookChapters, Verse } from '../bible/types';
import { formatRangeFromVerses } from '../wednesday/fields';
import { parsePassageInput } from '../wednesday/passage';

export const RETREAT_TRANSLATIONS = { ko: 'nkrv', en: 'esv' } as const;

export interface RetreatVerse {
  chapter: number;
  verse: number;
  ko: string;
  en: string;
}

export interface RetreatPassage {
  passageKo: string;
  passageEn: string;
  verses: RetreatVerse[];
}

type Bible = Map<number, BookChapters>;
export type BibleLoader = (translation: string) => Promise<Bible>;

/** "Matthew 14:22-33", or "Matthew 14:22-15:3" across chapters. */
export function formatRangeEn(ref: BibleRef, first: Verse, last: Verse): string {
  if (first.chapter !== last.chapter) return `${ref.en} ${first.chapter}:${first.verse}-${last.chapter}:${last.verse}`;
  if (first.verse === last.verse) return `${ref.en} ${first.chapter}:${first.verse}`;
  return `${ref.en} ${first.chapter}:${first.verse}-${last.verse}`;
}

/** Read a typed range ("마14:22-33", "마태복음 14장 22-33절"). Throws in Korean. */
export async function resolveRetreatPassage(input: string, load: BibleLoader): Promise<RetreatPassage | null> {
  const { refs } = parsePassageInput(input);
  if (refs.length === 0) return null;
  const [ko, en] = await Promise.all([load(RETREAT_TRANSLATIONS.ko), load(RETREAT_TRANSLATIONS.en)]);
  const verses: RetreatVerse[] = [];
  const koVerses: Verse[] = [];
  for (const ref of refs) {
    const koRange = getVerseRange(ko, ref.bookId, ref.startChapter, ref.startVerse, ref.endChapter, ref.endVerse);
    const enRange = getVerseRange(en, ref.bookId, ref.startChapter, ref.startVerse, ref.endChapter, ref.endVerse);
    koVerses.push(...koRange);
    for (const verse of koRange) {
      const match = enRange.find((candidate) => candidate.chapter === verse.chapter && candidate.verse === verse.verse);
      verses.push({ chapter: verse.chapter, verse: verse.verse, ko: verse.text, en: match?.text ?? '' });
    }
  }
  if (verses.length === 0) throw new Error('해당 구절을 찾을 수 없습니다.');
  return {
    passageKo: formatRangeFromVerses(refs, koVerses),
    passageEn: formatRangeEn(refs[0], koVerses[0], koVerses[koVerses.length - 1]),
    verses,
  };
}
