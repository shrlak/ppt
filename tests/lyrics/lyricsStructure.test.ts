import { describe, expect, it } from 'vitest';
import {
  orderForSections,
  parsePartHeading,
  structureScrapedLyrics,
  structureScrapedSong,
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
    const song = structureScrapedSong([...V1, '', ...C, '', ...V2, '', ...C]);
    // The chorus is one part, sung twice.
    expect(song.sections.map((s) => s.label)).toEqual(['V', 'C', 'V2']);
    expect(song.order).toEqual(['I', 'V', 'C', 'V2', 'C']);
  });

  it('alternates verse and chorus when nothing repeats to give it away', () => {
    const sections = structureScrapedLyrics([...V1, '', ...C, '', ...V2]);
    expect(sections.map((s) => s.label)).toEqual(['V', 'C', 'V2']);
  });

  it('takes the page’s text exactly as published', () => {
    // The page's own 띄어쓰기, hyphens and spelling all survive: a published
    // page is the authority on the words, so nothing here rewrites them.
    const published = ['가나다 라 마바사', '아자차-카타-파하', '할께 노래해'];
    const sections = structureScrapedLyrics(['1절', ...published]);
    expect(sections[0].lines).toEqual(published);
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

describe('structureScrapedSong — a page with no headings and no blank lines', () => {
  // Four-line parts, as a page usually prints them (invented text).
  const verse1 = ['첫째 절 첫 줄', '첫째 절 둘째 줄', '첫째 절 셋째 줄', '첫째 절 넷째 줄'];
  const verse2 = ['둘째 절 첫 줄', '둘째 절 둘째 줄', '둘째 절 셋째 줄', '둘째 절 넷째 줄'];
  const chorus = ['후렴 첫 줄', '후렴 둘째 줄', '후렴 셋째 줄', '후렴 넷째 줄'];
  const pre = ['다리 놓는 첫 줄', '다리 놓는 둘째 줄'];
  const bridge = ['브릿지 첫 줄', '브릿지 둘째 줄'];

  it('finds the chorus by its printing again, and the verses between', () => {
    const song = structureScrapedSong([...verse1, ...chorus, ...verse2, ...chorus]);
    expect(song.sections).toEqual([
      { label: 'V', lines: verse1 },
      { label: 'C', lines: chorus },
      { label: 'V2', lines: verse2 },
    ]);
    expect(song.order).toEqual(['I', 'V', 'C', 'V2', 'C']);
  });

  it('splits off the pre-chorus every verse leads in with, and calls a stretch of another length the bridge', () => {
    const song = structureScrapedSong([
      ...verse1, ...pre, ...chorus,
      ...verse2, ...pre, ...chorus,
      ...bridge, ...chorus, ...chorus,
    ]);
    expect(song.sections.map((s) => s.label)).toEqual(['V', 'PC', 'C', 'V2', 'B']);
    expect(song.sections.find((s) => s.label === 'PC')?.lines).toEqual(pre);
    expect(song.sections.find((s) => s.label === 'B')?.lines).toEqual(bridge);
    expect(song.order).toEqual(['I', 'V', 'PC', 'C', 'V2', 'PC', 'C', 'B', 'C', 'C']);
  });

  it('cuts a long block with nothing repeated into four-line verses, not one part', () => {
    const sections = structureScrapedLyrics([...verse1, ...verse2, ...chorus]);
    expect(sections.map((s) => s.label)).toEqual(['V', 'V2', 'V3']);
    expect(sections.every((s) => s.lines.length === 4)).toBe(true);
  });

  it('keeps a short song as one part', () => {
    expect(structureScrapedLyrics(verse1).map((s) => s.label)).toEqual(['V']);
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
