// The 찬양집회 영어 가사 library: every bilingual song this church has put on a
// praise-night screen, as the Korean slides and the English printed under
// each of them.
//
// It starts from last year's deck (public/praise-english.json, derived by
// scripts/prepare-praise-template.mjs) and grows every time a song's English
// is saved here, so a song sung once never needs its English typed again.
// Like the 찬양 라이브러리 it is a song database rather than one week's
// material, so the weekly PPT purge never touches it.
//
// Shaped after the 수요예배 song library: a local copy in localStorage, a
// durable queue for writes made offline, and a shared server copy that wins
// on sync.
import { cloudLibraryJson, hasCloudLibrary } from '../lib/storage/cloudLibrary';
import { normalizeTitle } from '../lib/storage/library';
import type { Song } from '../lib/utils/types';
import { isBilingualSheetSong, type ChordSheetSong, type SheetSlide } from '../lib/utils/chordSheet';
import { normalizeLyricLine, planPraiseSong, slideKey } from './planner';
import type { PraiseEnglish } from './types';

const STORAGE_KEY = 'praise-english-library';
const QUEUE_KEY = 'praise-english-library-sync-queue-v1';
const ROUTE = '/libraries/praise-english';
const MAX_SLIDES = 200;
const MAX_LINES = 40;

export interface EnglishSlide {
  /** Korean lines; empty for a song sung only in English. */
  ko: string[];
  /** English lines printed under them (or the lines themselves, for English-only). */
  en: string[];
}

export interface EnglishSongEntry {
  /** The Korean title — or the only title, for an English-only song. */
  title: string;
  englishTitle: string;
  slides: EnglishSlide[];
  updatedAt?: string;
}

export interface EnglishLibrarySyncResult {
  entries: EnglishSongEntry[];
  state: 'synced' | 'local' | 'error';
  message?: string;
}

function lines(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((line): line is string => typeof line === 'string')
    .map((line) => line.trim().slice(0, 300))
    .filter(Boolean)
    .slice(0, MAX_LINES);
}

export function sanitizeEnglishEntry(raw: unknown): EnglishSongEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>;
  const title = typeof value.title === 'string' ? value.title.trim().slice(0, 200) : '';
  if (!title || !normalizeTitle(title)) return null;
  const englishTitle = typeof value.englishTitle === 'string' ? value.englishTitle.trim().slice(0, 200) : '';
  const slides = (Array.isArray(value.slides) ? value.slides : [])
    .slice(0, MAX_SLIDES)
    .flatMap((slide) => {
      if (!slide || typeof slide !== 'object') return [];
      const { ko, en } = slide as Record<string, unknown>;
      const entry = { ko: lines(ko), en: lines(en) };
      return entry.ko.length > 0 || entry.en.length > 0 ? [entry] : [];
    });
  const entry: EnglishSongEntry = { title, englishTitle, slides };
  if (typeof value.updatedAt === 'string' && Number.isFinite(Date.parse(value.updatedAt))) {
    entry.updatedAt = value.updatedAt;
  }
  return entry;
}

export function sanitizeEnglishEntries(raw: unknown): EnglishSongEntry[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item) => sanitizeEnglishEntry(item) ?? []);
}

/** A song is looked up by either of its titles. */
export function findEnglishEntry(entries: EnglishSongEntry[], title: string): EnglishSongEntry | undefined {
  const key = normalizeTitle(title);
  if (!key) return undefined;
  return entries.find(
    (entry) => normalizeTitle(entry.title) === key || (entry.englishTitle && normalizeTitle(entry.englishTitle) === key),
  );
}

/** Replace-by-title; later entries (a user's save) win over earlier ones (the seed). */
export function upsertEnglishEntry(entries: EnglishSongEntry[], entry: EnglishSongEntry): EnglishSongEntry[] {
  const key = normalizeTitle(entry.title);
  return [...entries.filter((existing) => normalizeTitle(existing.title) !== key), entry].sort((a, b) =>
    a.title.localeCompare(b.title, 'ko'),
  );
}

