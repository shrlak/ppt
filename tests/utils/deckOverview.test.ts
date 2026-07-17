import { describe, expect, it } from 'vitest';
import { expandDeckSegment, songOverviewItems } from '../../src/lib/utils/deckOverview';
import type { Song } from '../../src/lib/utils/types';

const song: Song = {
  id: 's1',
  title: '주님의 사랑',
  sections: [
    { label: 'V1', lines: ['첫째 줄', '둘째 줄'] },
    { label: 'C', lines: ['후렴 줄'] },
  ],
  order: ['I', 'V1', 'C'],
  linesPerSlide: 4,
};

describe('songOverviewItems', () => {
  it('gives a title row followed by one row per real planSlides() slide, so it never drifts from the generator', () => {
    const items = songOverviewItems(song);
    expect(items.map((i) => i.kind)).toEqual(['lyrics-title', 'lyrics', 'lyrics']);
    expect(items.every((i) => i.songId === 's1')).toBe(true);
    expect(items.every((i) => i.label === '주님의 사랑')).toBe(true);
    expect(items[1].subtitle).toBe('첫째 줄 / 둘째 줄');
    expect(items[2].subtitle).toBe('후렴 줄');
  });

  it('falls back to a placeholder label for a song with a blank title', () => {
    const blank: Song = { ...song, title: '   ' };
    expect(songOverviewItems(blank)[0].label).toBe('(제목 없음)');
  });

  it('scopes each row id to its own song, so two songs never collide', () => {
    const second: Song = { ...song, id: 's2', title: '두번째 곡' };
    expect(songOverviewItems(song).every((i) => i.id.startsWith('song-s1-'))).toBe(true);
    expect(songOverviewItems(second).every((i) => i.id.startsWith('song-s2-'))).toBe(true);
  });
});

describe('expandDeckSegment', () => {
  it('expands a uniform segment into exactly one row per real slide count', () => {
    const items = expandDeckSegment({
      kind: 'front',
      count: 4,
      labelAt: (i, count) => `Front ${i + 1}/${count}`,
    });
    expect(items.map((i) => i.label)).toEqual(['Front 1/4', 'Front 2/4', 'Front 3/4', 'Front 4/4']);
    expect(items.every((i) => i.kind === 'front')).toBe(true);
  });

  it('produces no rows for a zero-count segment', () => {
    expect(expandDeckSegment({ kind: 'bible', count: 0, labelAt: () => '' })).toEqual([]);
  });

  it('includes a per-row subtitle when subtitleAt is given', () => {
    const items = expandDeckSegment({
      kind: 'sermon',
      count: 2,
      labelAt: (i, count) => `설교 ${i + 1}/${count}`,
      subtitleAt: () => '설교.pptx',
    });
    expect(items.map((i) => i.subtitle)).toEqual(['설교.pptx', '설교.pptx']);
  });
});
