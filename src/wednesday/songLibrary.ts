// The 수요예배 찬양 library: every song this church has used on a Wednesday,
// with the address its PPT came from.
//
// Links only, by decision. A 찬양 PPT is someone else's file — remembering
// where it lives means the next week starts from "open this and download it"
// instead of searching again, without this app becoming a store of other
// people's sheet music. The week's actual files ride along with that week's
// 라이브러리 entry (see source.ts) and are cleared with it.
//
// Shaped after the lyrics library (lib/storage/library.ts): a local copy in
// localStorage so the list is there offline, a durable queue for writes made
// while the proxy is unreachable, and a shared server copy that wins on sync.
import { cloudLibraryJson, hasCloudLibrary } from '../lib/storage/cloudLibrary';
import { normalizeTitle } from '../lib/storage/library';

const STORAGE_KEY = 'wednesday-song-library';
const QUEUE_KEY = 'wednesday-song-library-sync-queue-v1';
const ROUTE = '/libraries/wednesday-songs';

export interface WednesdaySongEntry {
  title: string;
  /** Where the PPT was downloaded from, when it was found on the web. */
  sourceUrl?: string;
  sourceHost?: string;
  slideCount?: number;
  updatedAt?: string;
}

interface QueuedWrite {
  kind: 'upsert' | 'delete';
  title: string;
  entry?: WednesdaySongEntry;
}

export interface WednesdaySongSyncResult {
  entries: WednesdaySongEntry[];
  state: 'synced' | 'local' | 'error';
  message?: string;
}

function sanitize(raw: unknown): WednesdaySongEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>;
  const title = typeof value.title === 'string' ? value.title.trim() : '';
  if (!title) return null;
  const entry: WednesdaySongEntry = { title };
  if (typeof value.sourceUrl === 'string' && /^https:\/\//.test(value.sourceUrl)) {
    entry.sourceUrl = value.sourceUrl;
    entry.sourceHost =
      typeof value.sourceHost === 'string' && value.sourceHost
        ? value.sourceHost
        : hostOf(value.sourceUrl);
  }
  if (typeof value.slideCount === 'number' && value.slideCount > 0) {
    entry.slideCount = Math.floor(value.slideCount);
  }
  if (typeof value.updatedAt === 'string') entry.updatedAt = value.updatedAt;
  return entry;
}

function hostOf(url: string): string | undefined {
  try {
    return new URL(url).host;
  } catch {
    return undefined;
  }
}

function readLocal(): WednesdaySongEntry[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(parsed) ? parsed.flatMap((item) => sanitize(item) ?? []) : [];
  } catch {
    return [];
  }
}

function writeLocal(entries: WednesdaySongEntry[]): void {
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
    // Same as above: the local list is still correct.
  }
}

/** Replace-by-title, so re-saving a song updates it instead of duplicating it. */
export function upsertSongEntry(
  entries: WednesdaySongEntry[],
  entry: WednesdaySongEntry,
): WednesdaySongEntry[] {
  const key = normalizeTitle(entry.title);
  const next = entries.filter((existing) => normalizeTitle(existing.title) !== key);
  next.push(entry);
  return next.sort((a, b) => a.title.localeCompare(b.title, 'ko'));
}

export function findSongEntry(
  entries: WednesdaySongEntry[],
  title: string,
): WednesdaySongEntry | undefined {
  const key = normalizeTitle(title);
  if (!key) return undefined;
  return entries.find((entry) => normalizeTitle(entry.title) === key);
}

/** Title or host substring search, for the "라이브러리에서 추가" list. */
export function searchSongEntries(
  entries: WednesdaySongEntry[],
  query: string,
  limit = 30,
): WednesdaySongEntry[] {
  const key = normalizeTitle(query);
  if (!key) return entries.slice(0, limit);
  return entries.filter((entry) => normalizeTitle(entry.title).includes(key)).slice(0, limit);
}

export function loadSongLibrary(): WednesdaySongEntry[] {
  return readLocal();
}

/**
 * Remember a song and where its PPT came from. The entry goes through the same
 * check as one read back from the server, so an address that is not an https
 * link is dropped rather than stored and shown as one.
 */
export async function saveSongEntry(entry: WednesdaySongEntry): Promise<WednesdaySongEntry[]> {
  const checked = sanitize(entry);
  if (!checked) return readLocal();
  const stored: WednesdaySongEntry = { ...checked, updatedAt: new Date().toISOString() };
  const entries = upsertSongEntry(readLocal(), stored);
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

export async function deleteSongEntry(title: string): Promise<WednesdaySongEntry[]> {
  const key = normalizeTitle(title);
  const entries = readLocal().filter((entry) => normalizeTitle(entry.title) !== key);
  writeLocal(entries);

  if (hasCloudLibrary()) {
    try {
      await cloudLibraryJson(ROUTE, { method: 'DELETE', body: JSON.stringify({ title }) }, true);
    } catch {
      queueWrite({ kind: 'delete', title });
    }
  }
  return entries;
}

function queueWrite(write: QueuedWrite): void {
  const key = normalizeTitle(write.title);
  const queue = readQueue().filter((queued) => normalizeTitle(queued.title) !== key);
  queue.push(write);
  writeQueue(queue);
}

/** Send whatever was written while the proxy was unreachable. */
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

/**
 * Bring the local list in line with the server's. The cloud copy wins, and a
 * server tombstone is never overwritten by a stale local entry.
 */
export async function synchronizeSongLibrary(): Promise<WednesdaySongSyncResult> {
  const local = readLocal();
  if (!hasCloudLibrary()) return { entries: local, state: 'local' };

  try {
    // Offer anything this browser has that the server has never seen.
    if (local.length > 0) {
      await cloudLibraryJson(ROUTE, { method: 'POST', body: JSON.stringify({ entries: local }) }, true);
    }
    await flushQueue();
    const snapshot = await cloudLibraryJson<{ entries?: unknown[]; deletedTitles?: unknown[] }>(ROUTE);
    const deleted = new Set(
      (snapshot.deletedTitles ?? []).filter((title): title is string => typeof title === 'string'),
    );
    const entries = (snapshot.entries ?? [])
      .flatMap((item) => sanitize(item) ?? [])
      .filter((entry) => !deleted.has(normalizeTitle(entry.title)))
      .sort((a, b) => a.title.localeCompare(b.title, 'ko'));
    writeLocal(entries);
    return { entries, state: 'synced' };
  } catch (error) {
    return {
      entries: local,
      state: 'error',
      message: error instanceof Error ? error.message : String(error),
    };
  }
}
