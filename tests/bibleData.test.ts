import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getVerseRange, getVerseUnits, isKnownTranslation, lastVerseOf, loadTranslation } from '../src/bible/bibleData';
import { BIBLE_BOOKS, TRANSLATIONS } from '../src/bible/books';
import type { BookChapters } from '../src/bible/types';

function readTranslation(file: string): { chapters: BookChapters }[] {
  return JSON.parse(readFileSync(new URL(`../public/bible-text/${file}`, import.meta.url), 'utf-8'));
}

const nasbRaw = readTranslation('en_nasb.json');

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('NASB translation', () => {
  it('is offered as an English translation the loader knows', () => {
    expect(TRANSLATIONS.find((t) => t.id === 'nasb')).toEqual({ id: 'nasb', name: 'NASB', language: 'en' });
    expect(isKnownTranslation('nasb')).toBe(true);
  });

  it('fetches en_nasb.json and indexes books from 1', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(nasbRaw)));
    vi.stubGlobal('fetch', fetchMock);

    const bible = await loadTranslation('/ppt/', 'nasb');

    expect(fetchMock).toHaveBeenCalledWith('/ppt/bible-text/en_nasb.json');
    expect(getVerseRange(bible, 43, 3, 16, 3, 16)[0].text).toMatch(/^“For God so loved the world/);
  });

  it('has every book and chapter of the 66-book canon', () => {
    expect(nasbRaw).toHaveLength(BIBLE_BOOKS.length);
    BIBLE_BOOKS.forEach((book, i) => expect(nasbRaw[i].chapters, book.nameEn).toHaveLength(book.chapters));
  });

  it('keeps verses the NASB omits as empty slots so later verse numbers stay put', () => {
    const matthew17 = nasbRaw[39].chapters[16];
    expect(matthew17).toHaveLength(27);
    expect(matthew17[20]).toBe(''); // 17:21
    expect(matthew17[21]).toMatch(/^And while they were gathering together in Galilee/); // 17:22
  });

  it('joins poetry lines into one line of text', () => {
    const psalm23 = nasbRaw[18].chapters[22];
    expect(psalm23[0]).toBe('The Lord is my shepherd, I will not be in need.');
    expect(nasbRaw.every((b) => b.chapters.every((ch) => ch.every((v) => !/\s{2}|\n/.test(v))))).toBe(true);
  });
});

describe.each([
  ['ESV', 'en_esv.json', /^As they were gathering in Galilee/],
  ['NIV', 'en_niv.json', /^When they came together in Galilee/],
])('%s verse numbering', (_name, file, matthew17v22) => {
  const raw = readTranslation(file);

  it('has the same verse slots as the NASB in every chapter', () => {
    raw.forEach((book, i) =>
      book.chapters.forEach((chapter, c) =>
        expect(chapter, `${BIBLE_BOOKS[i].nameEn} ${c + 1}`).toHaveLength(nasbRaw[i].chapters[c].length),
      ),
    );
  });

  it('keeps an omitted verse as an empty slot so the next verse keeps its number', () => {
    const bible = new Map(raw.map((book, i) => [i + 1, book.chapters]));
    const [v21, v22] = getVerseRange(bible, 40, 17, 21, 17, 22);
    expect(v21).toEqual({ chapter: 17, verse: 21, text: '' });
    expect(v22.text).toMatch(matthew17v22);
  });
});

it('uses the NIV 2011 text, with no section headings run into the verses', () => {
  const niv = readTranslation('en_niv.json');
  expect(niv[0].chapters[0][0]).toBe('In the beginning God created the heavens and the earth.');
  expect(niv[0].chapters[5][0]).toMatch(/^When human beings began to increase in number/);
  const glued = niv.flatMap((b) => b.chapters.flat()).filter((v) => /[a-z][A-Z][a-z]|[A-Za-z][.,:;!?][A-Za-z“‘]/.test(v));
  expect(glued).toEqual([]);
});

describe('getVerseUnits', () => {
  // 신명기 6장 as 개역개정 prints it: 16, 17, then 18-19 as one verse, then 20.
  const deuteronomy6 = Array.from({ length: 25 }, (_, i) => `v${i + 1}`);
  deuteronomy6[17] = 'v18-19';
  deuteronomy6[18] = '';
  const korean = new Map<number, BookChapters>([[5, [[], [], [], [], [], deuteronomy6]]]);

  it('returns a joined verse once, covering both numbers', () => {
    expect(getVerseUnits(korean, 5, 6, 16, 6, 20)).toEqual([
      { chapter: 6, verse: 16, text: 'v16' },
      { chapter: 6, verse: 17, text: 'v17' },
      { chapter: 6, verse: 18, text: 'v18-19', endVerse: 19 },
      { chapter: 6, verse: 20, text: 'v20' },
    ]);
  });

  it('widens a range that starts or ends inside a joined verse to the whole verse', () => {
    expect(getVerseUnits(korean, 5, 6, 19, 6, 20).map((v) => [v.verse, lastVerseOf(v)])).toEqual([
      [18, 19],
      [20, 20],
    ]);
    expect(getVerseUnits(korean, 5, 6, 17, 6, 18).map((v) => [v.verse, lastVerseOf(v)])).toEqual([
      [17, 17],
      [18, 19],
    ]);
  });

  it('leaves getVerseRange reading every slot, so English omitted verses stay their own', () => {
    expect(getVerseRange(korean, 5, 6, 18, 6, 19).map((v) => v.text)).toEqual(['v18-19', '']);
  });
});
