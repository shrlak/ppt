// Resolving the 공동체 고백송 — the song whose lyric slides live inside the
// fixed back-slides deck.
//
// 관리자 설정 stores only the TITLE (shared across every device via the
// proxy); the lyrics themselves come from the 곡 라이브러리, so the confession
// song is edited, corrected and saved exactly like every other song instead
// of being typed a second time into the settings.
import { getSyncedAiSettings } from '../ai/aiSettings';
import {
  fetchBundledLibrary,
  findEntry,
  loadUserLibrary,
  mergeLibraries,
} from '../storage/library';
import { planSlides } from './slidePlanner';
import type { LibraryEntry, Song } from './types';

/** A library entry as the song the slide planner works on. */
export function songFromLibraryEntry(entry: LibraryEntry, id = 'confession-song'): Song {
  return {
    id,
    title: entry.title,
    ...(entry.key ? { key: entry.key } : {}),
    sections: structuredClone(entry.sections),
    order: [...entry.order],
    linesPerSlide: 4,
    ...(entry.verification ? { verification: entry.verification } : {}),
  };
}

export interface ConfessionSongLookup {
  /** The configured title. Empty means "leave the back slides as supplied". */
  title: string;
  /** The song to print, or null when the library has no lyrics under that title. */
  song: Song | null;
  /** Lyric slides it would fill (the marker slide is not counted). */
  slideCount: number;
}

/**
 * Look up this season's 공동체 고백송.
 *
 * The library read is bundled + this browser's saved songs — the same two
 * sources the 찬양 step merges before its own cloud sync, which is what fills
 * localStorage in the first place. A title with no lyrics behind it resolves
 * to `song: null`, and the back deck is then left exactly as supplied rather
 * than rewritten to a blank song.
 */
export async function lookupConfessionSong(
  baseUrl: string,
  title?: string,
): Promise<ConfessionSongLookup> {
  const wanted = (title ?? (await getSyncedAiSettings()).confessionSong).trim();
  if (!wanted) return { title: '', song: null, slideCount: 0 };

  const library = mergeLibraries(await fetchBundledLibrary(baseUrl), loadUserLibrary());
  const entry = findEntry(library, wanted);
  if (!entry) return { title: wanted, song: null, slideCount: 0 };

  const song = songFromLibraryEntry(entry);
  const slideCount = planSlides(song).filter((plan) => plan.kind === 'lyrics').length;
  return { title: wanted, song: slideCount > 0 ? song : null, slideCount };
}
