import { describe, expect, it } from 'vitest';
import { displayRef, normalizeContiScripture, parseRefToken, parseVerseInput } from '../src/bible/refParser';

describe('parseRefToken', () => {
  it('parses a single verse', () => {
    expect(parseRefToken('요3:16')).toEqual({
      bookId: 43,
      ko: '요한복음',
      en: 'John',
      startChapter: 3,
      startVerse: 16,
      endChapter: 3,
      endVerse: 16,
    });
  });

  it('parses a verse range within one chapter', () => {
    expect(parseRefToken('행1:8-10')).toEqual({
      bookId: 44,
      ko: '사도행전',
      en: 'Acts',
      startChapter: 1,
      startVerse: 8,
      endChapter: 1,
      endVerse: 10,
    });
  });

  it('parses a cross-chapter range', () => {
    expect(parseRefToken('롬8:28-9:1')).toEqual({
      bookId: 45,
      ko: '로마서',
      en: 'Romans',
      startChapter: 8,
      startVerse: 28,
      endChapter: 9,
      endVerse: 1,
    });
  });

  it('parses a whole-chapter range like 시23-24', () => {
    expect(parseRefToken('시23-24')).toEqual({
      bookId: 19,
      ko: '시편',
      en: 'Psalms',
      startChapter: 23,
      startVerse: undefined,
      endChapter: 24,
      endVerse: undefined,
    });
  });

  it('parses a bare chapter with no verse', () => {
    const ref = parseRefToken('창1');
    expect(ref?.startChapter).toBe(1);
    expect(ref?.startVerse).toBeUndefined();
    expect(ref?.endChapter).toBe(1);
  });

  it('parses a whole-book reference with no chapter', () => {
    expect(parseRefToken('몬')).toEqual({
      bookId: 57,
      ko: '빌레몬서',
      en: 'Philemon',
      startChapter: 1,
      endChapter: 1,
    });
  });

  it('prefers the longest matching abbreviation (삼상 over 삼)', () => {
    expect(parseRefToken('삼상1:1')?.ko).toBe('사무엘상');
  });

  it('returns null for unrecognized tokens', () => {
    expect(parseRefToken('xyz1:1')).toBeNull();
    expect(parseRefToken('')).toBeNull();
  });
});

describe('parseVerseInput', () => {
  it('parses multiple space-separated refs and reports invalid tokens', () => {
    const { refs, invalidTokens } = parseVerseInput('행1:8-10 요3:16 blah 롬8:28');
    expect(refs).toHaveLength(3);
    expect(invalidTokens).toEqual(['blah']);
  });

  it('returns empty results for blank input', () => {
    const { refs, invalidTokens } = parseVerseInput('   ');
    expect(refs).toEqual([]);
    expect(invalidTokens).toEqual([]);
  });
});

describe('displayRef', () => {
  it('formats a recognized ref for preview', () => {
    expect(displayRef('롬8:28')).toBe('로마서 8:28');
  });

  it('flags an unrecognized token', () => {
    expect(displayRef('zzz')).toBe('"zzz" 알 수 없음');
  });
});

describe('normalizeContiScripture', () => {
  it('converts the cover-page chapter/verse style to parser tokens', () => {
    expect(normalizeContiScripture('로마서 5장 1-11절')).toBe('롬5:1-11');
    expect(normalizeContiScripture('시편 13편 1-6절')).toBe('시13:1-6');
    expect(normalizeContiScripture('요한복음 20장 21절')).toBe('요20:21');
    expect(normalizeContiScripture('로마서 5장 1절-11절')).toBe('롬5:1-11');
  });

  it('supports cross-chapter ranges and multiple references', () => {
    expect(normalizeContiScripture('본문: 로마서 8장 28절-9장 1절, 요한복음 3장 16절')).toBe(
      '롬8:28-9:1 요3:16',
    );
  });

  it('produces values accepted by parseVerseInput', () => {
    const normalized = normalizeContiScripture('로마서 5장 1-11절');
    const parsed = parseVerseInput(normalized);
    expect(parsed.invalidTokens).toEqual([]);
    expect(parsed.refs[0]).toMatchObject({ startChapter: 5, startVerse: 1, endVerse: 11 });
  });
});
