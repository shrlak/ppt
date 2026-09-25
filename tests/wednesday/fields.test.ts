import { describe, expect, it } from 'vitest';
import {
  chapterUnit,
  clearRemainingTokens,
  formatDateDot,
  formatDateKo,
  formatRangeFromVerses,
  formatRangeKoLong,
  substituteTokens,
  suggestWednesdayFileName,
  wednesdayOnOrAfter,
} from '../../src/wednesday/fields';
import type { BibleRef, Verse } from '../../src/bible/types';

const psalms: BibleRef = {
  bookId: 19,
  ko: '시편',
  en: 'Psalms',
  startChapter: 18,
  startVerse: 1,
  endChapter: 18,
  endVerse: 12,
};
const romans: BibleRef = {
  bookId: 45,
  ko: '로마서',
  en: 'Romans',
  startChapter: 5,
  startVerse: 1,
  endChapter: 5,
  endVerse: 11,
};

const verse = (chapter: number, number: number, text = '본문'): Verse => ({
  chapter,
  verse: number,
  text,
});

describe('service date', () => {
  it('spells the date the way each slide does', () => {
    expect(formatDateKo('2026-09-16')).toBe('2026년 9월 16일');
    expect(formatDateDot('2026-09-16')).toBe('2026. 9. 16');
  });

  it('reads the date as a local day, not a UTC instant', () => {
    // A naive new Date('2026-01-01') is midnight UTC, which is the previous
    // day west of Greenwich — the church's own timezone.
    expect(formatDateKo('2026-01-01')).toBe('2026년 1월 1일');
    expect(formatDateDot('2026-12-31')).toBe('2026. 12. 31');
  });

  it('gives nothing for an unusable date', () => {
    expect(formatDateKo('')).toBe('');
    expect(formatDateKo('2026-02-31')).toBe('');
    expect(formatDateDot('9/16/2026')).toBe('');
  });
});

describe('suggestWednesdayFileName', () => {
  it('names the file after that week\'s Wednesday', () => {
    // 2026-09-16 is itself a Wednesday.
    expect(suggestWednesdayFileName('2026-09-16')).toBe('0916.pptx');
    // Monday and Tuesday snap forward to the coming Wednesday.
    expect(suggestWednesdayFileName('2026-09-14')).toBe('0916.pptx');
    expect(suggestWednesdayFileName('2026-09-15')).toBe('0916.pptx');
    // Thursday belongs to next week's Wednesday.
    expect(suggestWednesdayFileName('2026-09-17')).toBe('0923.pptx');
  });

  it('falls back to the next Wednesday from today', () => {
    expect(suggestWednesdayFileName(undefined, new Date(2026, 8, 17))).toBe('0923.pptx');
    expect(suggestWednesdayFileName('', new Date(2026, 8, 16))).toBe('0916.pptx');
  });

  it('pads single-digit months and days', () => {
    expect(suggestWednesdayFileName('2027-01-06')).toBe('0106.pptx');
  });

  it('keeps a Wednesday as itself', () => {
    const wednesday = wednesdayOnOrAfter(new Date(2026, 8, 16));
    expect(wednesday.getDay()).toBe(3);
    expect(wednesday.getDate()).toBe(16);
  });
});

describe('formatRangeKoLong', () => {
  it('counts 시편 in 편 and every other book in 장', () => {
    expect(chapterUnit(19)).toBe('편');
    expect(chapterUnit(45)).toBe('장');
    expect(formatRangeKoLong(psalms, verse(18, 1), verse(18, 12))).toBe('시편 18편 1-12절');
    expect(formatRangeKoLong(romans, verse(5, 1), verse(5, 11))).toBe('로마서 5장 1-11절');
  });

  it('writes one verse without a range', () => {
    expect(formatRangeKoLong(romans, verse(5, 8), verse(5, 8))).toBe('로마서 5장 8절');
  });

  it('spans chapters when the passage does', () => {
    expect(formatRangeKoLong(psalms, verse(18, 10), verse(19, 2))).toBe('시편 18편 10절-19편 2절');
  });

  it('takes the whole passage\'s ends from the verses it resolved', () => {
    const verses = [verse(18, 1), verse(18, 2), verse(18, 3)];
    expect(formatRangeFromVerses([psalms], verses)).toBe('시편 18편 1-3절');
    expect(formatRangeFromVerses([], verses)).toBe('');
    expect(formatRangeFromVerses([psalms], [])).toBe('');
  });

  it('ends at the last verse a joined verse covers', () => {
    const joined: Verse = { ...verse(92, 1), endVerse: 3 };
    expect(formatRangeKoLong(psalms, joined, joined)).toBe('시편 92편 1-3절');
    expect(formatRangeKoLong(psalms, verse(92, 4), { ...verse(92, 5), endVerse: 6 })).toBe('시편 92편 4-6절');
  });
});

describe('substituteTokens', () => {
  it('fills the placeholders it is given and leaves the rest', () => {
    const xml = '<a:t>{{DATE_KO}}</a:t><a:t>{{SERMON_TITLE}}</a:t>';
    expect(substituteTokens(xml, { DATE_KO: '2026년 9월 16일' })).toBe(
      '<a:t>2026년 9월 16일</a:t><a:t>{{SERMON_TITLE}}</a:t>',
    );
  });

  it('escapes what it writes', () => {
    expect(substituteTokens('<a:t>{{SERMON_TITLE}}</a:t>', { SERMON_TITLE: '믿음 & <사랑>' })).toBe(
      '<a:t>믿음 &amp; &lt;사랑&gt;</a:t>',
    );
  });

  it('treats replacement patterns in a title as text', () => {
    // A string replacement would expand $& into the token it matched and $`
    // into everything before it. The & is then escaped as ordinary text.
    expect(substituteTokens('<a:t>{{SERMON_TITLE}}</a:t>', { SERMON_TITLE: '$& $` 은혜' })).toBe(
      '<a:t>$&amp; $` 은혜</a:t>',
    );
  });

  it('clears a placeholder whose value is empty, and any left over', () => {
    expect(substituteTokens('<a:t>{{PREACHER}}</a:t>', { PREACHER: '' })).toBe('<a:t></a:t>');
    expect(clearRemainingTokens('<a:t>{{RANGE_KO}}</a:t>')).toBe('<a:t></a:t>');
  });
});
