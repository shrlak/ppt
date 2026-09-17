import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  deleteSongEntry,
  findSongEntry,
  loadSongLibrary,
  saveSongEntry,
  searchSongEntries,
  upsertSongEntry,
  type WednesdaySongEntry,
} from '../../src/wednesday/songLibrary';

/** The browser store the library keeps its local copy in. */
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

const entry = (title: string, sourceUrl?: string): WednesdaySongEntry => ({ title, sourceUrl });

beforeEach(() => {
  vi.stubGlobal('localStorage', memoryLocalStorage());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('upsertSongEntry', () => {
  it('replaces by title identity rather than adding a near-duplicate', () => {
    const entries = upsertSongEntry(
      [entry('주님의  사랑', 'https://blogfiles.pstatic.net/a.pptx')],
      entry('주님의 사랑!', 'https://blogfiles.pstatic.net/b.pptx'),
    );
    expect(entries).toHaveLength(1);
    expect(entries[0].sourceUrl).toBe('https://blogfiles.pstatic.net/b.pptx');
  });

  it('keeps the list sorted so the picker reads in order', () => {
    const entries = upsertSongEntry(upsertSongEntry([], entry('하늘 위에')), entry('나의 반석'));
    expect(entries.map((item) => item.title)).toEqual(['나의 반석', '하늘 위에']);
  });
});

describe('findSongEntry / searchSongEntries', () => {
  const entries = [entry('나의 반석이신 하나님'), entry('하늘 위에 주님 밖에')];

  it('finds a song however its title was typed', () => {
    expect(findSongEntry(entries, '나의반석이신하나님')?.title).toBe('나의 반석이신 하나님');
    expect(findSongEntry(entries, '없는 곡')).toBeUndefined();
    expect(findSongEntry(entries, '  ')).toBeUndefined();
  });

  it('matches a partial title and caps the list', () => {
    expect(searchSongEntries(entries, '주님').map((item) => item.title)).toEqual(['하늘 위에 주님 밖에']);
    expect(searchSongEntries(entries, '')).toHaveLength(2);
    expect(searchSongEntries(entries, '', 1)).toHaveLength(1);
  });
});

describe('saving a song', () => {
  it('keeps the title, the address and the slide count — never the file', async () => {
    const entries = await saveSongEntry({
      title: '나의 반석이신 하나님',
      sourceUrl: 'https://blogfiles.pstatic.net/a.pptx',
      sourceHost: 'blogfiles.pstatic.net',
      slideCount: 6,
    });

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      title: '나의 반석이신 하나님',
      sourceUrl: 'https://blogfiles.pstatic.net/a.pptx',
      slideCount: 6,
    });
    expect(entries[0].updatedAt).toBeTruthy();
    // Reading it back comes from the browser's own copy.
    expect(loadSongLibrary()).toHaveLength(1);
    expect(JSON.stringify(entries[0])).not.toContain('deck');
  });

  it('drops an address that is not an https link', async () => {
    const entries = await saveSongEntry({ title: '직접 올린 곡', sourceUrl: 'file:///tmp/a.pptx' });
    expect(entries[0].sourceUrl).toBeUndefined();
  });

  it('forgets a song on request', async () => {
    await saveSongEntry({ title: '지울 곡' });
    expect(await deleteSongEntry('지울  곡!')).toEqual([]);
    expect(loadSongLibrary()).toEqual([]);
  });

  it('starts empty when the browser store cannot be read', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
      removeItem: () => undefined,
    });
    expect(loadSongLibrary()).toEqual([]);
  });
});