/** Seed first, then this church's own saves on top (they win on the same title). */
export function mergeEnglishLibraries(seed: EnglishSongEntry[], saved: EnglishSongEntry[]): EnglishSongEntry[] {
  let merged = [...seed];
  for (const entry of saved) merged = upsertEnglishEntry(merged, entry);
  return merged;
}

// ---- matching English to this year's Korean slides ----------------------

interface LineCell {
  /** Normalized Korean of one saved line. */
  ko: string;
  /** The part of its slide's English this Korean line stands for. */
  en: string[];
  /** First line of its saved slide — runs that start and end on slide edges win ties. */
  slideStart: boolean;
  slideEnd: boolean;
}

/**
 * Flatten an entry into one run of Korean lines, each carrying its share of
 * its slide's English. A slide's English is divided across its Korean lines
 * in order — 2 Korean lines over 4 English lines give each Korean line two —
 * so a run covering whole slides returns exactly those slides' English, and a
 * run covering part of a slide returns the matching part of it.
 */
function cellsOf(entry: EnglishSongEntry): LineCell[] {
  const cells: LineCell[] = [];
  for (const slide of entry.slides) {
    const n = slide.ko.length;
    const m = slide.en.length;
    slide.ko.forEach((ko, index) => {
      const start = Math.round((index * m) / n);
      const end = Math.round(((index + 1) * m) / n);
      cells.push({
        ko: normalizeLyricLine(ko),
        en: slide.en.slice(start, end),
        slideStart: index === 0,
        slideEnd: index === n - 1,
      });
    });
  }
  return cells;
}

function bigrams(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (let index = 0; index + 1 < text.length; index++) {
    const pair = text.slice(index, index + 2);
    counts.set(pair, (counts.get(pair) ?? 0) + 1);
  }
  return counts;
}

/** Dice overlap (0–1) of two texts' character pairs. */
function textSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  const left = bigrams(a);
  const right = bigrams(b);
  let shared = 0;
  let total = 0;
  for (const [pair, count] of left) {
    shared += Math.min(count, right.get(pair) ?? 0);
    total += count;
  }
  for (const count of right.values()) total += count;
  return total === 0 ? 0 : (2 * shared) / total;
}

/** How alike two texts must be for a saved stretch of lyrics to stand for a slide. */
const MATCH_THRESHOLD = 0.72;

/**
 * The stretch of an entry's lyrics that best matches `wanted`, compared as
 * text rather than line by line: this year's lyrics often come from the 찬양
 * 라이브러리 or the 악보, which break lines differently from last year's
 * slides and may differ by a syllable here and there ("그려" / "그리어").
 */
function bestRun(cells: LineCell[], wanted: string, threshold: number): { start: number; end: number } | null {
  let best: { start: number; end: number; score: number } | null = null;
  for (let start = 0; start < cells.length; start++) {
    let text = '';
    for (let end = start + 1; end <= cells.length; end++) {
      text += cells[end - 1].ko;
      if (text.length > wanted.length * 2 + 4) break;
      if (text.length * 2 + 4 < wanted.length) continue;
      let score = textSimilarity(text, wanted);
      // Between equally good readings, prefer the one on slide boundaries.
      if (cells[start].slideStart) score += 0.001;
      if (cells[end - 1].slideEnd) score += 0.001;
      if (!best || score > best.score + 1e-9) best = { start, end, score };
    }
  }
  return best && best.score >= threshold ? best : null;
}

/**
 * The English for one Korean slide, read off a saved song, or null when no
 * stretch of that song's lyrics matches the slide closely enough.
 */
