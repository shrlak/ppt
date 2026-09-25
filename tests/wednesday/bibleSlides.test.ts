import { describe, expect, it } from 'vitest';
import { verseLine } from '../../src/wednesday/bibleSlides';
import { countVerses } from '../../src/wednesday/passage';

describe('말씀 본문 verse numbers', () => {
  it('prefixes a verse with its number', () => {
    expect(verseLine({ chapter: 18, verse: 7, text: '이에 땅이 진동하고' })).toBe('7 이에 땅이 진동하고');
  });

  it('prefixes a joined verse with both of its numbers', () => {
    expect(verseLine({ chapter: 6, verse: 18, endVerse: 19, text: '여호와께서 보시기에' })).toBe('18-19 여호와께서 보시기에');
  });

  it('counts every verse number a joined verse covers', () => {
    expect(
      countVerses([
        { chapter: 92, verse: 1, endVerse: 3, text: '지존자여' },
        { chapter: 92, verse: 4, text: '여호와여' },
      ]),
    ).toBe(4);
  });
});
