// Cross-device persistence for the PPT 라이브러리. IndexedDB remains the
// fast/offline cache; the existing Cloudflare Durable Object is the shared
// source of truth. Binary files travel in 1 MiB chunks so a complete generated
// deck and its source PDF/PPTX files never depend on browser storage alone.
import JSZip from 'jszip';
import { decksWithSameName } from './deckNames';
import { SAVED_FILE_KINDS, type SavedFileKind } from './deckFileKinds';
import {
  cloudLibraryJson,
  cloudLibraryRequest,
  hasCloudLibrary,
} from './cloudLibrary';

export interface SavedFile {
  name: string;
  data: ArrayBuffer;
}

export { SAVED_FILE_KINDS };
export type { SavedFileKind };

export interface SavedDeck {
  id: string;
  /** User-facing label; defaults to the generated file name. */
  name: string;
  /** The complete generated deck, ready to re-download as-is. */
  pptx: SavedFile;
  /** Source files the deck was built from, kept for reference (optional). */
  contiPdf: SavedFile | null;
  sermonPptx: SavedFile | null;
  /**
   * The wizard inputs this deck was generated from (see deckSource.ts), so
   * 편집 can reopen it in the six-step editor. Null for entries saved before
   * snapshots existed — those restore only from the files above.
   */
  source: SavedFile | null;
  /** Ordered raw uploads appended after Back/End, packed as additional-files.zip. */
  additionalFiles?: SavedFile | null;
  slideCount: number;
  songTitles: string[];
  savedAt: string;
  /** Last edit or successful cloud migration; legacy records fall back to savedAt. */
  updatedAt: string;
  /** A local write is safe, but still waiting for a successful cloud retry. */
  syncPending?: boolean;
}

export type SavedDeckInput = Omit<SavedDeck, 'id' | 'savedAt' | 'updatedAt' | 'syncPending'>;

export interface SavedDeckResult {
  deck: SavedDeck;
  /** Same-name entries this write replaced; 0 when the entry is brand new. */
  replaced: number;
}

export interface SavedFileSummary {
  name: string;
  size: number;
  chunkCount: number;
}

export interface SavedDeckSummary {
  id: string;
  name: string;
  pptx: SavedFileSummary;
  contiPdf: SavedFileSummary | null;
  sermonPptx: SavedFileSummary | null;
  source: SavedFileSummary | null;
  additionalFiles: SavedFileSummary | null;
  slideCount: number;
  songTitles: string[];
  savedAt: string;
  updatedAt: string;
  syncPending?: boolean;
}

export interface PptLibrarySnapshot {
  decks: SavedDeckSummary[];
  sync: 'synced' | 'pending' | 'local';
  message?: string;
}

interface RemoteDeckMetadata {
  id: string;
  uploadId: string;
  name: string;
  files: {
    pptx: SavedFileSummary;
    contiPdf: SavedFileSummary | null;
    sermonPptx: SavedFileSummary | null;
    source: SavedFileSummary | null;
    additionalFiles?: SavedFileSummary | null;
  };
  slideCount: number;
  songTitles: string[];
  savedAt: string;
  updatedAt: string;
}

interface RemoteLibrarySnapshot {
  decks: RemoteDeckMetadata[];
  deletedIds: string[];
}

const DB_NAME = 'kccp-ppt-library';
const STORE = 'decks';
export const PPT_LIBRARY_CHUNK_BYTES = 1024 * 1024;
const MAX_PPT_LIBRARY_BYTES = 100 * 1024 * 1024;
const TRANSFER_CONCURRENCY = 4;

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB를 열지 못했습니다.'));
  });
}

async function withStore<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const req = run(db.transaction(STORE, mode).objectStore(STORE));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error('IndexedDB 작업에 실패했습니다.'));
    });
  } finally {
    db.close();
  }
}

function normalizeLocalDeck(deck: SavedDeck): SavedDeck {
  return {
    ...deck,
    // Records written before inputs snapshots existed have no `source` key.
    source: deck.source ?? null,
    // Records written before post-End uploads existed have no archive key.
    additionalFiles: deck.additionalFiles ?? null,
    updatedAt: deck.updatedAt || deck.savedAt,
  };
}

async function putLocalDeck(deck: SavedDeck): Promise<void> {
  await withStore('readwrite', (store) => store.put(deck));
}

async function getLocalDeck(id: string): Promise<SavedDeck | null> {
  try {
    const deck = await withStore<SavedDeck | undefined>('readonly', (store) => store.get(id));
    return deck ? normalizeLocalDeck(deck) : null;
  } catch {
    return null;
  }
}

