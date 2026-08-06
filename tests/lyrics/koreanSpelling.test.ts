import { describe, expect, it } from 'vitest';
import {
  normalizeKoreanLyricLine,
  normalizeKoreanLyricLines,
} from '../../src/lib/lyrics/koreanSpelling';

describe('normalizeKoreanLyricLine', () => {
  it('composes decomposed jamo from scraped pages', () => {
    // NFD Hangul renders identically but breaks every Hangul-aware rule below.
    const decomposed = '주님'.normalize('NFD');
    expect(decomposed).not.toBe('주님');
    expect(normalizeKoreanLyricLine(decomposed)).toBe('주님');
  });

  it('strips zero-width characters and normalizes exotic spaces', () => {
    expect(normalizeKoreanLyricLine('주​님 사랑')).toBe('주님 사랑');
    expect(normalizeKoreanLyricLine('은혜　가운데')).toBe('은혜 가운데');
  });

  it('joins the hyphens a score uses to split a word across notes', () => {
    expect(normalizeKoreanLyricLine('찬-양-해')).toBe('찬양해');
    expect(normalizeKoreanLyricLine('Ce-le-brate')).toBe('Celebrate');
  });

  it('reattaches a particle stranded by a note split', () => {
    expect(normalizeKoreanLyricLine('주님 을 찬양')).toBe('주님을 찬양');
    expect(normalizeKoreanLyricLine('내 맘 에 오신')).toBe('내 맘에 오신');
  });

  it('leaves a word that merely starts like a particle alone', () => {
    // 「를지어다」 is not the particle 「를」 — it must not be glued on.
    expect(normalizeKoreanLyricLine('찬양 를지어다')).toBe('찬양 를지어다');
    // A particle with no Hangul word in front of it has nothing to attach to.
    expect(normalizeKoreanLyricLine('Hallelujah 을')).toBe('Hallelujah 을');
  });

  it('fixes spellings that are wrong however the line is read', () => {
    expect(normalizeKoreanLyricLine('주께 드릴께요')).toBe('주께 드릴게요');
    expect(normalizeKoreanLyricLine('내가 함께 할께')).toBe('내가 함께 할게');
    expect(normalizeKoreanLyricLine('이렇게 됬네')).toBe('이렇게 됐네');
    expect(normalizeKoreanLyricLine('오랫만에 부르는')).toBe('오랜만에 부르는');
  });

  it('does not rewrite the songwriter’s word choice', () => {
    // 「바래」 for 「바라」 is a style choice in lyrics, not a transport artifact.
    expect(normalizeKoreanLyricLine('주님 만나기를 바래')).toBe('주님 만나기를 바래');
    expect(normalizeKoreanLyricLine('나의 사랑 나의 어여쁜 자야')).toBe('나의 사랑 나의 어여쁜 자야');
  });

  it('tidies punctuation spacing without inventing any', () => {
    expect(normalizeKoreanLyricLine('주님 , 나의 힘')).toBe('주님, 나의 힘');
    expect(normalizeKoreanLyricLine('사랑합니다...')).toBe('사랑합니다…');
    expect(normalizeKoreanLyricLine('( 후렴 )')).toBe('(후렴)');
  });

  it('is idempotent', () => {
    const once = normalizeKoreanLyricLine('주님 을  찬-양 합니다 .');
    expect(normalizeKoreanLyricLine(once)).toBe(once);
  });
});

describe('normalizeKoreanLyricLines', () => {
  it('drops lines that normalize away to nothing', () => {
    expect(normalizeKoreanLyricLines(['주님을 찬양', '   ', '​', '은혜'])).toEqual([
      '주님을 찬양',
      '은혜',
    ]);
  });
});
