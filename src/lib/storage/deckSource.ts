// The wizard inputs a saved deck was built from, archived next to the
// generated .pptx so 라이브러리 → 편집 can reopen the deck in the six-step
// editor instead of only offering the finished file. Kept apart from
// pptLibrary.ts so it stays free of browser storage APIs and unit testable.
import type { Song } from '../utils/types';

/** Bumped only for a change old snapshots can't be read through. */
export const DECK_SOURCE_VERSION = 1;

export const DECK_SOURCE_FILE_NAME = 'deck-source.json';

/**
 * Structurally the 라이브러리's SavedFile. Spelled out here rather than
 * imported so this module keeps compiling without the DOM storage types
 * pptLibrary.ts needs.
 */
export interface DeckSourceFile {
  name: string;
  data: ArrayBuffer;
}

export interface DeckSourceBible {
  verseInput: string;
  sermonTitle: string;
  translations: string[];
  versesPerSlide: number;
}

/**
 * Everything the wizard needs to rebuild a deck exactly as it was saved. The
 * uploaded 설교 PPT and 콘티 PDF are not here — those are already archived as
 * their own files on the entry. A custom 성경 template is deliberately left
 * out too: it is a per-session override, not part of the week's content.
 */
export interface DeckSource {
  version: number;
  /** Conti date the file name was suggested from, e.g. "7/26/26". */
  contiDate?: string;
  songs: Song[];
  bible: DeckSourceBible;
  announcementText: string;
}

function sectionsOf(value: unknown): Song['sections'] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((raw) => {
    if (!raw || typeof raw !== 'object') return [];
    const { label, lines } = raw as { label?: unknown; lines?: unknown };
    if (typeof label !== 'string' || !Array.isArray(lines)) return [];
    return [{ label, lines: lines.filter((line): line is string => typeof line === 'string') }];
  });
}

function songOf(value: unknown): Song | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.title !== 'string') return null;
  return {
    // A restored song is a fresh editing session; only its content carries over.
    id: typeof raw.id === 'string' && raw.id ? raw.id : crypto.randomUUID(),
    title: raw.title,
    ...(typeof raw.key === 'string' ? { key: raw.key } : {}),
    ...(typeof raw.description === 'string' ? { description: raw.description } : {}),
    sections: sectionsOf(raw.sections),
    order: Array.isArray(raw.order) ? raw.order.filter((label): label is string => typeof label === 'string') : [],
    linesPerSlide: Number.isFinite(raw.linesPerSlide) ? Number(raw.linesPerSlide) : 4,
    ...(Number.isFinite(raw.pageIndex) ? { pageIndex: Number(raw.pageIndex) } : {}),
  };
}

function bibleOf(value: unknown): DeckSourceBible {
  const raw = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  const translations = Array.isArray(raw.translations)
    ? raw.translations.filter((id): id is string => typeof id === 'string')
    : [];
  return {
    verseInput: typeof raw.verseInput === 'string' ? raw.verseInput : '',
    sermonTitle: typeof raw.sermonTitle === 'string' ? raw.sermonTitle : '',
    translations: translations.length > 0 ? translations : ['nkrv', 'esv'],
    versesPerSlide: Number.isFinite(raw.versesPerSlide) ? Math.max(1, Number(raw.versesPerSlide)) : 1,
  };
}

/** Serialize the wizard inputs into a file that rides along with the deck. */
export function encodeDeckSource(source: Omit<DeckSource, 'version'>): DeckSourceFile {
  const json = JSON.stringify({ ...source, version: DECK_SOURCE_VERSION });
  return { name: DECK_SOURCE_FILE_NAME, data: new TextEncoder().encode(json).buffer as ArrayBuffer };
}

/**
 * Read a snapshot back. Returns null for entries saved before snapshots
 * existed, for a version this build can't read, and for anything corrupt —
 * every caller has to handle a missing snapshot anyway, so a partial restore
 * is never worth a thrown error.
 */
export function decodeDeckSource(file: DeckSourceFile | null | undefined): DeckSource | null {
  if (!file) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(file.data));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const raw = parsed as Record<string, unknown>;
  if (raw.version !== DECK_SOURCE_VERSION) return null;
  return {
    version: DECK_SOURCE_VERSION,
    ...(typeof raw.contiDate === 'string' ? { contiDate: raw.contiDate } : {}),
    songs: Array.isArray(raw.songs) ? raw.songs.flatMap((song) => songOf(song) ?? []) : [],
    bible: bibleOf(raw.bible),
    announcementText: typeof raw.announcementText === 'string' ? raw.announcementText : '',
  };
}