async function listLocalDecks(): Promise<SavedDeck[]> {
  try {
    const decks = await withStore<SavedDeck[]>('readonly', (store) => store.getAll());
    return decks.map(normalizeLocalDeck).sort((a, b) => b.savedAt.localeCompare(a.savedAt));
  } catch {
    return [];
  }
}

async function deleteLocalDeck(id: string): Promise<void> {
  try {
    await withStore('readwrite', (store) => store.delete(id));
  } catch {
    // Remote deletion still succeeds when private browsing blocks IndexedDB.
  }
}

function descriptor(file: SavedFile): SavedFileSummary {
  return {
    name: file.name,
    size: file.data.byteLength,
    chunkCount: Math.max(1, Math.ceil(file.data.byteLength / PPT_LIBRARY_CHUNK_BYTES)),
  };
}

function filesForDeck(deck: SavedDeck): RemoteDeckMetadata['files'] {
  return {
    pptx: descriptor(deck.pptx),
    contiPdf: deck.contiPdf ? descriptor(deck.contiPdf) : null,
    sermonPptx: deck.sermonPptx ? descriptor(deck.sermonPptx) : null,
    source: deck.source ? descriptor(deck.source) : null,
    additionalFiles: deck.additionalFiles ? descriptor(deck.additionalFiles) : null,
  };
}

function summaryFromRemote(deck: RemoteDeckMetadata, syncPending = false): SavedDeckSummary {
  return {
    id: deck.id,
    name: deck.name,
    pptx: deck.files.pptx,
    contiPdf: deck.files.contiPdf,
    sermonPptx: deck.files.sermonPptx,
    // A deck uploaded by an older build has no snapshot descriptor at all.
    source: deck.files.source ?? null,
    additionalFiles: deck.files.additionalFiles ?? null,
    slideCount: deck.slideCount,
    songTitles: deck.songTitles,
    savedAt: deck.savedAt,
    updatedAt: deck.updatedAt,
    ...(syncPending ? { syncPending: true } : {}),
  };
}

export function summarizeSavedDeck(deck: SavedDeck): SavedDeckSummary {
  const files = filesForDeck(deck);
  return {
    id: deck.id,
    name: deck.name,
    pptx: files.pptx,
    contiPdf: files.contiPdf,
    sermonPptx: files.sermonPptx,
    source: files.source,
    additionalFiles: files.additionalFiles ?? null,
    slideCount: deck.slideCount,
    songTitles: deck.songTitles,
    savedAt: deck.savedAt,
    updatedAt: deck.updatedAt || deck.savedAt,
    ...(deck.syncPending ? { syncPending: true } : {}),
  };
}

function fileForKind(deck: SavedDeck, kind: SavedFileKind): SavedFile | null {
  return deck[kind] ?? null;
}

async function inBatches<T>(items: T[], run: (item: T) => Promise<void>): Promise<void> {
  for (let index = 0; index < items.length; index += TRANSFER_CONCURRENCY) {
    await Promise.all(items.slice(index, index + TRANSFER_CONCURRENCY).map(run));
  }
}

async function uploadDeckToCloud(deck: SavedDeck): Promise<RemoteDeckMetadata> {
  const files = filesForDeck(deck);
  const totalBytes = SAVED_FILE_KINDS.reduce((sum, kind) => sum + (files[kind]?.size ?? 0), 0);
  if (files.pptx.size === 0) throw new Error('빈 PPTX 파일은 동기화할 수 없습니다.');
  if (totalBytes > MAX_PPT_LIBRARY_BYTES) {
    throw new Error('PPT와 원본 파일의 합계가 공유 라이브러리의 항목당 100MB 한도를 초과합니다.');
  }

  const uploadId = crypto.randomUUID();
  await cloudLibraryJson(`/libraries/ppt/uploads/${uploadId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ uploadId, deckId: deck.id, files }),
  }, true);

  const chunks: { kind: SavedFileKind; index: number; data: ArrayBuffer }[] = [];
  for (const kind of SAVED_FILE_KINDS) {
    const file = fileForKind(deck, kind);
    if (!file) continue;
    const count = Math.max(1, Math.ceil(file.data.byteLength / PPT_LIBRARY_CHUNK_BYTES));
    for (let index = 0; index < count; index += 1) {
      const start = index * PPT_LIBRARY_CHUNK_BYTES;
      chunks.push({ kind, index, data: file.data.slice(start, Math.min(file.data.byteLength, start + PPT_LIBRARY_CHUNK_BYTES)) });
    }
  }

  await inBatches(chunks, async ({ kind, index, data }) => {
    await cloudLibraryRequest(
      `/libraries/ppt/uploads/${uploadId}/files/${kind}/chunks/${index}`,
      { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: data },
      true,
    );
  });

  const response = await cloudLibraryJson<{ deck: RemoteDeckMetadata }>(`/libraries/ppt/${deck.id}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      deck: {
        id: deck.id,
        uploadId,
        name: deck.name,
        files,
        slideCount: deck.slideCount,
        songTitles: deck.songTitles,
        savedAt: deck.savedAt,
      },
    }),
  }, true);
  return response.deck;
}