export function englishForSlide(
  koLines: string[],
  entry: EnglishSongEntry,
  threshold = MATCH_THRESHOLD,
): string[] | null {
  const wanted = koLines.map(normalizeLyricLine).join('');
  if (!wanted) return null;
  const cells = cellsOf(entry);
  const run = bestRun(cells, wanted, threshold);
  if (run) {
    const english = cells.slice(run.start, run.end).flatMap((cell) => cell.en);
    return english.length > 0 ? english : null;
  }
  // No one stretch matches — a chorus line sung twice on one slide, or two
  // parts that were apart last year. Each half may still match on its own.
  const lines = koLines.filter((line) => normalizeLyricLine(line));
  if (lines.length < 2) return null;
  const middle = Math.ceil(lines.length / 2);
  const first = englishForSlide(lines.slice(0, middle), entry, threshold);
  const second = first && englishForSlide(lines.slice(middle), entry, threshold);
  return first && second ? [...first, ...second] : null;
}

/**
 * Fill whatever English a song is still missing from the library, never
 * overwriting English already there. `filled` counts slides that gained
 * English, so the page can say what it did.
 */
export function fillEnglishFromLibrary(
  song: Song,
  english: PraiseEnglish,
  entries: EnglishSongEntry[],
): { english: PraiseEnglish; filled: number; titleFilled: boolean } {
  const own = findEnglishEntry(entries, song.title);
  const next: PraiseEnglish = { title: english.title, slides: { ...english.slides } };
  let titleFilled = false;
  if (!next.title.trim() && own?.englishTitle) {
    next.title = own.englishTitle;
    titleFilled = true;
  }
  const plan = planPraiseSong(song, { english: next });
  if (plan.englishOnly) return { english: next, filled: 0, titleFilled };

  let filled = 0;
  for (const slide of plan.slides) {
    if (slide.english.length > 0) continue;
    // The song's own entry first; a line shared with another song (a common
    // refrain) only counts when this song has no entry of its own.
    const found = own ? englishForSlide(slide.lines, own) : null;
    const fallback = found ?? (own ? null : firstMatch(slide.lines, entries));
    if (fallback) {
      next.slides[slide.key] = fallback;
      filled += 1;
    }
  }
  return { english: next, filled, titleFilled };
}

/** Borrowing from another song needs a longer slide and a closer match. */
const CROSS_SONG_THRESHOLD = 0.9;

function firstMatch(koLines: string[], entries: EnglishSongEntry[]): string[] | null {
  // A single short line matches too much to be trusted across songs.
  if (koLines.map(normalizeLyricLine).join('').length < 12) return null;
  for (const entry of entries) {
    const found = englishForSlide(koLines, entry, CROSS_SONG_THRESHOLD);
    if (found) return found;
  }
  return null;
}

/** What gets remembered: exactly the slides as they will be projected. */
export function entryFromSong(song: Song, english: PraiseEnglish): EnglishSongEntry {
  const plan = planPraiseSong(song, { english });
  return {
    title: song.title.trim(),
    englishTitle: plan.titleEn,
    slides: plan.slides.map((slide) =>
      plan.englishOnly ? { ko: [], en: slide.lines } : { ko: slide.lines, en: slide.english },
    ),
  };
}

/**
 * Turn a saved entry back into a song with its English — for a song whose
 * Korean could not be read, or one sung only in English. Each saved slide
 * becomes its own part, so the slides come back split exactly as saved.
 */
export function songFromEnglishEntry(
  entry: EnglishSongEntry,
  id: string = crypto.randomUUID(),
): { song: Song; english: PraiseEnglish } {
  const sections = entry.slides.map((slide, index) => ({
    label: String(index + 1),
    lines: slide.ko.length > 0 ? [...slide.ko] : [...slide.en],
  }));
  const longest = Math.max(2, ...sections.map((section) => section.lines.length));
  const slides: Record<string, string[]> = {};
  for (const slide of entry.slides) {
    if (slide.ko.length > 0 && slide.en.length > 0) slides[slideKey(slide.ko)] = [...slide.en];
  }
  return {
    song: {
      id,
      title: entry.title,
      sections,
      order: sections.map((section) => section.label),
      linesPerSlide: Math.min(6, longest),
      verification: 'verified',
    },
    english: { title: entry.englishTitle, slides },
  };
}

