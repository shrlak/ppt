import { describe, expect, it } from 'vitest';
import {
  orderForSections,
  parsePartHeading,
  structureScrapedLyrics,
} from '../../src/lib/lyrics/lyricsStructure';

// Invented placeholder text: these tests are about part structure, not about
// any particular song's words.
const V1 = ['가나다라 마바사', '아자차 카타파하'];
const V2 = ['라마바사 아자차', '카타파 하 가나다'];
const C = ['높이 높이 노래해', '영원토록 노래해'];
const B = ['잔잔한 강물처럼', '흘러가는 노래로'];

describe('parsePartHeading', () => {
  it('reads Korean and English headings, with or without brackets', () => {
    expect(parsePartHeading('1절')).toEqual({ family: 'V', index: 1 });
    expect(parsePartHeading('[후렴]')).toEqual({ family: 'C', index: undefined });
    expect(parsePartHeading('Verse 2')).toEqual({ family: 'V', index: 2 });
    expect(parsePartHeading('Bridge:')).toEqual({ family: 'B', index: undefined });
    expect(parsePartHeading('Pre-Chorus')).toEqual({ family: 'PC', index: undefined });
  });

  it('does not read a lyric line as a heading', () => {
    expect(parsePartHeading('절망 속에서도 노래해')).toBeNull();
    expect(parsePartHeading('후렴처럼 반복되는 하루')).toBeNull();
  });
});

describe('structureScrapedLyrics', () => {
  it('labels the parts a page announces with headings', () => {
    const sections = structureScrapedLyrics([
      '1절', ...V1,
      '후렴', ...C,
      '2절', ...V2,
      'Bridge', ...B,
    ]);
    expect(sections.map((s) => s.label)).toEqual(['V', 'C', 'V2', 'B']);
    expect(sections[0].lines).toEqual(V1);
    expect(sections[3].lines).toEqual(B);
  });

  it('drops 간주, which has no lyrics of its own', () => {
    const sections = structureScrapedLyrics(['1절', ...V1, '간주', '후렴', ...C]);
    expect(sections.map((s) => s.label)).toEqual(['V', 'C']);
  });

  it('treats text above the first heading as the opening verse', () => {
    const sections = structureScrapedLyrics([...V1, '후렴', ...C]);
    expect(sections.map((s) => s.label)).toEqual(['V', 'C']);
    expect(sections[0].lines).toEqual(V1);
  });

  it('falls back to blank-line stanzas, calling the repeated one the chorus', () => {
    const sections = structureScrapedLyrics([...V1, '', ...C, '', ...V2, '', ...C]);
    expect(sections.map((s) => s.label)).toEqual(['V', 'C', 'V2', 'C2']);
  });

  it('alternates verse and chorus when nothing repeats to give it away', () => {
    const sections = structureScrapedLyrics([...V1, '', ...C, '', ...V2]);
    expect(sections.map((s) => s.label)).toEqual(['V', 'C', 'V2']);
  });

  it('normalizes the scraped text to 한국어 맞춤법', () => {
    const sections = structureScrapedLyrics(['1절', '주님 을 찬-양 합니다', '내가 함께 할께']);
    expect(sections[0].lines).toEqual(['주님을 찬양 합니다', '내가 함께 할게']);
  });

  it('never emits two parts with the same label', () => {
    const sections = structureScrapedLyrics(['1절', ...V1, '절', ...V2]);
    expect(new Set(sections.map((s) => s.label)).size).toBe(sections.length);
  });

  it('returns nothing for a page with no lyrics on it', () => {
    expect(structureScrapedLyrics([])).toEqual([]);
    expect(structureScrapedLyrics(['후렴', '   '])).toEqual([]);
  });
});

describe('orderForSections', () => {
  it('opens with the title slide and names each part once', () => {
    expect(orderForSections([{ label: 'V', lines: V1 }, { label: 'C', lines: C }])).toEqual([
      'I',
      'V',
      'C',
    ]);
  });
});