async function fetchRemoteLibrary(): Promise<RemoteLibrarySnapshot> {
  return cloudLibraryJson<RemoteLibrarySnapshot>('/libraries/ppt', {
    method: 'GET',
    headers: { Accept: 'application/json' },
  });
}

async function fetchRemoteDeck(id: string): Promise<RemoteDeckMetadata> {
  const response = await cloudLibraryJson<{ deck: RemoteDeckMetadata }>(`/libraries/ppt/${id}`, {
    method: 'GET',
    headers: { Accept: 'application/json' },
  });
  return response.deck;
}

async function downloadRemoteFile(deck: RemoteDeckMetadata, kind: SavedFileKind): Promise<SavedFile | null> {
  const metadata = deck.files[kind];
  if (!metadata) return null;
  const chunks = new Array<ArrayBuffer>(metadata.chunkCount);
  await inBatches(Array.from({ length: metadata.chunkCount }, (_, index) => index), async (index) => {
    const response = await cloudLibraryRequest(
      `/libraries/ppt/${deck.id}/files/${kind}/chunks/${index}`,
      { method: 'GET', headers: { Accept: 'application/octet-stream' } },
    );
    chunks[index] = await response.arrayBuffer();
  });
  const data = new Uint8Array(metadata.size);
  let offset = 0;
  for (const chunk of chunks) {
    const bytes = new Uint8Array(chunk);
    data.set(bytes, offset);
    offset += bytes.byteLength;
  }
  if (offset !== metadata.size) throw new Error(`${metadata.name} 파일 크기가 서버 기록과 일치하지 않습니다.`);
  return { name: metadata.name, data: data.buffer };
}

async function downloadRemoteDeck(metadata: RemoteDeckMetadata): Promise<SavedDeck> {
  const [pptx, contiPdf, sermonPptx, source, additionalFiles] = await Promise.all([
    downloadRemoteFile(metadata, 'pptx'),
    downloadRemoteFile(metadata, 'contiPdf'),
    downloadRemoteFile(metadata, 'sermonPptx'),
    downloadRemoteFile(metadata, 'source'),
    downloadRemoteFile(metadata, 'additionalFiles'),
  ]);
  if (!pptx) throw new Error('공유 라이브러리에서 PPTX 파일을 찾지 못했습니다.');
  const deck: SavedDeck = {
    id: metadata.id,
    name: metadata.name,
    pptx,
    contiPdf,
    sermonPptx,
    source,
    additionalFiles,
    slideCount: metadata.slideCount,
    songTitles: metadata.songTitles,
    savedAt: metadata.savedAt,
    updatedAt: metadata.updatedAt,
  };
  await putLocalDeck(deck);
  return deck;
}

interface DeckIdentity {
  id: string;
  name: string;
  savedAt: string;
}

/**
 * Every entry this device can see: the IndexedDB cache plus cloud metadata, so
 * a deck saved on another device is still overwritten instead of duplicated.
 * Falls back to the local cache alone when the shared library is unreachable.
 */
async function knownDecks(): Promise<DeckIdentity[]> {
  const decks = new Map<string, DeckIdentity>();
  for (const deck of await listLocalDecks()) {
    decks.set(deck.id, { id: deck.id, name: deck.name, savedAt: deck.savedAt });
  }
  if (hasCloudLibrary()) {
    try {
      const snapshot = await fetchRemoteLibrary();
      for (const id of snapshot.deletedIds) decks.delete(id);
      for (const deck of snapshot.decks) decks.set(deck.id, { id: deck.id, name: deck.name, savedAt: deck.savedAt });
    } catch {
      // Offline or server down: the local cache is the best list available.
    }
  }
  return [...decks.values()];
}

/**
 * Collapse leftover same-name entries into the one just written. Only reachable
 * for duplicates saved before same-name writes overwrote, or when a rename
 * lands on another entry's name. Failures here never fail the save itself.
 */
async function removeSupersededDecks(decks: DeckIdentity[]): Promise<void> {
  for (const deck of decks) {
    try {
      await deleteSavedDeck(deck.id);
    } catch {
      // Keeping the stale copy is better than losing the write that replaced it.
    }
  }
}

/** Confirm the bytes are a loadable .pptx before archiving them. */
export async function inspectDeckBytes(data: ArrayBuffer | Uint8Array): Promise<{ slideCount: number }> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(data);
  } catch {
    throw new Error('PPTX 파일을 읽지 못했습니다.');
  }
  const slideCount = Object.keys(zip.files).filter((file) => /^ppt\/slides\/slide\d+\.xml$/.test(file)).length;
  return { slideCount };
}