// ---- storage -------------------------------------------------------------

interface QueuedWrite {
  kind: 'upsert' | 'delete';
  title: string;
  entry?: EnglishSongEntry;
}

function readLocal(): EnglishSongEntry[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return sanitizeEnglishEntries(raw ? JSON.parse(raw) : []);
  } catch {
    return [];
  }
}

function writeLocal(entries: EnglishSongEntry[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  } catch {
    // A private window or a full quota still leaves the session usable.
  }
}

function readQueue(): QueuedWrite[] {
  try {
    const raw = localStorage.getItem(QUEUE_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(parsed) ? (parsed as QueuedWrite[]) : [];
  } catch {
    return [];
  }
}

function writeQueue(queue: QueuedWrite[]): void {
  try {
    localStorage.setItem(QUEUE_KEY, JSON.stringify(queue));
  } catch {
    // The local list is still correct.
  }
}

function queueWrite(write: QueuedWrite): void {
  const key = normalizeTitle(write.title);
  writeQueue([...readQueue().filter((queued) => normalizeTitle(queued.title) !== key), write]);
}

/** The songs saved on this device (not including the bundled seed). */
export function loadSavedEnglish(): EnglishSongEntry[] {
  return readLocal();
}

/** The bundled seed from last year's deck. */
export async function fetchSeedEnglish(baseUrl: string): Promise<EnglishSongEntry[]> {
  try {
    const response = await fetch(`${baseUrl}praise-english.json`);
    if (!response.ok) return [];
    return sanitizeEnglishEntries(await response.json());
  } catch {
    return [];
  }
}

export async function saveEnglishEntry(entry: EnglishSongEntry): Promise<EnglishSongEntry[]> {
  const checked = sanitizeEnglishEntry(entry);
  if (!checked) return readLocal();
  const stored = { ...checked, updatedAt: new Date().toISOString() };
  const entries = upsertEnglishEntry(readLocal(), stored);
  writeLocal(entries);
  if (hasCloudLibrary()) {
    try {
      await cloudLibraryJson(ROUTE, { method: 'PUT', body: JSON.stringify({ entry: stored }) }, true);
    } catch {
      queueWrite({ kind: 'upsert', title: stored.title, entry: stored });
    }
  }
  return entries;
}

async function flushQueue(): Promise<void> {
  const queue = readQueue();
  if (queue.length === 0) return;
  const remaining: QueuedWrite[] = [];
  for (const write of queue) {
    try {
      if (write.kind === 'delete') {
        await cloudLibraryJson(ROUTE, { method: 'DELETE', body: JSON.stringify({ title: write.title }) }, true);
      } else if (write.entry) {
        await cloudLibraryJson(ROUTE, { method: 'PUT', body: JSON.stringify({ entry: write.entry }) }, true);
      }
    } catch {
      remaining.push(write);
    }
  }
  writeQueue(remaining);
}

/** Bring the local copy in line with the server's; the server wins. */
export async function synchronizeEnglishLibrary(): Promise<EnglishLibrarySyncResult> {
  const local = readLocal();
  if (!hasCloudLibrary()) return { entries: local, state: 'local' };
  try {
    if (local.length > 0) {
      await cloudLibraryJson(ROUTE, { method: 'POST', body: JSON.stringify({ entries: local }) }, true);
    }
    await flushQueue();
    const snapshot = await cloudLibraryJson<{ entries?: unknown[]; deletedTitles?: unknown[] }>(ROUTE);
    const deleted = new Set(
      (snapshot.deletedTitles ?? []).filter((title): title is string => typeof title === 'string'),
    );
    const entries = sanitizeEnglishEntries(snapshot.entries ?? [])
      .filter((entry) => !deleted.has(normalizeTitle(entry.title)))
      .sort((a, b) => a.title.localeCompare(b.title, 'ko'));
    writeLocal(entries);
    return { entries, state: 'synced' };
  } catch (error) {
    return { entries: local, state: 'error', message: error instanceof Error ? error.message : String(error) };
  }
}

// ---- chord-sheet 콘티 ---------------------------------------------------------

/** How alike two titles must be to name the same song ("Savior" / "Saviour"). */
const TITLE_MATCH = 0.85;

/**
 * The saved song a chord-sheet song is, if any: by either of its titles, by a
 * title spelled a little differently, or — for a sheet that names the song
 * only in English — by its Korean lyrics.
 */
export function findEntryForSheet(entries: EnglishSongEntry[], sheet: ChordSheetSong): EnglishSongEntry | undefined {
  for (const title of [sheet.title, sheet.altTitle ?? '']) {
    const found = title ? findEnglishEntry(entries, title) : undefined;
    if (found) return found;
  }
  const wanted = normalizeTitle(sheet.title);
  if (wanted.length >= 4) {
    // "나의 슬픔을" last year, "나의 슬픔을 주가 기쁨으로" on this sheet.
    const close = entries.find((entry) =>
      [entry.title, entry.englishTitle].some((title) => {
        const known = title ? normalizeTitle(title) : '';
        if (known.length < 4) return false;
        return known.startsWith(wanted) || wanted.startsWith(known) || textSimilarity(known, wanted) >= TITLE_MATCH;
      }),
    );
    if (close) return close;
  }
  // The same Korean lyrics, however the lines are broken: most of the sheet's
  // parts read as a stretch of the saved song.
  const parts = sheet.parts.map((part) => part.ko.map(normalizeLyricLine).join('')).filter((text) => text.length >= 6);
  if (parts.length === 0) return undefined;
  return entries.find((entry) => {
    const cells = cellsOf(entry);
    if (cells.length === 0) return false;
    const matched = parts.filter((text) => bestRun(cells, text, MATCH_THRESHOLD));
    return matched.length * 2 >= parts.length;
  });
}

/**
 * The two titles a chord-sheet song goes by on the 찬양집회 deck. A sheet
 * titled in Korean keeps that title and borrows the English one it was sung
 * under before; a bilingual song the sheet titles in English ("Goodness Of
 * God") takes the Korean title it was saved under, with the sheet's title as
 * its English one.
 */
export function sheetTitles(sheet: ChordSheetSong, entries: EnglishSongEntry[]): { title: string; englishTitle: string } {
  const entry = findEntryForSheet(entries, sheet);
  if (/[가-힣]/.test(sheet.title)) return { title: sheet.title, englishTitle: entry?.englishTitle ?? '' };
  if (!isBilingualSheetSong(sheet)) return { title: sheet.title, englishTitle: '' };
  return entry && /[가-힣]/.test(entry.title)
    ? { title: entry.title, englishTitle: sheet.title }
    : { title: sheet.title, englishTitle: '' };
}

/** A chord-sheet song's English, keyed by the Korean slide each part was divided into. */
export function englishFromSheet(slides: SheetSlide[], englishTitle: string): PraiseEnglish {
  const byKey: Record<string, string[]> = {};
  for (const slide of slides) {
    if (slide.ko.length > 0 && slide.en.length > 0) byKey[slideKey(slide.ko)] = [...slide.en];
  }
  return { title: englishTitle, slides: byKey };
}

/**
 * The sheet's song as a library entry, so English can be matched back to the
 * Korean however the song is later split into slides.
 */
export function entryFromSheet(title: string, englishTitle: string, slides: SheetSlide[]): EnglishSongEntry {
  return { title, englishTitle, slides: slides.map((slide) => ({ ko: [...slide.ko], en: [...slide.en] })) };
}
