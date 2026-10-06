import { describe, expect, it } from 'vitest';
import { englishFromScore, scoreEnglishText } from '../../src/praise/englishScore';
import { slideKey } from '../../src/praise/planner';
import type { ScoreEnglish } from '../../src/lib/utils/scorePages';
import type { Song } from '../../src/lib/utils/types';

// Made-up lyrics in the shape of a song printed once in Korean, once in English.
const V = ['주 사랑 안에 나 살아가리', '그 은혜 날마다 새롭네'];
const C = ['주를 찬양해 영원토록', '주의 이름 높이리'];
const B = ['나 무너져도 주 붙드시네', '그 사랑 끝이 없네'];
const EV = ['In Your love I will live my days', 'Your grace is new every morning'];
const EC = ['I will praise You forevermore', 'I lift Your name on high'];
const EB = ['When I fall You hold me fast', 'Your love will never end'];

const song: Song = {
  id: 'trial',
  title: '시험의 노래',
  sections: [
    { label: 'V', lines: V },
    { label: 'C', lines: C },
    { label: 'B', lines: B },
  ],
  order: ['I', 'V', 'C', 'B', 'C'],
  linesPerSlide: 3,
};

const page = (sections: [string, string[]][], title = 'Song of Trial'): ScoreEnglish => ({
  title,
  sections: sections.map(([label, lines]) => ({ label, lines })),
  order: [],
  pages: [4],
});

describe('englishFromScore', () => {
  it('puts each English part under the Korean part of the same name', () => {
    // The English page prints the chorus first: the names, not the order, decide.
    const result = englishFromScore(song, { title: '', slides: {} }, page([
      ['C', EC],
      ['V', EV],
      ['B', EB],
    ]));
    expect(result.filled).toBe(3);
    expect(result.guessed).toBe(false);
    expect(result.english.slides[slideKey(V)]).toEqual(EV);
    expect(result.english.slides[slideKey(C)]).toEqual(EC);
    expect(result.english.slides[slideKey(B)]).toEqual(EB);
    expect(result.english.title).toBe('Song of Trial');
  });

  it('never writes over English already there, nor over an English title', () => {
    const typed = ['Typed by hand'];
    const result = englishFromScore(song, { title: 'Kept', slides: { [slideKey(V)]: typed } }, page([
      ['V', EV],
      ['C', EC],
      ['B', EB],
    ]));
    expect(result.english.slides[slideKey(V)]).toEqual(typed);
    expect(result.english.title).toBe('Kept');
    expect(result.filled).toBe(2);
  });

  it('still lays the song’s own English in order when nothing places it, as a draft to check', () => {
    const result = englishFromScore(song, { title: '', slides: {} }, page([['X', [...EV, ...EC, ...EB]]]));
    expect(result.filled).toBeGreaterThan(0);
    expect(result.english.slides[slideKey(V)]?.[0]).toBe(EV[0]);
  });

  it('gives the text by part, for the card to show', () => {
    expect(scoreEnglishText(page([
      ['V', EV],
      ['C', EC],
    ]))).toBe(`${EV.join('\n')}\n\n${EC.join('\n')}`);
  });
});
