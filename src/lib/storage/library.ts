import type { LibraryEntry } from '../utils/types';

const STORAGE_KEY = 'praise-lyrics-library';

/** Lowercase and strip everything but letters, digits and Hangul, for title comparison. */
export function normalizeTitle(t: string): string {
  return t.toLowerCase().replace(/[^0-9a-zㄱ-ㆎ가-힣]+/g, '');
}

/** Load the read-only starter library bundled with the site. */
export async function fetchBundledLibrary(baseUrl: string): Promise<LibraryEntry[]> {
  try {
    const res = await fetch(baseUrl + 'library.json');
    if (!res.ok) return [];
    const data = (await res.json()) as LibraryEntry[];
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/** Songs the user has saved in this browser. */
export function loadUserLibrary(): LibraryEntry[] {
  const store = storage();
  if (!store) return [];
  try {
    const raw = store.getItem(STORAGE_KEY);
    if (!raw) return [];
    const data = JSON.parse(raw) as LibraryEntry[];
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

export function saveUserLibrary(entries: LibraryEntry[]): void {
  storage()?.setItem(STORAGE_KEY, JSON.stringify(entries));
}

/** Merge bundled and user libraries; user entries win on matching titles. */
export function mergeLibraries(bundled: LibraryEntry[], user: LibraryEntry[]): LibraryEntry[] {
  const userTitles = new Set(user.map((e) => normalizeTitle(e.title)));
  return [...bundled.filter((e) => !userTitles.has(normalizeTitle(e.title))), ...user];
}

/**
 * Find a library entry by title. Tries an exact normalized match first, then
 * falls back to a substring match (either direction) so small OCR/typing
 * differences — a stray numbering prefix, a dropped word — still find the
 * song, consistent with the fuzzy match already used for un-covered pages.
 */
export function findEntry(library: LibraryEntry[], title: string): LibraryEntry | undefined {
  const want = normalizeTitle(title);
  if (!want) return undefined;
  const exact = library.find((e) => normalizeTitle(e.title) === want);
  if (exact) return exact;
  if (want.length < 2) return undefined;
  return library.find((e) => {
    const t = normalizeTitle(e.title);
    return t.length >= 2 && (want.includes(t) || t.includes(want));
  });
}

/** Replace the entry with the same normalized title, or append. Returns a new array. */
export function upsertEntry(entries: LibraryEntry[], entry: LibraryEntry): LibraryEntry[] {
  const want = normalizeTitle(entry.title);
  const idx = entries.findIndex((e) => normalizeTitle(e.title) === want);
  if (idx === -1) return [...entries, entry];
  const next = entries.slice();
  next[idx] = entry;
  return next;
}
