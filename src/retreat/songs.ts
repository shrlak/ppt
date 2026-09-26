// Song lyrics for the 수련회 decks: typed as projected (a blank line between
// slides) and looked up by title — first among the songs last year's retreat
// decks projected (public/retreat-songs.json), then in the 찬양 라이브러리.
import { findLibrarySong, isGroundTruth, normalizeTitle } from '../lib/storage/library';
import { planSlides } from '../lib/utils/slidePlanner';
import type { LibraryEntry } from '../lib/utils/types';
import { newId, type RetreatSong } from './types';

/** Lines per lyric slide, as the retreat decks project them. */
export const RETREAT_LINES_PER_SLIDE = 4;

export interface RetreatSongSeed {
  title: string;
  slides: string[][];
}

export function sanitizeSongSeeds(raw: unknown): RetreatSongSeed[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const { title, slides } = item as { title?: unknown; slides?: unknown };
    if (typeof title !== 'string' || !title.trim() || !Array.isArray(slides)) return [];
    const clean = slides
      .filter(Array.isArray)
      .map((lines) => (lines as unknown[]).filter((line): line is string => typeof line === 'string'))
      .filter((lines) => lines.length > 0);
    return clean.length > 0 ? [{ title: title.trim(), slides: clean }] : [];
  });
}

export async function fetchSongSeeds(baseUrl: string): Promise<RetreatSongSeed[]> {
  try {
    const response = await fetch(`${baseUrl}retreat-songs.json`);
    return response.ok ? sanitizeSongSeeds(await response.json()) : [];
  } catch {
    return [];
  }
}

/** Split into ceil(n/size) groups of near-equal size (6 lines at 4 → 3 + 3). */
function chunkBalanced<T>(items: T[], size: number): T[][] {
  if (items.length === 0) return [];
  const groups = Math.ceil(items.length / size);
  const base = Math.floor(items.length / groups);
  const remainder = items.length % groups;
  const out: T[][] = [];
  let at = 0;
  for (let group = 0; group < groups; group++) {
    const length = base + (group < remainder ? 1 : 0);
    out.push(items.slice(at, at + length));
    at += length;
  }
  return out;
}

/** The slides a song's lyrics make: blank lines split, long runs split evenly. */
export function lyricSlides(lyrics: string, maxLines = RETREAT_LINES_PER_SLIDE): string[][] {
  const blocks: string[][] = [];
  let current: string[] = [];
  for (const raw of lyrics.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) {
      if (current.length > 0) blocks.push(current);
      current = [];
      continue;
    }
    current.push(line);
  }
  if (current.length > 0) blocks.push(current);
  return blocks.flatMap((block) => chunkBalanced(block, maxLines));
}

export function lyricsText(slides: string[][]): string {
  return slides.map((lines) => lines.join('\n')).join('\n\n');
}

/** A 찬양 라이브러리 entry laid out the way the Sunday deck would show it. */
export function libraryLyricsText(entry: Pick<LibraryEntry, 'title' | 'sections' | 'order'>): string {
  const plans = planSlides({
    id: 'library',
    title: entry.title,
    sections: entry.sections,
    order: entry.order,
    linesPerSlide: RETREAT_LINES_PER_SLIDE,
  });
  return lyricsText(plans.filter((plan) => plan.kind === 'lyrics').map((plan) => plan.lines ?? []));
}

/** A song by title, with the lyrics of whichever source knows it first. */
export function resolveSong(title: string, seeds: RetreatSongSeed[], library: LibraryEntry[]): RetreatSong {
  const key = normalizeTitle(title);
  const seed = key ? seeds.find((entry) => normalizeTitle(entry.title) === key) : undefined;
  if (seed) return { id: newId(), title, lyrics: lyricsText(seed.slides), source: 'retreat' };
  const saved = key ? findLibrarySong(library, { title }) : undefined;
  if (saved) return { id: newId(), title, lyrics: libraryLyricsText(saved), source: 'library' };
  return { id: newId(), title, lyrics: '' };
}

/** True when an entry names its parts (V, C, B …) rather than numbering its slides. */
function hasLabelledParts(entry: Pick<LibraryEntry, 'sections'>): boolean {
  return entry.sections.some((section) => !/^\d+$/.test(section.label.trim()));
}

/**
 * A 수련회 song typed or corrected here, as the 찬양 라이브러리 entry it
 * should be saved as — each slide one numbered part, like a 찬양집회 save —
 * or null when there is nothing to save or saving would lose something.
 *
 * Lyrics that only came from last year's retreat or from the library itself
 * are not saved back. Nor is a song whose confirmed library copy names its
 * parts (V, C, B …): the Sunday page lays a conti's 진행 순서 over those
 * names, and numbered slides would undo that. Anything else — a new song, a
 * draft, a copy saved from another retreat or 찬양집회 — takes the words
 * typed here.
 */
export function libraryEntryForRetreatSong(song: RetreatSong, previous: LibraryEntry | undefined): LibraryEntry | null {
  if (song.source !== 'manual') return null;
  const title = song.title.trim();
  const slides = lyricSlides(song.lyrics);
  if (!title || slides.length === 0) return null;
  if (previous && isGroundTruth(previous) && hasLabelledParts(previous)) return null;
  const sections = slides.map((lines, index) => ({ label: String(index + 1), lines }));
  return {
    title,
    sections,
    order: sections.map((section) => section.label),
    verification: 'edited',
    version: (previous?.version ?? 0) + 1,
    updatedAt: new Date().toISOString(),
  };
}
