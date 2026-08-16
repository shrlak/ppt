import type {
  LibraryEntry,
  SanitizedLibraryEntry,
  Section,
  SongIdentity,
  StoredProvenance,
  VerificationState,
} from '../utils/types';
import { cloudLibraryJson, hasCloudLibrary } from './cloudLibrary';

const STORAGE_KEY = 'praise-lyrics-library';
const SYNC_QUEUE_KEY = 'praise-lyrics-library-sync-queue-v1';

/** Lowercase and strip everything but letters, digits and Hangul, for title comparison. */
export function normalizeTitle(t: string): string {
  return t.toLowerCase().replace(/[^0-9a-zㄱ-ㆎ가-힣]+/g, '');
}

const MAX_LYRIC_SECTIONS = 50;
const MAX_LYRIC_LINES = 500;

const VERIFICATION_STATES: VerificationState[] = ['draft', 'verified', 'edited'];
const PROVENANCE_SOURCES = ['library', 'models', 'web', 'manual'] as const;

function trimmedString(value: unknown, maxLength: number): string {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

/**
 * Keep only the provenance fields whose shape we can verify. Provenance
 * arrives from storage written by an older (or newer) build, so an
 * unrecognized or wrongly typed field is dropped rather than carried through
 * into the code that reads it.
 */
export function sanitizeStoredProvenance(raw: unknown): StoredProvenance | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const obj = raw as Record<string, unknown>;
  const provenance: StoredProvenance = {};
  const pageHash = trimmedString(obj.pageHash, 128);
  if (pageHash) provenance.pageHash = pageHash;
  const source = trimmedString(obj.source, 20);
  if ((PROVENANCE_SOURCES as readonly string[]).includes(source)) {
    provenance.source = source as StoredProvenance['source'];
  }
  const webSourceUrl = trimmedString(obj.webSourceUrl, 500);
  if (/^https?:\/\//.test(webSourceUrl)) provenance.webSourceUrl = webSourceUrl;
  const confidence = Number(obj.confidence);
  if (Number.isFinite(confidence) && confidence >= 0 && confidence <= 1) provenance.confidence = confidence;
  const modelVersion = trimmedString(obj.correctionModelVersion, 64);
  if (modelVersion) provenance.correctionModelVersion = modelVersion;
  return Object.keys(provenance).length > 0 ? provenance : undefined;
}

/**
 * Coerce a stored library entry into its sanitized form, or null when it is
 * not a usable song at all.
 *
 * Entries written before verification existed carry no state. They are
 * migrated to 'verified': every one of them was put there by an explicit user
 * save, which is exactly what 'verified' means, and it is the only migration
 * that does not silently demote a library the user already trusts.
 */
export function sanitizeLibraryEntry(raw: unknown): SanitizedLibraryEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const title = trimmedString(obj.title, 200);
  if (!title || !normalizeTitle(title) || !Array.isArray(obj.sections)) return null;

  let lineCount = 0;
  const sections: Section[] = [];
  for (const candidate of obj.sections.slice(0, MAX_LYRIC_SECTIONS)) {
    if (!candidate || typeof candidate !== 'object') continue;
    const record = candidate as Record<string, unknown>;
    if (!Array.isArray(record.lines)) continue;
    const label = trimmedString(record.label, 30);
    if (!label) continue;
    const lines: string[] = [];
    for (const value of record.lines) {
      if (lineCount >= MAX_LYRIC_LINES) break;
      if (typeof value !== 'string') continue;
      lines.push(value.slice(0, 500));
      lineCount += 1;
    }
    sections.push({ label, lines });
    if (lineCount >= MAX_LYRIC_LINES) break;
  }

  const order = Array.isArray(obj.order)
    ? obj.order.map((value) => trimmedString(value, 30)).filter(Boolean).slice(0, 500)
    : [];
  const artist = trimmedString(obj.artist, 200);
  const key = trimmedString(obj.key, 20);
  const verification = VERIFICATION_STATES.includes(obj.verification as VerificationState)
    ? (obj.verification as VerificationState)
    : 'verified';
  const rawVersion = Number(obj.version);
  const version = Number.isSafeInteger(rawVersion) && rawVersion >= 1 ? rawVersion : 1;
  const updatedAt = trimmedString(obj.updatedAt, 40);
  const provenance = sanitizeStoredProvenance(obj.provenance);

  return {
    title,
    ...(artist ? { artist } : {}),
    ...(key ? { key } : {}),
    sections,
    order,
    verification,
    version,
    ...(updatedAt ? { updatedAt } : {}),
    ...(provenance ? { provenance } : {}),
  };
}

export function sanitizeLibraryEntries(raw: unknown): SanitizedLibraryEntry[] {
  if (!Array.isArray(raw)) return [];
  return raw.map(sanitizeLibraryEntry).filter((entry): entry is SanitizedLibraryEntry => entry !== null);
}

/** Trust level of an entry that may predate the verification field. */
export function entryVerification(entry: LibraryEntry): VerificationState {
  return VERIFICATION_STATES.includes(entry.verification as VerificationState)
    ? (entry.verification as VerificationState)
    : 'verified';
}

/** True when this entry is ground truth a user stood behind. */
export function isGroundTruth(entry: LibraryEntry): boolean {
  return entryVerification(entry) !== 'draft';
}

/**
 * The saved entry that may be reused INSTEAD of recognizing the page again.
 *
 * Only user-confirmed entries qualify: a draft is a machine's guess, and
 * reusing one would let a single bad reading become permanent. When an artist
 * is known on both sides it has to agree, so two different songs that share a
 * title stay apart; the highest saved version wins.
 */
export function selectReusableEntry(
  entries: LibraryEntry[],
  identity: SongIdentity,
): LibraryEntry | undefined {
  const wantedTitle = normalizeTitle(identity.title ?? '');
  if (!wantedTitle) return undefined;
  const wantedArtist = identity.artist ? normalizeTitle(identity.artist) : '';
  return entries
    .filter((candidate) => isGroundTruth(candidate))
    .filter((candidate) => normalizeTitle(candidate.title) === wantedTitle)
    .filter(
      (candidate) =>
        !wantedArtist || !candidate.artist || normalizeTitle(candidate.artist) === wantedArtist,
    )
    .sort((a, b) => (b.version ?? 1) - (a.version ?? 1))[0];
}

/** Load the read-only starter library bundled with the site. */
export async function fetchBundledLibrary(baseUrl: string): Promise<LibraryEntry[]> {
  try {
    const res = await fetch(baseUrl + 'library.json');
    if (!res.ok) return [];
    return sanitizeLibraryEntries(await res.json());
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
    return sanitizeLibraryEntries(JSON.parse(raw));
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
  return sanitizeLibraryEntries(value);
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

/**
 * Replace the entry with the same normalized title, or append. Returns a new
 * array.
 *
 * A draft never replaces ground truth: recognition runs on every conti, so
 * without this rule one weak reading of an already-verified song would quietly
 * overwrite the wording the user confirmed. An explicit verified/edited save
 * still replaces whatever was there, including a newer draft.
 */
export function upsertEntry(entries: LibraryEntry[], entry: LibraryEntry): LibraryEntry[] {
  const want = normalizeTitle(entry.title);
  const idx = entries.findIndex((e) => normalizeTitle(e.title) === want);
  if (idx === -1) return [...entries, entry];
  if (entryVerification(entry) === 'draft' && isGroundTruth(entries[idx])) return entries.slice();
  const next = entries.slice();
  next[idx] = entry;
  return next;
}
