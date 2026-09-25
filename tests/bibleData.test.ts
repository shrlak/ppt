import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getVerseRange, isKnownTranslation, loadTranslation } from '../src/bible/bibleData';
import { BIBLE_BOOKS, TRANSLATIONS } from '../src/bible/books';
import type { BookChapters } from '../src/bible/types';

const nasbRaw = JSON.parse(
  readFileSync(new URL('../public/bible-text/en_nasb.json', import.meta.url), 'utf-8'),
) as { chapters: BookChapters }[];

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
