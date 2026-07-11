import { describe, expect, it } from 'vitest';
import { buildVerseSlidePlan } from '../src/bible/versePlanner';
import type { BibleRef, BookChapters } from '../src/bible/types';

// Small synthetic "translations" covering just John chapter 3, verses 14-17.
// getVerseRange indexes verses by (verseNumber - 1), so verses 1-13 are padded
// with placeholders to keep the real verses 14-17 at their correct offsets.
function johnBook(versesFrom14: string[]): Map<number, BookChapters> {
  const chapters: BookChapters = [];
  chapters[2] = [...Array(13).fill('(unused)'), ...versesFrom14]; // chapter 3 (0-indexed)
  const map = new Map<number, BookChapters>();
  map.set(43, chapters); // book id 43 = John
  return map;
}

const KO_VERSES = ['v14-ko', 'v15-ko', 'v16-ko', 'v17-ko'];
const EN_VERSES = ['v14-en', 'v15-en', 'v16-en', 'v17-en'];

const ref: BibleRef = {
  bookId: 43,
  ko: '요한복음',
  en: 'John',
  startChapter: 3,
  startVerse: 14,
  endChapter: 3,
  endVerse: 17,
};

describe('buildVerseSlidePlan', () => {
  it('builds one slide per verse by default (versesPerSlide=1)', () => {
    const bibles = new Map([['nkrv', johnBook(KO_VERSES)]]);
    const plan = buildVerseSlidePlan([ref], ['nkrv'], bibles, '', 1);
    expect(plan.verseSlides).toHaveLength(4);
    expect(plan.verseSlides[0].body).toBe('v14-ko');
    expect(plan.verseSlides[0].verse).toBe('14');
    expect(plan.globalData.rangeKo).toBe('요한복음 3:14-17');
  });

  it('groups multiple verses per slide', () => {
    const bibles = new Map([['nkrv', johnBook(KO_VERSES)]]);
    const plan = buildVerseSlidePlan([ref], ['nkrv'], bibles, '', 2);
    expect(plan.verseSlides).toHaveLength(2);
    expect(plan.verseSlides[0].body).toBe('v14-ko v15-ko');
    expect(plan.verseSlides[0].verse).toBe('14-15');
  });

  it('includes a second translation as body2', () => {
    const bibles = new Map([
      ['nkrv', johnBook(KO_VERSES)],
      ['esv', johnBook(EN_VERSES)],
    ]);
    const plan = buildVerseSlidePlan([ref], ['nkrv', 'esv'], bibles, '', 4);
    expect(plan.verseSlides).toHaveLength(1);
    expect(plan.verseSlides[0].body).toBe('v14-ko v15-ko v16-ko v17-ko');
    expect(plan.verseSlides[0].body2).toBe('v14-en v15-en v16-en v17-en');
  });

  it('carries the sermon title into globalData', () => {
    const bibles = new Map([['nkrv', johnBook(KO_VERSES)]]);
    const plan = buildVerseSlidePlan([ref], ['nkrv'], bibles, '하나님의 사랑', 4);
    expect(plan.globalData.sermonTitle).toBe('하나님의 사랑');
  });

  it('formats a single-verse range without a dash', () => {
    const singleRef: BibleRef = { ...ref, startVerse: 16, endVerse: 16, endChapter: 3 };
    const bibles = new Map([['nkrv', johnBook(KO_VERSES)]]);
    const plan = buildVerseSlidePlan([singleRef], ['nkrv'], bibles, '', 4);
    expect(plan.globalData.rangeKo).toBe('요한복음 3:16');
  });

  it('throws when no refs are given', () => {
    expect(() => buildVerseSlidePlan([], ['nkrv'], new Map(), '', 1)).toThrow();
  });

  it('throws when the primary translation has no matching verses', () => {
    const bibles = new Map([['nkrv', new Map<number, BookChapters>()]]);
    expect(() => buildVerseSlidePlan([ref], ['nkrv'], bibles, '', 1)).toThrow();
  });
});
