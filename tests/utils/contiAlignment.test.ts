import { describe, expect, it } from 'vitest';
import {
  alignPagesToConti,
  lyricsLookupTitle,
  titleSimilarity,
} from '../../src/lib/utils/contiAlignment';

describe('titleSimilarity', () => {
  it('ignores spacing and punctuation', () => {
    expect(titleSimilarity('주 은혜임을', '주은혜임을')).toBe(1);
  });

  it('treats a contained title as the same song', () => {
    expect(titleSimilarity('시선', '내게로부터 눈을 들어 (시선)')).toBeGreaterThanOrEqual(0.6);
  });

  it('keeps different songs apart', () => {
    expect(titleSimilarity('주님의 사랑', '매일매일')).toBeLessThan(0.6);
  });
});

describe('alignPagesToConti', () => {
  it('leaves pages alone when every page already carries its song', () => {
    expect(alignPagesToConti(['A곡', 'B곡', 'C곡'], ['A곡', 'B곡', 'C곡'])).toEqual([0, 1, 2]);
  });

  it('takes a spare page only for a song whose title is on it', () => {
    // Four listed songs, then two pages the order does not list. 그 사랑's
    // score was printed over two pages, so every later song sits one late.
    const songs = ['주 신실하심 놀라워', '그 사랑', '우리가 넉넉히 이기느니라', '임재'];
    const pages = ['주 신실하심 놀라워', '그 사랑', '', '우리가 넉넉히 이기느니라', '임재', '우리는 주의 움직이는 교회'];
    const slots = alignPagesToConti(songs, pages);
    expect(slots).toEqual([0, 1, 3, 4]);
    expect(new Set(slots).size).toBe(songs.length);
  });

  it('leaves the spare pages alone when every song is on its own page', () => {
    expect(alignPagesToConti(['A곡', 'B곡'], ['A곡', 'B곡', '영접송', '고백송'])).toEqual([0, 1]);
  });

  it('keeps an unnamed song on its own page rather than a spare', () => {
    expect(alignPagesToConti(['새 찬양 (1번)', 'B곡'], ['무슨 곡', 'B곡', 'C곡'])).toEqual([0, 1]);
  });

  it('puts pages scanned out of order back in conti order', () => {
    const songs = ['주님의 사랑', '주 은혜임을', '매일매일'];
    const pages = ['매일매일', '주님의 사랑', '주 은혜임을'];
    const slots = alignPagesToConti(songs, pages);
    expect(slots.map((slot) => pages[slot])).toEqual(songs);
  });

  it('finds a song by the English title its conti printed beside the Korean one', () => {
    // 좋으신 하나님's 악보 prints only "You Are Good"; the page it was handed
    // in PDF order is the second page of the song before it.
    const songs = ['Call on Jesus', '좋으신 하나님'];
    const pages = ['Call On Jesus', undefined, 'You Are Good'];
    expect(alignPagesToConti(songs, pages)).toEqual([0, 1]);
    expect(alignPagesToConti(songs, pages, [undefined, 'You are Good'])).toEqual([0, 2]);
  });

  it('moves every later song back after a two-page score shifted them', () => {
    // Cover: 3 songs. PDF: the first song's score takes two pages, so the
    // extra page became a trailing placeholder card.
    const songs = ['주님의 사랑', '주 은혜임을', '매일매일', '새 찬양 (p.5)'];
    const pages = ['주님의 사랑', undefined, '주 은혜임을', '매일매일'];
    const slots = alignPagesToConti(songs, pages);
    expect(slots).toEqual([0, 2, 3, 1]);
  });

  it('never drops or shares a page', () => {
    const slots = alignPagesToConti(['가', '나', '다'], ['다', '다', undefined]);
    expect([...slots].sort()).toEqual([0, 1, 2]);
  });

  it('keeps the conti pairing when no title could be read', () => {
    expect(alignPagesToConti(['A곡', 'B곡'], [undefined, undefined])).toEqual([0, 1]);
  });
});

describe('lyricsLookupTitle', () => {
  it('searches by the title the conti printed', () => {
    expect(lyricsLookupTitle('주 은혜임을', '주 은혜 임을')).toBe('주 은혜임을');
  });

  it('falls back to the title read off the score for an unnamed page', () => {
    expect(lyricsLookupTitle('새 찬양 (p.3)', '매일매일')).toBe('매일매일');
  });
});
