import { describe, expect, it } from 'vitest';
import { buildDeckOverview } from '../../src/lib/utils/deckOverview';
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

describe('buildDeckOverview', () => {
  it('lists slides in the exact generate() sequence: front, 찬양, 기도, 성경말씀, 설교, 기도, 광고, back', () => {
    const items = buildDeckOverview({
      songs: [song],
      frontSlideCount: 4,
      backSlideCount: 21,
      bibleVerseCount: 3,
      sermonFileName: '설교.pptx',
      announcementItems: [{ title: '새가족 환영', bodyLines: ['환영합니다'] }],
    });

    expect(items.map((i) => i.kind)).toEqual([
      'front',
      'lyrics-title',
      'lyrics', // V1 (its own section, its own slide)
      'lyrics', // C (a separate section never shares a slide with V1)
      'prayer',
      'bible',
      'sermon',
      'prayer',
      'announcement',
      'back',
    ]);
    expect(items[0].subtitle).toBe('4장');
    expect(items[1].label).toBe('주님의 사랑');
    expect(items[5].subtitle).toBe('3구절');
    expect(items[6].subtitle).toBe('설교.pptx');
    expect(items[8].label).toBe('새가족 환영');
    expect(items[9].subtitle).toBe('21장');
  });

  it('omits the 성경 말씀 and 설교 rows entirely when there is no content for them', () => {
    const items = buildDeckOverview({
      songs: [],
      frontSlideCount: 4,
      backSlideCount: 21,
      bibleVerseCount: 0,
      sermonFileName: undefined,
      announcementItems: [],
    });
    expect(items.map((i) => i.kind)).toEqual(['front', 'prayer', 'prayer', 'back']);
  });

  it('gives every song its own title row followed by its lyric-slide rows', () => {
    const second: Song = { ...song, id: 's2', title: '두번째 곡' };
    const items = buildDeckOverview({
      songs: [song, second],
      frontSlideCount: 4,
      backSlideCount: 21,
      bibleVerseCount: 0,
      announcementItems: [],
    });
    const titles = items.filter((i) => i.kind === 'lyrics-title').map((i) => i.label);
    expect(titles).toEqual(['주님의 사랑', '두번째 곡']);
    expect(items.filter((i) => i.songId === 's1')).toHaveLength(3); // 1 title + V1 slide + C slide
  });

  it('falls back to a placeholder label for a song with a blank title', () => {
    const blank: Song = { ...song, title: '   ' };
    const items = buildDeckOverview({
      songs: [blank],
      frontSlideCount: 4,
      backSlideCount: 21,
      bibleVerseCount: 0,
      announcementItems: [],
    });
    expect(items[1].label).toBe('(제목 없음)');
  });

  it('numbers unnamed announcements positionally', () => {
    const items = buildDeckOverview({
      songs: [],
      frontSlideCount: 4,
      backSlideCount: 21,
      bibleVerseCount: 0,
      announcementItems: [{ title: '', bodyLines: [] }],
    });
    const announcement = items.find((i) => i.kind === 'announcement');
    expect(announcement?.label).toBe('광고 1');
  });
});