/**
 * Save a generated deck. Saving under a name the library already holds replaces
 * that entry — same ID, new bytes — instead of leaving two copies behind.
 *
 * `replaceId` targets one specific entry regardless of its name, which is how
 * 편집 writes a reopened deck back: the entry keeps its identity even when the
 * edit renamed it, and any other entry now sharing that name gives way.
 */
export async function saveDeckToLibrary(entry: SavedDeckInput, replaceId?: string): Promise<SavedDeckResult> {
  const sameName = decksWithSameName(await knownDecks(), entry.name, replaceId);
  const [existing, ...rest] = sameName;
  const superseded = replaceId ? sameName : rest;
  const now = new Date().toISOString();
  let saved: SavedDeck = {
    ...entry,
    id: replaceId ?? existing?.id ?? crypto.randomUUID(),
    savedAt: now,
    updatedAt: now,
  };
  await putLocalDeck(saved);
  await removeSupersededDecks(superseded);
  const replaced = replaceId ? sameName.length : existing ? rest.length + 1 : 0;
  if (!hasCloudLibrary()) return { deck: saved, replaced };
  try {
    const remote = await uploadDeckToCloud(saved);
    saved = { ...saved, updatedAt: remote.updatedAt, syncPending: false };
  } catch {
    saved = { ...saved, syncPending: true };
  }
  await putLocalDeck(saved);
  return { deck: saved, replaced };
}

/**
 * List cloud metadata without eagerly downloading every multi-megabyte file.
 * Existing browser-only records are uploaded automatically. Tombstones from
 * another device remove stale IndexedDB copies instead of resurrecting them.
 */
export async function listSavedDecks(): Promise<PptLibrarySnapshot> {
  let local = await listLocalDecks();
  if (!hasCloudLibrary()) {
    return { decks: local.map(summarizeSavedDeck), sync: 'local' };
  }

  try {
    const remoteSnapshot = await fetchRemoteLibrary();
    const deleted = new Set(remoteSnapshot.deletedIds);
    for (const id of deleted) await deleteLocalDeck(id);
    local = local.filter((deck) => !deleted.has(deck.id));

    const remote = new Map(remoteSnapshot.decks.map((deck) => [deck.id, deck]));
    const pending = new Map<string, SavedDeck>();
    const errors: string[] = [];
    for (const deck of local) {
      const cloudDeck = remote.get(deck.id);
      const needsUpload = !cloudDeck || deck.updatedAt > cloudDeck.updatedAt || deck.syncPending;
      if (!needsUpload) continue;
      try {
        const uploaded = await uploadDeckToCloud(deck);
        remote.set(deck.id, uploaded);
        const cached = { ...deck, updatedAt: uploaded.updatedAt, syncPending: false };
        await putLocalDeck(cached);
      } catch (error) {
        pending.set(deck.id, { ...deck, syncPending: true });
        errors.push(error instanceof Error ? error.message : String(error));
      }
    }

    const decks = [...remote.values()].map((deck) => summaryFromRemote(deck));
    for (const deck of pending.values()) {
      const index = decks.findIndex((candidate) => candidate.id === deck.id);
      const summary = summarizeSavedDeck(deck);
      if (index === -1) decks.push(summary);
      else decks[index] = summary;
    }
    decks.sort((a, b) => b.savedAt.localeCompare(a.savedAt));
    return {
      decks,
      sync: errors.length > 0 ? 'pending' : 'synced',
      ...(errors.length > 0 ? { message: errors[0] } : {}),
    };
  } catch (error) {
    return {
      decks: local.map((deck) => ({ ...summarizeSavedDeck(deck), syncPending: true })),
      sync: 'pending',
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Load one full deck on demand, preferring whichever copy is newer. */
export async function getSavedDeck(id: string): Promise<SavedDeck> {
  const local = await getLocalDeck(id);
  if (!hasCloudLibrary()) {
    if (local) return local;
    throw new Error('저장된 PPT를 찾지 못했습니다.');
  }
  try {
    const remote = await fetchRemoteDeck(id);
    if (local && local.updatedAt >= remote.updatedAt) return local;
    return await downloadRemoteDeck(remote);
  } catch (error) {
    if (local) return local;
    throw error;
  }
}

export async function getSavedDeckFile(id: string, kind: SavedFileKind): Promise<SavedFile | null> {
  return fileForKind(await getSavedDeck(id), kind);
}

export async function deleteSavedDeck(id: string): Promise<void> {
  if (hasCloudLibrary()) {
    await cloudLibraryJson(`/libraries/ppt/${id}`, { method: 'DELETE' }, true);
  }
  await deleteLocalDeck(id);
}
