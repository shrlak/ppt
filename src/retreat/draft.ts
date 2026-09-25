// Keeps the retreat being prepared on this machine, so a reload — or a laptop
// closing mid-preparation — loses nothing. The order of service and lyrics
// are small JSON in localStorage; each session's poster is an image, kept in
// IndexedDB under the session's id. The PPT 라이브러리 copy saved with each
// download is the durable, cross-device one.
import { attachPosters, decodeRetreatState, encodeRetreatSource } from './source';
import type { RetreatState } from './types';

const DRAFT_KEY = 'retreat-draft-v1';
const DB_NAME = 'kccp-retreat';
const STORE = 'posters';

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
    request.onerror = () => resolve(null);
  });
}

async function withStore<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T | null> {
  const db = await openDb();
  if (!db) return null;
  try {
    return await new Promise<T | null>((resolve) => {
      const request = run(db.transaction(STORE, mode).objectStore(STORE));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
    });
  } finally {
    db.close();
  }
}

export async function saveRetreatDraft(state: RetreatState): Promise<void> {
  try {
    const file = encodeRetreatSource(state);
    localStorage.setItem(DRAFT_KEY, new TextDecoder().decode(file.data));
  } catch {
    // Private windows and full quotas still leave the session usable.
  }
  for (const session of state.sessions) {
    if (session.poster) await withStore('readwrite', (store) => store.put(session.poster!.data, session.id));
  }
}

export async function loadRetreatDraft(): Promise<RetreatState | null> {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(DRAFT_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  let decoded: ReturnType<typeof decodeRetreatState> = null;
  try {
    decoded = decodeRetreatState(JSON.parse(raw));
  } catch {
    return null;
  }
  if (!decoded) return null;
  const posters = new Map<string, ArrayBuffer>();
  for (const session of decoded.state.sessions) {
    if (!session.poster) continue;
    const data = await withStore<ArrayBuffer>('readonly', (store) => store.get(session.id) as IDBRequest<ArrayBuffer>);
    if (data) posters.set(session.id, data);
  }
  return attachPosters(decoded.state, posters);
}

export async function clearRetreatDraft(sessionIds: string[]): Promise<void> {
  try {
    localStorage.removeItem(DRAFT_KEY);
  } catch {
    // nothing to clear
  }
  for (const id of sessionIds) await withStore('readwrite', (store) => store.delete(id));
}
