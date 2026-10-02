import { afterEach, describe, expect, it, vi } from 'vitest';
import { lookupConfessionSong, lookupDeckConfessionSong, songFromLibraryEntry } from '../../src/lib/utils/confessionSong';
import type { LibraryEntry } from '../../src/lib/utils/types';

const bundled: LibraryEntry[] = [
  {
    title: 'Celebrate the Light',
    key: 'G',
    sections: [
      { label: 'V1', lines: ['우리에게 임하신 그의 빛으로 난', '내 안의 어둠 사라져 새롭게 됐네'] },
      { label: 'C', lines: ['Celebrate the light 온 세상 비추네'] },
    ],
    order: ['V1', 'C'],
  },
  { title: '가사 없는 곡', sections: [], order: [] },
];

function stubLibrary(entries: LibraryEntry[] = bundled) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify(entries), { status: 200 })),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('lookupConfessionSong', () => {
  it('resolves the configured title to the library song and its slide count', async () => {
    stubLibrary();
    const found = await lookupConfessionSong('/', 'celebrate the light');
    expect(found.title).toBe('celebrate the light');
    // The library entry's own title is what gets printed, not what was typed.
    expect(found.song?.title).toBe('Celebrate the Light');
    expect(found.song?.sections).toHaveLength(2);
    expect(found.slideCount).toBe(2);
  });

  it('resolves to no song when the library has no lyrics under that title', async () => {
    stubLibrary();
    await expect(lookupConfessionSong('/', '아직 저장 안 한 곡')).resolves.toMatchObject({
      title: '아직 저장 안 한 곡',
      song: null,
      slideCount: 0,
    });
    // Present but empty is the same answer: there is nothing to print.
    await expect(lookupConfessionSong('/', '가사 없는 곡')).resolves.toMatchObject({
      song: null,
      slideCount: 0,
    });
  });

  it('treats a blank setting as "leave the back slides as supplied"', async () => {
    stubLibrary();
    await expect(lookupConfessionSong('/', '   ')).resolves.toEqual({
      title: '',
      song: null,
      slideCount: 0,
    });
  });
});

describe('songFromLibraryEntry', () => {
  it('copies the lyrics rather than sharing them with the library entry', () => {
    const song = songFromLibraryEntry(bundled[0]);
    song.sections[0].lines[0] = '고친 가사';
    song.order.push('C');
    expect(bundled[0].sections[0].lines[0]).toBe('우리에게 임하신 그의 빛으로 난');
    expect(bundled[0].order).toEqual(['V1', 'C']);
  });
});

describe('lookupDeckConfessionSong', () => {
  const weekly: LibraryEntry = {
    title: '우리는 주의 움직이는 교회',
    key: 'G',
    sections: [{ label: 'V', lines: ['우리는 주의 움직이는 교회'] }],
    order: ['V'],
  };

  it("prints the notice's 고백송 when the library has its lyrics", async () => {
    stubLibrary([...bundled, weekly]);
    const found = await lookupDeckConfessionSong('/', '우리는 주의 움직이는 교회');
    expect(found.song?.title).toBe('우리는 주의 움직이는 교회');
  });

  it('falls back to the 관리자 설정 song when the notice names one the library lacks', async () => {
    stubLibrary();
    const found = await lookupDeckConfessionSong('/', '아직 저장 안 한 곡');
    expect(found.song?.title).toBe('Celebrate the Light');
  });

  it('uses the 관리자 설정 song when no notice names one', async () => {
    stubLibrary();
    expect((await lookupDeckConfessionSong('/')).song?.title).toBe('Celebrate the Light');
  });
});
