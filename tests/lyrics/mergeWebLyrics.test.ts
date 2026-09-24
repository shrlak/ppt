import { describe, expect, it } from 'vitest';
import { mergeRankedWebLyrics, mergeWebLyrics, partSimilarity } from '../../src/lib/lyrics/mergeWebLyrics';
import type { ScoredLyricsCandidate } from '../../src/lib/lyrics/webLyrics';
import type { ParsedScore } from '../../src/lib/ai/scoreParser';

// Placeholder text. The "recognized" copies carry the kind of single-syllable
// slips OCR makes, so the merge has something to correct.
const V_TRUE = ['가나다라 마바사 아자차', '카타파하 그 이름 높이'];
const V_OCR = ['가나다라 마바사 아자차', '카타파하 그 이음 높이'];
const C_TRUE = ['높이 높이 노래해', '영원토록 노래해'];
const C_OCR = ['높이 높이 노래해', '영원토록 노래혜'];
const B_TRUE = ['잔잔한 강물처럼', '흘러가는 노래로'];

function web(
  sections: { label: string; lines: string[] }[],
  overrides: Partial<ScoredLyricsCandidate> = {},
): ScoredLyricsCandidate {
  return {
    id: 'ccm:ccm.co.kr/song/1',
    title: '가나다라 마바사',
    sections,
    order: ['I', ...sections.map((s) => s.label)],
    sourceUrl: 'https://ccm.co.kr/song/1',
    sourceHost: 'ccm.co.kr',
    source: 'ccm',
    score: 0.95,
    titleScore: 1,
    artistScore: 0,
    lyricsScore: 0.9,
    decision: 'auto',
    ...overrides,
  };
}

describe('partSimilarity', () => {
  it('sees through the spacing a score opens between syllables', () => {
    const recognized = { label: 'V', lines: ['주 님 을 찬 양 해', '영 원 히 노 래 해'] };
    const published = { label: 'V', lines: ['주님을 찬양해', '영원히 노래해'] };
    expect(partSimilarity(recognized, published)).toBe(1);
  });

  it('tells two different parts of the same song apart', () => {
    expect(partSimilarity({ label: 'V', lines: V_TRUE }, { label: 'C', lines: C_TRUE })).toBeLessThan(0.3);
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

  it('puts the page’s other parts in the editor without adding them to 진행 순서', () => {
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
    expect(merged.score.sections.map((s) => s.label)).toEqual(['V', 'C', 'B']);
    expect(merged.score.order).toEqual(['I', 'V', 'C']);
  });

  it('replaces a whole recognized part with the published one, not line by line', () => {
    // The models dropped a line and garbled another; the page's part wins whole.
    const score: ParsedScore = {
      order: ['I', 'V'],
      sections: [{ label: 'V', lines: ['가나다라 마바사 아자차', '카타 그 이'] }],
    };
    const merged = mergeWebLyrics(score, web([{ label: 'V', lines: [...V_TRUE, '셋째 줄도 있습니다'] }]));
    expect(merged.score.sections[0].lines).toEqual([...V_TRUE, '셋째 줄도 있습니다']);
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

  it('falls back to the label when the OCR was too poor to match by text', () => {
    const score: ParsedScore = {
      order: ['I', 'V', 'T'],
      sections: [
        { label: 'V', lines: ['읽기 어려운 글자들'] },
        { label: 'T', lines: ['이 편곡에만 있는 태그'] },
      ],
    };
    const merged = mergeWebLyrics(score, web([{ label: 'V', lines: V_TRUE }]));
    expect(merged.outcome).toBe('corrected');
    expect(merged.score.sections[0]).toEqual({ label: 'V', lines: V_TRUE });
    // A part the page does not have is this arrangement's own, and stays.
    expect(merged.score.sections[1]).toEqual({ label: 'T', lines: ['이 편곡에만 있는 태그'] });
  });

  it('renumbers a page part whose label a recognized part already uses', () => {
    const score: ParsedScore = {
      order: ['I', 'V', 'C'],
      sections: [{ label: 'V', lines: V_OCR }, { label: 'C', lines: C_OCR }],
    };
    const merged = mergeWebLyrics(score, web([
      { label: 'V', lines: V_TRUE },
      { label: 'C', lines: C_TRUE },
      { label: 'C', lines: B_TRUE },
    ]));
    expect(merged.score.sections.map((s) => s.label)).toEqual(['V', 'C', 'C2']);
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

describe('mergeRankedWebLyrics', () => {
  const score: ParsedScore = {
    order: ['I', 'V', 'C'],
    sections: [
      { label: 'V', lines: V_OCR },
      { label: 'C', lines: C_OCR },
    ],
  };
  const reviewCandidate = web(
    [
      { label: 'V', lines: V_TRUE },
      { label: 'C', lines: C_TRUE },
    ],
    { id: 'ccm:review', decision: 'review', score: 0.72 },
  );

  it('does not merge a review candidate until the user selects it', () => {
    expect(mergeRankedWebLyrics(score, reviewCandidate, undefined).outcome).toBe('unused');
  });

  it('keeps printed order after an explicitly selected candidate fills a missing part', () => {
    const merged = mergeRankedWebLyrics(score, reviewCandidate, reviewCandidate.id);
    expect(merged.score.order).toEqual(score.order);
    expect(merged.outcome).toBe('corrected');
  });

  it('applies an auto candidate without being asked', () => {
    const auto = web(
      [
        { label: 'V', lines: V_TRUE },
        { label: 'C', lines: C_TRUE },
      ],
      { id: 'ccm:auto', decision: 'auto', score: 0.95 },
    );
    expect(mergeRankedWebLyrics(score, auto).outcome).toBe('corrected');
  });

  it('leaves the score alone when there is no candidate at all', () => {
    const merged = mergeRankedWebLyrics(score, null);
    expect(merged.outcome).toBe('unused');
    expect(merged.score.sections.map((section) => section.label)).toEqual(['V', 'C']);
  });

  it('never lets a declined candidate change the recognized reading', () => {
    // Selecting a different candidate's ID must not apply this one.
    const merged = mergeRankedWebLyrics(score, reviewCandidate, 'some-other-candidate');
    expect(merged.outcome).toBe('unused');
    expect(merged.score.sections[0].lines).toEqual(V_OCR.map((line) => line));
  });
});
