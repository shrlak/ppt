import type { LibraryEntry } from '../utils/types';
import { cloudLibraryJson, hasCloudLibrary } from './cloudLibrary';

const STORAGE_KEY = 'praise-lyrics-library';
const SYNC_QUEUE_KEY = 'praise-lyrics-library-sync-queue-v1';

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

type LyricsSyncOperation =
  | { id: string; type: 'upsert'; titleKey: string; entry: LibraryEntry }
  | { id: string; type: 'delete'; titleKey: string; title: string };

export interface LyricsLibrarySyncResult {
  entries: LibraryEntry[];
  synced: boolean;
  error?: string;
}

interface CloudLyricsSnapshot {
  entries: LibraryEntry[];
  deletedTitles: string[];
}

function operationId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }
}

function loadSyncQueue(): LyricsSyncOperation[] {
  const store = storage();
  if (!store) return [];
  try {
    const raw = JSON.parse(store.getItem(SYNC_QUEUE_KEY) ?? '[]') as LyricsSyncOperation[];
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

function saveSyncQueue(operations: LyricsSyncOperation[]): void {
  storage()?.setItem(SYNC_QUEUE_KEY, JSON.stringify(operations));
}

function enqueueSyncOperation(operation: LyricsSyncOperation): void {
  const queue = loadSyncQueue().filter((candidate) => candidate.titleKey !== operation.titleKey);
  saveSyncQueue([...queue, operation]);
  // Local saving stays instant. The durable queue retries whenever the page
  // starts, regains focus, or another library operation is made.
  void flushLyricsSyncQueue().catch(() => undefined);
}

export function queueLyricsUpsert(entry: LibraryEntry): void {
  enqueueSyncOperation({
    id: operationId(),
    type: 'upsert',
    titleKey: normalizeTitle(entry.title),
    entry,
  });
}

export function queueLyricsDelete(title: string): void {
  enqueueSyncOperation({
    id: operationId(),
    type: 'delete',
    titleKey: normalizeTitle(title),
    title,
  });
}

let flushPromise: Promise<void> | null = null;

export async function flushLyricsSyncQueue(): Promise<void> {
  if (!hasCloudLibrary()) return;
  if (flushPromise) return flushPromise;
  flushPromise = (async () => {
    while (true) {
      const operation = loadSyncQueue()[0];
      if (!operation) return;
      if (operation.type === 'upsert') {
        await cloudLibraryJson('/libraries/lyrics', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ entry: operation.entry }),
        }, true);
      } else {
        await cloudLibraryJson('/libraries/lyrics', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title: operation.title }),
        }, true);
      }
      // Remove only the operation that completed. If a newer operation for
      // the same song arrived while the request was running, its different ID
      // remains queued and is sent next.
      saveSyncQueue(loadSyncQueue().filter((candidate) => candidate.id !== operation.id));
    }
  })();
  try {
    await flushPromise;
  } finally {
    flushPromise = null;
  }
}

function validCloudEntries(value: unknown): LibraryEntry[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (entry): entry is LibraryEntry =>
      !!entry &&
      typeof entry === 'object' &&
      typeof (entry as LibraryEntry).title === 'string' &&
      Array.isArray((entry as LibraryEntry).sections) &&
      Array.isArray((entry as LibraryEntry).order),
  );
}

let synchronizationPromise: Promise<LyricsLibrarySyncResult> | null = null;

/**
 * Reconcile this browser's legacy/local cache with the shared library.
 * Cloud entries win existing-title conflicts; explicit queued saves win after
 * that migration pass. Server tombstones prevent a stale device from
 * recreating a song another device deleted.
 */
export async function synchronizeUserLibrary(): Promise<LyricsLibrarySyncResult> {
  if (!hasCloudLibrary()) return { entries: loadUserLibrary(), synced: false };
  if (synchronizationPromise) return synchronizationPromise;
  synchronizationPromise = (async () => {
    try {
      await cloudLibraryJson<CloudLyricsSnapshot>('/libraries/lyrics', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entries: loadUserLibrary() }),
      }, true);
      await flushLyricsSyncQueue();
      const snapshot = await cloudLibraryJson<CloudLyricsSnapshot>('/libraries/lyrics', {
        method: 'GET',
        headers: { Accept: 'application/json' },
      });
      const entries = validCloudEntries(snapshot.entries);
      saveUserLibrary(entries);
      return { entries, synced: true };
    } catch (error) {
      return {
        entries: loadUserLibrary(),
        synced: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  })();
  try {
    return await synchronizationPromise;
  } finally {
    synchronizationPromise = null;
  }
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
