// The 찬양집회 영어 가사 library: for each bilingual song, the Korean slides
// and the English printed under each of them (see src/praise/englishLibrary.ts).
//
// A song database, like the lyrics library — it lives outside
// `library:ppt:*`, so the weekly PPT purge never touches it.
import { normalizeLibraryTitle } from './library.js';

export const MAX_PRAISE_ENGLISH_ENTRIES = 2000;
const MAX_SLIDES = 200;
const MAX_LINES = 40;

function lines(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((line) => typeof line === 'string')
    .map((line) => line.trim().slice(0, 300))
    .filter(Boolean)
    .slice(0, MAX_LINES);
}

export function sanitizePraiseEnglishEntry(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const title = typeof raw.title === 'string' ? raw.title.trim().slice(0, 200) : '';
  if (!title || !normalizeLibraryTitle(title)) return null;
  const englishTitle = typeof raw.englishTitle === 'string' ? raw.englishTitle.trim().slice(0, 200) : '';
  const slides = (Array.isArray(raw.slides) ? raw.slides : []).slice(0, MAX_SLIDES).flatMap((slide) => {
    if (!slide || typeof slide !== 'object') return [];
    const entry = { ko: lines(slide.ko), en: lines(slide.en) };
    return entry.ko.length > 0 || entry.en.length > 0 ? [entry] : [];
  });
  const updatedAt = typeof raw.updatedAt === 'string' ? raw.updatedAt.slice(0, 40) : '';
  return {
    title,
    englishTitle,
    slides,
    updatedAt: Number.isFinite(Date.parse(updatedAt)) ? updatedAt : new Date().toISOString(),
  };
}

export function sanitizePraiseEnglishEntries(raw) {
  if (!Array.isArray(raw)) return [];
  const entries = [];
  for (const item of raw.slice(0, MAX_PRAISE_ENGLISH_ENTRIES)) {
    const entry = sanitizePraiseEnglishEntry(item);
    if (entry) entries.push(entry);
  }
  return entries;
}
