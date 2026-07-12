// Persistence for administrator-replaced front/back slide decks. The app is a
// static site, so replacements live in the browser's IndexedDB (the decks are
// multi-megabyte, beyond localStorage limits) and override the bundled
// public/front-slides.pptx and public/back-slides.pptx at generation time.
import JSZip from 'jszip';

export type DeckSlot = 'front' | 'back';

export interface StoredDeck {
  name: string;
  data: ArrayBuffer;
  slideCount: number;
  updatedAt: string;
}

const DB_NAME = 'kccp-ppt';
const STORE = 'decks';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
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

/** Count the slides in a .pptx and confirm it is a loadable presentation. */
export async function inspectDeck(data: ArrayBuffer): Promise<{ slideCount: number }> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(data);
  } catch {
    throw new Error('PPTX 파일을 읽지 못했습니다. 올바른 .pptx 파일인지 확인해 주세요.');
  }
  if (!zip.file('ppt/presentation.xml')) {
    throw new Error('프레젠테이션이 아닌 파일입니다 (ppt/presentation.xml 없음).');
  }
  const slideCount = Object.keys(zip.files).filter((f) => /^ppt\/slides\/slide\d+\.xml$/.test(f)).length;
  if (slideCount === 0) throw new Error('슬라이드가 없는 프레젠테이션입니다.');
  return { slideCount };
}

export async function getCustomDeck(slot: DeckSlot): Promise<StoredDeck | null> {
  try {
    const value = await withStore<StoredDeck | undefined>('readonly', (store) => store.get(slot));
    return value ?? null;
  } catch {
    return null; // e.g. IndexedDB unavailable in private browsing — fall back to bundled decks
  }
}

export async function setCustomDeck(slot: DeckSlot, name: string, data: ArrayBuffer): Promise<StoredDeck> {
  const { slideCount } = await inspectDeck(data);
  const deck: StoredDeck = { name, data, slideCount, updatedAt: new Date().toISOString() };
  await withStore('readwrite', (store) => store.put(deck, slot));
  return deck;
}

export async function clearCustomDeck(slot: DeckSlot): Promise<void> {
  await withStore('readwrite', (store) => store.delete(slot));
}
