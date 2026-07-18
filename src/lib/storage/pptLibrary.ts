// Persistence for the 라이브러리 (PPT library): a browser-local archive of
// past generated decks, each saved together with the source files that went
// into it (the conti PDF, the sermon PPT) so a whole week's material can be
// found and re-downloaded later. Lives in IndexedDB, like deckStore.ts, since
// entries carry multi-megabyte binaries beyond localStorage's limits.
import JSZip from 'jszip';

export interface SavedFile {
  name: string;
  data: ArrayBuffer;
}

export interface SavedDeck {
  id: string;
  /** User-facing label; defaults to the generated file name. */
  name: string;
  /** The complete generated deck, ready to re-download as-is. */
  pptx: SavedFile;
  /** Source files the deck was built from, kept for reference (optional). */
  contiPdf: SavedFile | null;
  sermonPptx: SavedFile | null;
  slideCount: number;
  songTitles: string[];
  savedAt: string;
}

export type SavedDeckInput = Omit<SavedDeck, 'id' | 'savedAt'>;

const DB_NAME = 'kccp-ppt-library';
const STORE = 'decks';

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

/** Confirm the bytes are a loadable .pptx before archiving them. */
export async function inspectDeckBytes(data: ArrayBuffer): Promise<{ slideCount: number }> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(data);
  } catch {
    throw new Error('PPTX 파일을 읽지 못했습니다.');
  }
  const slideCount = Object.keys(zip.files).filter((f) => /^ppt\/slides\/slide\d+\.xml$/.test(f)).length;
  return { slideCount };
}

export async function saveDeckToLibrary(entry: SavedDeckInput): Promise<SavedDeck> {
  const saved: SavedDeck = { ...entry, id: crypto.randomUUID(), savedAt: new Date().toISOString() };
  await withStore('readwrite', (store) => store.put(saved));
  return saved;
}

/** Overwrite an existing entry in place (rename, and/or replace its pptx bytes/slideCount after editing). */
export async function updateSavedDeck(deck: SavedDeck): Promise<SavedDeck> {
  await withStore('readwrite', (store) => store.put(deck));
  return deck;
}

export async function listSavedDecks(): Promise<SavedDeck[]> {
  try {
    const all = await withStore<SavedDeck[]>('readonly', (store) => store.getAll());
    return all.sort((a, b) => b.savedAt.localeCompare(a.savedAt));
  } catch {
    return []; // e.g. IndexedDB unavailable in private browsing — an empty library, not a crash
  }
}

export async function deleteSavedDeck(id: string): Promise<void> {
  await withStore('readwrite', (store) => store.delete(id));
}
