import { describe, expect, it } from 'vitest';
import { crossReferenceLines, mergeWebLyrics } from '../../src/lib/lyrics/mergeWebLyrics';
import type { WebLyrics } from '../../src/lib/lyrics/webLyrics';
import type { ParsedScore } from '../../src/lib/ai/scoreParser';

// Placeholder text. The "recognized" copies carry the kind of single-syllable
// slips OCR makes, so the merge has something to correct.
const V_TRUE = ['가나다라 마바사 아자차', '카타파하 그 이름 높이'];
const V_OCR = ['가나다라 마바사 아자차', '카타파하 그 이음 높이'];
const C_TRUE = ['높이 높이 노래해', '영원토록 노래해'];
const C_OCR = ['높이 높이 노래해', '영원토록 노래혜'];
const B_TRUE = ['잔잔한 강물처럼', '흘러가는 노래로'];

function web(sections: { label: string; lines: string[] }[]): WebLyrics {
  return {
    sections,
    order: ['I', ...sections.map((s) => s.label)],
    sourceUrl: 'https://ccm.co.kr/song/1',
    sourceHost: 'ccm.co.kr',
  };
}

describe('crossReferenceLines', () => {
  it('takes the published spelling of a line the models misread', () => {
    const { lines, corrected } = crossReferenceLines(
      ['가나다라 마바사 아자차', '카타파하 그 이음 높이'],
      ['가나다라 마바사 아자차', '카타파하 그 이름 높이'],
    );
    expect(lines).toEqual(['가나다라 마바사 아자차', '카타파하 그 이름 높이']);
    expect(corrected).toBe(1);
  });

  it('keeps a recognized line the page has no counterpart for', () => {
    // The score sings a line this arrangement of the song does not print.
    const { lines } = crossReferenceLines(
      ['가나다라 마바사 아자차', '악보에만 있는 완전히 다른 줄'],
      ['가나다라 마바사 아자차'],
    );
    expect(lines).toEqual(['가나다라 마바사 아자차', '악보에만 있는 완전히 다른 줄']);
  });

  it('recovers a tail the models cut short', () => {
    const { lines } = crossReferenceLines(
      ['가나다라 마바사 아자차', '카타파하 그 이름 높이'],
      ['가나다라 마바사 아자차', '카타파하 그 이름 높이', '영원토록 노래해'],
    );
    expect(lines).toEqual([
      '가나다라 마바사 아자차',
      '카타파하 그 이름 높이',
      '영원토록 노래해',
    ]);
  });

  it('will not append a tail off the back of one incidental match', () => {
    const { lines } = crossReferenceLines(
      ['가나다라 마바사 아자차'],
      ['가나다라 마바사 아자차', '전혀 다른 절의 첫 줄', '전혀 다른 절의 둘째 줄'],
    );
    expect(lines).toEqual(['가나다라 마바사 아자차']);
  });

  it('stays in order when the page repeats a line later', () => {
    // The hook appears twice on the page; the first recognized line must not
    // bind to the second copy and swallow everything in between.
    const { lines } = crossReferenceLines(
      ['높이 노래해', '잔잔한 강물처럼', '높이 노래해'],
      ['높이 노래해', '잔잔한 강물처럼', '높이 노래해'],
    );
    expect(lines).toEqual(['높이 노래해', '잔잔한 강물처럼', '높이 노래해']);
  });

  it('reports nothing corrected when the two already agree', () => {
    const { corrected } = crossReferenceLines(['같은 줄'], ['같은 줄']);
    expect(corrected).toBe(0);
  });
});

