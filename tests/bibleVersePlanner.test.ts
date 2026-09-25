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

  it('defaults body2/body3 to empty string when only one translation is selected', () => {
    const bibles = new Map([['nkrv', johnBook(KO_VERSES)]]);
    const plan = buildVerseSlidePlan([ref], ['nkrv'], bibles, '', 4);
    expect(plan.verseSlides[0].body2).toBe('');
    expect(plan.verseSlides[0].body3).toBe('');
  });

  describe('a Korean verse printed together with the next one', () => {
    // 개역개정 신6:18-19 is one verse; the file keeps its text at 18 and an empty slot at 19.
    const deuteronomy = (texts: string[]) =>
      new Map<number, BookChapters>([[5, [[], [], [], [], [], [...Array(16).fill('(unused)'), ...texts]]]]);
    const deutRef: BibleRef = { bookId: 5, ko: '신명기', en: 'Deuteronomy', startChapter: 6, startVerse: 17, endChapter: 6, endVerse: 20 };
    const bibles = new Map([
      ['nkrv', deuteronomy(['k17', 'k18-19', '', 'k20'])],
      ['esv', deuteronomy(['e17', 'e18', 'e19', 'e20'])],
    ]);

    it('gets one slide labelled 18-19 with both English verses', () => {
      const plan = buildVerseSlidePlan([deutRef], ['nkrv', 'esv'], bibles, '', 1);
      expect(plan.verseSlides.map((s) => [s.verse, s.body, s.body2])).toEqual([
        ['17', 'k17', 'e17'],
        ['18-19', 'k18-19', 'e18 e19'],
        ['20', 'k20', 'e20'],
      ]);
    });

    it('counts as one verse toward versesPerSlide and is never split', () => {
      const plan = buildVerseSlidePlan([deutRef], ['nkrv', 'esv'], bibles, '', 2);
      expect(plan.verseSlides.map((s) => [s.verse, s.body2])).toEqual([
        ['17-19', 'e17 e18 e19'],
        ['20', 'e20'],
      ]);
    });

    it('widens a range that ends inside it to the whole verse', () => {
      const plan = buildVerseSlidePlan([{ ...deutRef, endVerse: 18 }], ['nkrv', 'esv'], bibles, '', 1);
      expect(plan.globalData.rangeKo).toBe('신명기 6:17-19');
      expect(plan.verseSlides.at(-1)?.body2).toBe('e18 e19');
    });
  });

  it('skips an English verse the translation leaves out instead of leaving a double space', () => {
    const bibles = new Map([
      ['nkrv', johnBook(KO_VERSES)],
      ['esv', johnBook(['v14-en', '', 'v16-en', 'v17-en'])],
    ]);
    const plan = buildVerseSlidePlan([ref], ['nkrv', 'esv'], bibles, '', 4);
    expect(plan.verseSlides[0].body2).toBe('v14-en v16-en v17-en');
  });

  it('throws when no refs are given', () => {
    expect(() => buildVerseSlidePlan([], ['nkrv'], new Map(), '', 1)).toThrow();
  });

  it('throws when the primary translation has no matching verses', () => {
    const bibles = new Map([['nkrv', new Map<number, BookChapters>()]]);
    expect(() => buildVerseSlidePlan([ref], ['nkrv'], bibles, '', 1)).toThrow();
  });
});
