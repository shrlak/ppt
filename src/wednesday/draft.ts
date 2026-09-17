// Keeps this week's 수요예배 inputs on the machine, so a reload — or a laptop
// closing mid-preparation — does not lose the work.
//
// Two stores, because the shapes are different: the service details and the
// song list are small JSON and live in localStorage, while each song's .pptx
// is megabytes of binary and lives in IndexedDB under the song's id. The
// shared 라이브러리 save (deckAutoSave) is the durable, cross-device copy; this
// is only the local draft that makes a refresh free.
import type { WednesdayService, WednesdaySong } from './types';
import { emptyWednesdayService } from './types';

const DRAFT_KEY = 'wednesday-draft-v1';
const DB_NAME = 'kccp-wednesday';
const STORE = 'song-decks';

interface StoredSong {
  id: string;
  title: string;
  slideCount?: number;
  origin?: WednesdaySong['origin'];
  sourceUrl?: string;
  sourceHost?: string;
  fileName?: string;
}

interface StoredDraft {
  version: 1;
  service: WednesdayService;
  songs: StoredSong[];
  /** Library entry this draft is bound to, so auto-save keeps updating it. */
  deckId?: string;
  fileNameOverride?: string;
}

export interface WednesdayDraft {
  service: WednesdayService;
  songs: WednesdaySong[];
  deckId?: string;
  fileNameOverride?: string;
}

function openDb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') {
      resolve(null);
      return;
    }
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
    // A blocked or disabled IndexedDB is not worth failing the page over: the
    // draft is a convenience, and the titles still come back from localStorage.
    request.onerror = () => resolve(null);
  });
}

async function withStore<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T | null> {
  const db = await openDb();
  if (!db) return null;
  try {
    return await new Promise<T | null>((resolve) => {
      const tx = db.transaction(STORE, mode);
      const request = run(tx.objectStore(STORE));
      request.onsuccess = () => resolve(request.result ?? null);
      request.onerror = () => resolve(null);
    });
  } finally {
    db.close();
  }
}

async function putDeck(id: string, deck: ArrayBuffer): Promise<void> {
  await withStore('readwrite', (store) => store.put(deck, id) as IDBRequest<unknown>);
}

async function getDeck(id: string): Promise<ArrayBuffer | null> {
  return withStore('readonly', (store) => store.get(id) as IDBRequest<ArrayBuffer>);
}

async function deleteDeck(id: string): Promise<void> {
  await withStore('readwrite', (store) => store.delete(id) as IDBRequest<undefined>);
}

/** Save the draft, including each attached song's file. */
export async function saveWednesdayDraft(draft: WednesdayDraft): Promise<void> {
  const stored: StoredDraft = {
    version: 1,
    service: draft.service,
    songs: draft.songs.map((song) => ({
      id: song.id,
      title: song.title,
      slideCount: song.slideCount,
      origin: song.origin,
      sourceUrl: song.sourceUrl,
      sourceHost: song.sourceHost,
      fileName: song.fileName,
    })),
    deckId: draft.deckId,
    fileNameOverride: draft.fileNameOverride,
  };

  try {
    localStorage.setItem(DRAFT_KEY, JSON.stringify(stored));
  } catch {
    // Private windows and full quotas both land here; the session still works.
  }

  for (const song of draft.songs) {
    if (song.deck) await putDeck(song.id, song.deck);
  }
}

/** Read the draft back, reattaching each song's .pptx where it is still stored. */
export async function loadWednesdayDraft(): Promise<WednesdayDraft | null> {
  let stored: StoredDraft | null = null;
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    stored = raw ? (JSON.parse(raw) as StoredDraft) : null;
  } catch {
    stored = null;
  }
  if (!stored || stored.version !== 1) return null;

  const songs: WednesdaySong[] = [];
  for (const song of stored.songs ?? []) {
    const deck = (await getDeck(song.id)) ?? undefined;
    songs.push({
      ...song,
      deck,
      // A deck that did not come back cannot contribute slides.
      slideCount: deck ? song.slideCount : undefined,
    });
  }

  return {
    service: { ...emptyWednesdayService(), ...stored.service },
    songs,
    deckId: stored.deckId,
    fileNameOverride: stored.fileNameOverride,
  };
}

/** Forget a song's stored file — called when the song leaves the list. */
export async function forgetWednesdaySongDeck(id: string): Promise<void> {
  await deleteDeck(id);
}

export async function clearWednesdayDraft(songIds: string[]): Promise<void> {
  try {
    localStorage.removeItem(DRAFT_KEY);
  } catch {
    // Nothing to clean up if it was never written.
  }
  for (const id of songIds) await deleteDeck(id);
}