describe('mergeWebLyrics', () => {
  it('keeps the score’s shape and takes the published wording', () => {
    const score: ParsedScore = {
      order: ['I', 'V', 'C', 'C'],
      sections: [
        { label: 'V', lines: V_OCR },
        { label: 'C', lines: C_OCR },
      ],
    };
    const merged = mergeWebLyrics(score, web([
      { label: 'V', lines: V_TRUE },
      { label: 'C', lines: C_TRUE },
    ]));

    expect(merged.outcome).toBe('corrected');
    expect(merged.correctedParts).toBe(2);
    // The score decides the order and the labels…
    expect(merged.score.order).toEqual(['I', 'V', 'C', 'C']);
    expect(merged.score.sections.map((s) => s.label)).toEqual(['V', 'C']);
    // …and the web decides the words.
    expect(merged.score.sections[0].lines).toEqual(V_TRUE);
    expect(merged.score.sections[1].lines).toEqual(C_TRUE);
  });

  it('fills the editor from the web when the score read nothing', () => {
    const score: ParsedScore = { order: [], sections: [] };
    const merged = mergeWebLyrics(score, web([
      { label: 'V', lines: V_TRUE },
      { label: 'C', lines: C_TRUE },
    ]));

    expect(merged.outcome).toBe('filled');
    expect(merged.score.sections.map((s) => s.label)).toEqual(['V', 'C']);
    expect(merged.score.order).toEqual(['I', 'V', 'C']);
  });

  it('keeps a printed 진행 순서 even when the web supplies the lyrics', () => {
    const score: ParsedScore = { order: ['I', 'V', 'C', 'C'], sections: [] };
    const merged = mergeWebLyrics(score, web([{ label: 'V', lines: V_TRUE }, { label: 'C', lines: C_TRUE }]));
    expect(merged.score.order).toEqual(['I', 'V', 'C', 'C']);
  });

  it('does not import a published part the conti never asks for', () => {
    // The page prints a bridge; the score neither read one nor orders one.
    const score: ParsedScore = {
      order: ['I', 'V', 'C'],
      sections: [{ label: 'V', lines: V_OCR }, { label: 'C', lines: C_OCR }],
    };
    const merged = mergeWebLyrics(score, web([
      { label: 'V', lines: V_TRUE },
      { label: 'C', lines: C_TRUE },
      { label: 'B', lines: B_TRUE },
    ]));
    expect(merged.score.sections.map((s) => s.label)).toEqual(['V', 'C']);
  });

  it('fills a part the 진행 순서 calls for but no model managed to read', () => {
    const score: ParsedScore = {
      order: ['I', 'V', 'C', 'B'],
      sections: [{ label: 'V', lines: V_OCR }, { label: 'C', lines: C_OCR }],
    };
    const merged = mergeWebLyrics(score, web([
      { label: 'V', lines: V_TRUE },
      { label: 'C', lines: C_TRUE },
      { label: 'B', lines: B_TRUE },
    ]));
    expect(merged.score.sections.map((s) => s.label)).toEqual(['V', 'C', 'B']);
    expect(merged.score.sections[2].lines).toEqual(B_TRUE);
  });

  it('leaves the score alone when the page is a different song', () => {
    const score: ParsedScore = {
      order: ['I', 'V'],
      sections: [{ label: 'V', lines: V_OCR }],
    };
    const merged = mergeWebLyrics(score, web([{ label: 'V', lines: ['전혀 다른 노래의 가사입니다'] }]));
    expect(merged.outcome).toBe('unused');
    expect(merged.score.sections[0].lines).toEqual(V_OCR);
  });

  it('still normalizes the recognized lyrics when there is no web result', () => {
    const score: ParsedScore = {
      order: ['I', 'V'],
      sections: [{ label: 'V', lines: ['주님 을 찬-양 합니다'] }],
    };
    const merged = mergeWebLyrics(score, null);
    expect(merged.outcome).toBe('unused');
    expect(merged.score.sections[0].lines).toEqual(['주님을 찬양 합니다']);
  });

  it('never mutates the score it was given', () => {
    const sections = [{ label: 'V', lines: V_OCR }];
    const score: ParsedScore = { order: ['I', 'V'], sections };
    mergeWebLyrics(score, web([{ label: 'V', lines: V_TRUE }]));
    expect(sections[0].lines).toBe(V_OCR);
    expect(score.sections).toBe(sections);
  });

  it('pairs each published part with at most one recognized part', () => {
    // Two near-identical verses must not both collapse onto the same page part.
    const score: ParsedScore = {
      order: ['I', 'V', 'V2'],
      sections: [
        { label: 'V', lines: V_OCR },
        { label: 'V2', lines: [...V_OCR, '한 줄 더 있는 둘째 절'] },
      ],
    };
    const merged = mergeWebLyrics(score, web([{ label: 'V', lines: V_TRUE }]));
    const fromWeb = merged.score.sections.filter((s) => s.lines.join() === V_TRUE.join());
    expect(fromWeb).toHaveLength(1);
  });
});
