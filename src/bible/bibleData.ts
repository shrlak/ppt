// Lazily fetches and caches whole-Bible translation JSON from public/bible-text/.
// Each file is ~4-5MB, so translations are only fetched once actually selected.
import type { BookChapters, Verse } from './types';

const TRANSLATION_FILES: Record<string, string> = {
  nkrv: 'ko_nkrv.json',
  ko: 'ko_ko.json',
  saenew: 'ko_saenew.json',
  esv: 'en_esv.json',
  niv: 'en_niv.json',
  kjv: 'en_kjv.json',
};

interface RawBook {
  chapters: BookChapters;
}

const cache = new Map<string, Map<number, BookChapters>>();
const inflight = new Map<string, Promise<Map<number, BookChapters>>>();

export function isKnownTranslation(id: string): boolean {
  return id in TRANSLATION_FILES;
}

/** Load one translation (bookId 1-based -> chapters), fetched once and cached in memory. */
export async function loadTranslation(baseUrl: string, id: string): Promise<Map<number, BookChapters>> {
  if (cache.has(id)) return cache.get(id)!;
  if (inflight.has(id)) return inflight.get(id)!;

  const file = TRANSLATION_FILES[id];
  if (!file) throw new Error(`지원하지 않는 번역본입니다: ${id}`);

  const promise = fetch(`${baseUrl}bible-text/${file}`)
    .then((res) => {
      if (!res.ok) throw new Error(`번역본을 불러오지 못했습니다: ${id}`);
      return res.json() as Promise<RawBook[]>;
    })
    .then((raw) => {
      const map = new Map<number, BookChapters>();
      raw.forEach((book, i) => map.set(i + 1, book.chapters));
      cache.set(id, map);
      inflight.delete(id);
      return map;
    })
    .catch((err) => {
      inflight.delete(id);
      throw err;
    });

  inflight.set(id, promise);
  return promise;
}

/** Extract verses [startChapter:startVerse, endChapter:endVerse] (verse bounds optional = whole chapter). */
export function getVerseRange(
  bible: Map<number, BookChapters>,
  bookId: number,
  startChapter: number,
  startVerse: number | undefined,
  endChapter: number,
  endVerse: number | undefined,
): Verse[] {
  const out: Verse[] = [];
  for (let ch = startChapter; ch <= endChapter; ch++) {
    const verses = bible.get(bookId)?.[ch - 1];
    if (!verses) continue;
    for (let i = 0; i < verses.length; i++) {
      const vn = i + 1;
      if (ch === startChapter && startVerse && vn < startVerse) continue;
      if (ch === endChapter && endVerse && vn > endVerse) continue;
      out.push({ chapter: ch, verse: vn, text: verses[i].trim() });
    }
  }
  return out;
}
