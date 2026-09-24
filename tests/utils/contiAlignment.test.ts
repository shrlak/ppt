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

  it('puts pages scanned out of order back in conti order', () => {
    const songs = ['주님의 사랑', '주 은혜임을', '매일매일'];
    const pages = ['매일매일', '주님의 사랑', '주 은혜임을'];
    const slots = alignPagesToConti(songs, pages);
    expect(slots.map((slot) => pages[slot])).toEqual(songs);
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
