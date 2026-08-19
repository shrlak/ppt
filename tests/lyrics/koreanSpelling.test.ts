import { describe, expect, it } from 'vitest';
import {
  cleanScrapedLyricLine,
  cleanScrapedLyricLines,
  normalizeRecognizedLyricLine,
  normalizeRecognizedLyricLines,
} from '../../src/lib/lyrics/koreanSpelling';

describe('normalizeRecognizedLyricLine', () => {
  it('composes decomposed jamo from a model answer', () => {
    // NFD Hangul renders identically but breaks every Hangul-aware rule below.
    const decomposed = '주님'.normalize('NFD');
    expect(decomposed).not.toBe('주님');
    expect(normalizeRecognizedLyricLine(decomposed)).toBe('주님');
  });

  it('strips zero-width characters and normalizes exotic spaces', () => {
    expect(normalizeRecognizedLyricLine('주​님 사랑')).toBe('주님 사랑');
    expect(normalizeRecognizedLyricLine('은혜　가운데')).toBe('은혜 가운데');
  });

  it('joins the hyphens a score uses to split a word across notes', () => {
    expect(normalizeRecognizedLyricLine('찬-양-해')).toBe('찬양해');
    expect(normalizeRecognizedLyricLine('Ce-le-brate')).toBe('Celebrate');
  });

  it('reattaches a particle stranded by a note split', () => {
    expect(normalizeRecognizedLyricLine('주님 을 찬양')).toBe('주님을 찬양');
    expect(normalizeRecognizedLyricLine('내 맘 에 오신')).toBe('내 맘에 오신');
  });

  it('reattaches an ending that cannot begin a word', () => {
    expect(normalizeRecognizedLyricLine('노래 합니다')).toBe('노래 합니다');
    expect(normalizeRecognizedLyricLine('노래하 습니다')).toBe('노래하습니다');
    expect(normalizeRecognizedLyricLine('나를 받아 주 세요')).toBe('나를 받아 주세요');
  });

  it('folds a lone consonant back onto the syllable it came off', () => {
    expect(normalizeRecognizedLyricLine('하 ㄹ 수')).toBe('할 수');
    // The syllable already has a final consonant, so the jamo is not from it.
    expect(normalizeRecognizedLyricLine('할 ㄹ')).toBe('할 ㄹ');
  });

  it('leaves a word that merely starts like a particle alone', () => {
    // 「를지어다」 is not the particle 「를」 — it must not be glued on.
    expect(normalizeRecognizedLyricLine('찬양 를지어다')).toBe('찬양 를지어다');
    // A particle with no Hangul word in front of it has nothing to attach to.
    expect(normalizeRecognizedLyricLine('Hallelujah 을')).toBe('Hallelujah 을');
  });

  it('never splits a word apart, only closes note splits', () => {
    // A score prints too many spaces, never too few, so 「할수」 stays as read:
    // deciding where a space is missing needs the part of speech.
    expect(normalizeRecognizedLyricLine('나의 실수 있었지만')).toBe('나의 실수 있었지만');
  });

  it('fixes spellings that are wrong however the line is read', () => {
    expect(normalizeRecognizedLyricLine('주께 드릴께요')).toBe('주께 드릴게요');
    expect(normalizeRecognizedLyricLine('내가 함께 할께')).toBe('내가 함께 할게');
    expect(normalizeRecognizedLyricLine('이렇게 됬네')).toBe('이렇게 됐네');
    expect(normalizeRecognizedLyricLine('오랫만에 부르는')).toBe('오랜만에 부르는');
    expect(normalizeRecognizedLyricLine('주님과 함께 되요')).toBe('주님과 함께 돼요');
    expect(normalizeRecognizedLyricLine('노래를 부르 겠읍니다')).toBe('노래를 부르 겠습니다');
    expect(normalizeRecognizedLyricLine('받아 주십시요')).toBe('받아 주십시오');
    expect(normalizeRecognizedLyricLine('깨끗히 씻어')).toBe('깨끗이 씻어');
  });

  it('does not rewrite the songwriter’s word choice', () => {
    // 「바래」 for 「바라」 is a style choice in lyrics, not a transport artifact.
    expect(normalizeRecognizedLyricLine('주님 만나기를 바래')).toBe('주님 만나기를 바래');
    expect(normalizeRecognizedLyricLine('나의 사랑 나의 어여쁜 자야')).toBe('나의 사랑 나의 어여쁜 자야');
  });

  it('tidies punctuation spacing without inventing any', () => {
    expect(normalizeRecognizedLyricLine('주님 , 나의 힘')).toBe('주님, 나의 힘');
    expect(normalizeRecognizedLyricLine('사랑합니다...')).toBe('사랑합니다…');
    expect(normalizeRecognizedLyricLine('( 후렴 )')).toBe('(후렴)');
  });

  it('is idempotent', () => {
    const once = normalizeRecognizedLyricLine('주님 을  찬-양 합니다 .');
    expect(normalizeRecognizedLyricLine(once)).toBe(once);
  });
});

describe('normalizeRecognizedLyricLines', () => {
  it('drops lines that normalize away to nothing', () => {
    expect(normalizeRecognizedLyricLines(['주님을 찬양', '   ', '​', '은혜'])).toEqual([
      '주님을 찬양',
      '은혜',
    ]);
  });
});

describe('cleanScrapedLyricLine', () => {
  it('takes the page’s own spacing, punctuation and spelling as published', () => {
    // Every one of these would be rewritten on a recognized line. A published
    // page is the better authority on the words, so none of them is touched.
    for (const published of [
      '주님 을 찬양',
      '내가 함께 할께',
      '주님 , 나의 힘',
      '사랑합니다...',
      '찬-양-해',
      '깨끗히 씻어',
    ]) {
      expect(cleanScrapedLyricLine(published)).toBe(published);
    }
  });

  it('still repairs transport noise, which is invisible either way', () => {
    expect(cleanScrapedLyricLine('주​님 사랑')).toBe('주님 사랑');
    expect(cleanScrapedLyricLine('은혜　가운데')).toBe('은혜 가운데');
    expect(cleanScrapedLyricLine('  주의 사랑  ')).toBe('주의 사랑');
    expect(cleanScrapedLyricLine('주님'.normalize('NFD'))).toBe('주님');
  });

  it('drops lines that were only noise', () => {
    expect(cleanScrapedLyricLines(['주님을 찬양', '   ', '​', '은혜'])).toEqual([
      '주님을 찬양',
      '은혜',
    ]);
  });
});
