import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LibraryEntry } from '../../src/lib/utils/types';

const PROXY = 'https://proxy.test';
const QUEUE_KEY = 'praise-lyrics-library-sync-queue-v1';

/** The browser store the library keeps its local copy and its queue in. */
function memoryLocalStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
    clear: () => values.clear(),
    key: (index: number) => [...values.keys()][index] ?? null,
    get length() {
      return values.size;
    },
  };
}

/** A confirmed save, with placeholder lyrics. */
const song = (title: string): LibraryEntry => ({
  title,
  sections: [{ label: 'V', lines: ['가나다라 마바사', '아자차카 타파하'] }],
  order: ['I', 'V'],
  verification: 'verified',
  version: 2,
});

/** Titles the stub server was asked to store, in order. */
function stubServer(answer: (title: string) => Response | Promise<Response>): string[] {
  const sent: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const title = String((JSON.parse(String(init?.body)) as { entry: LibraryEntry }).entry.title);
      sent.push(title);
      return answer(title);
    }),
  );
  return sent;
}

const queued = () => JSON.parse(localStorage.getItem(QUEUE_KEY) ?? '[]') as unknown[];

beforeEach(() => {
  vi.stubGlobal('localStorage', memoryLocalStorage());
  vi.stubEnv('VITE_RECOGNITION_PROXY_URL', PROXY);
  // The queue's in-flight state lives in the module.
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('the shared lyrics upload queue', () => {
  it('says when a save reached the shared library', async () => {
    const sent = stubServer(() => Response.json({ entry: {} }));
    const { queueLyricsUpsert } = await import('../../src/lib/storage/library');
    expect(await queueLyricsUpsert(song('그 사랑'))).toBe('uploaded');
    expect(sent).toEqual(['그 사랑']);
    expect(queued()).toEqual([]);
  });

  it('keeps a save it could not send, to try again later', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('Failed to fetch'))));
    const { queueLyricsUpsert } = await import('../../src/lib/storage/library');
    expect(await queueLyricsUpsert(song('그 사랑'))).toBe('pending');
    expect(queued()).toHaveLength(1);
  });

  it('never lets a save the server refused hold back the saves made after it', async () => {
    // A save from an earlier visit that the server refuses, stuck at the front.
    localStorage.setItem(
      QUEUE_KEY,
      JSON.stringify([{ id: 'earlier', type: 'upsert', titleKey: '거절될곡', entry: song('거절될 곡') }]),
    );
    const sent = stubServer((title) =>
      title === '거절될 곡'
        ? Response.json({ error: 'invalid lyrics entry' }, { status: 400 })
        : Response.json({ entry: {} }),
    );
    const { queueLyricsUpsert } = await import('../../src/lib/storage/library');
    expect(await queueLyricsUpsert(song('그 사랑'))).toBe('uploaded');
    expect(sent).toEqual(['거절될 곡', '그 사랑']);
    expect(queued()).toEqual([]);
  });

  it('says when the server refused the save itself', async () => {
    stubServer(() => Response.json({ error: 'invalid lyrics entry' }, { status: 400 }));
    const { queueLyricsUpsert } = await import('../../src/lib/storage/library');
    expect(await queueLyricsUpsert(song('그 사랑'))).toBe('rejected');
    expect(queued()).toEqual([]);
  });

  it('keeps retrying a save the server turned away for now', async () => {
    stubServer(() => Response.json({ error: 'busy' }, { status: 503 }));
    const { queueLyricsUpsert } = await import('../../src/lib/storage/library');
    expect(await queueLyricsUpsert(song('그 사랑'))).toBe('pending');
    expect(queued()).toHaveLength(1);
  });
});
