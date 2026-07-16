import { describe, expect, it } from 'vitest';
import { levenshtein, lyricsSimilarity, orderSimilarity, scoreSong, summarize, textSimilarity } from '../../bench/scoring';
import type { TruthSong } from '../../bench/scoring';
import type { ParsedScore } from '../../src/lib/ai/scoreParser';

const truth: TruthSong = {
  index: 0,
  file: 'pages/score-00.png',
  title: '주님의 사랑',
  key: 'G',
  order: ['I', 'V1', 'C'],
  sections: [
    { label: 'V1', lines: ['주님의 사랑 깊어져 가네', '나의 마음에'] },
    { label: 'C', lines: ['내 안에 기쁨의 노래'] },
  ],
};

describe('bench scoring', () => {
  it('levenshtein basics', () => {
    expect(levenshtein('abc', 'abc')).toBe(0);
    expect(levenshtein('abc', 'axc')).toBe(1);
    expect(levenshtein('', 'ab')).toBe(2);
  });

  it('textSimilarity ignores spacing and punctuation', () => {
    expect(textSimilarity('주님의 사랑', '주님의사랑!')).toBe(1);
    expect(textSimilarity('주님의 사랑', '주님의 사망')).toBeCloseTo(1 - 1 / 5);
  });

  it('a perfect parse scores 1.0 overall', () => {
    const parsed: ParsedScore = {
      title: truth.title,
      key: truth.key,
      order: [...truth.order],
      sections: truth.sections.map((section) => ({ label: section.label, lines: [...section.lines] })),
    };
    const report = scoreSong(parsed, truth);
    expect(report.titleScore).toBe(1);
    expect(report.orderScore).toBe(1);
    expect(report.lyricsScore).toBeCloseTo(1);
    expect(report.overall).toBeCloseTo(1);
  });

  it('a missing result scores 0 with the error recorded', () => {
    const report = scoreSong(undefined, truth, 'HTTP 500');
    expect(report.overall).toBe(0);
    expect(report.error).toBe('HTTP 500');
  });

  it('mislabeled sections keep partial credit through the whole-song comparison', () => {
    const parsed: ParsedScore = {
      title: truth.title,
      order: [...truth.order],
      // Correct text, but everything labeled C2 instead of V1/C.
      sections: [{ label: 'C2', lines: ['주님의 사랑 깊어져 가네 나의 마음에 내 안에 기쁨의 노래'] }],
    };
    const report = scoreSong(parsed, truth);
    expect(report.lyricsScore).toBeGreaterThan(0.25);
    expect(report.lyricsScore).toBeLessThan(0.5);
  });

  it('orderSimilarity uses subsequence overlap', () => {
    expect(orderSimilarity(['I', 'V1', 'C'], ['I', 'V1', 'C'])).toBe(1);
    expect(orderSimilarity(['V1', 'C'], ['I', 'V1', 'C'])).toBeCloseTo(2 / 3);
    expect(orderSimilarity([], ['I'])).toBe(0);
  });

  it('aliases section labels like the app (V→V1, C→C1)', () => {
    const parsed: ParsedScore = {
      order: [],
      sections: [
        { label: 'V', lines: ['주님의 사랑 깊어져 가네', '나의 마음에'] },
        { label: 'C1', lines: ['내 안에 기쁨의 노래'] },
      ],
    };
    expect(lyricsSimilarity(parsed, truth)).toBeCloseTo(1);
  });

  it('lyricsSimilarity rewards right-text-right-label highest', () => {
    const rightLabels: ParsedScore = {
      order: [],
      sections: truth.sections.map((section) => ({ label: section.label, lines: [...section.lines] })),
    };
    expect(lyricsSimilarity(rightLabels, truth)).toBeCloseTo(1);
  });

  it('summarize reports means and weak songs', () => {
    const summary = summarize([
      { index: 0, title: 'a', titleScore: 1, orderScore: 1, lyricsScore: 1, overall: 1 },
      { index: 1, title: 'b', titleScore: 0, orderScore: 0, lyricsScore: 0.5, overall: 0.35 },
    ]);
    expect(summary.songs).toBe(2);
    expect(summary.meanOverall).toBeCloseTo(0.675);
    expect(summary.below90.map((r) => r.index)).toEqual([1]);
    expect(summary.perfectTitles).toBe(1);
  });
});
