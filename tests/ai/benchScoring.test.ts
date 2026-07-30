import { describe, expect, it } from 'vitest';
import { levenshtein, lyricsSimilarity, orderSimilarity, scoreSong, summarize, textSimilarity } from '../../bench/scoring';
import type { SongReport, TruthSong } from '../../bench/scoring';
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

describe('trials that lost songs to the provider', () => {
  const ok = (index: number, overall: number): SongReport => ({
    index,
    title: `곡 ${index}`,
    titleScore: 1,
    orderScore: 1,
    lyricsScore: overall,
    overall,
  });
  const dead = (index: number): SongReport => ({
    index,
    title: `곡 ${index}`,
    titleScore: 0,
    orderScore: 0,
    lyricsScore: 0,
    overall: 0,
    error: 'Gemini 일괄 호출 실패: quota exceeded',
  });

  it('averages only the songs a model actually answered', () => {
    // Averaging the dead songs in as 0% reported 17.6% for a run whose four
    // answered songs were all fine — a broken trial reading as a broken pipeline.
    const summary = summarize([ok(0, 0.9), ok(1, 0.94), dead(2), dead(3), dead(4)]);
    expect(summary.songs).toBe(2);
    expect(summary.failed).toBe(3);
    expect(summary.meanOverall).toBeCloseTo(0.92);
  });

  it('keeps failed songs out of the below-90 list and the perfect-title count', () => {
    const summary = summarize([ok(0, 0.99), dead(1)]);
    expect(summary.below90).toEqual([]);
    expect(summary.perfectTitles).toBe(1);
  });

  it('reports zeros rather than dividing by nothing when every song failed', () => {
    const summary = summarize([dead(0), dead(1)]);
    expect(summary.songs).toBe(0);
    expect(summary.failed).toBe(2);
    expect(summary.meanOverall).toBe(0);
  });

  it('still counts a genuinely empty answer as a scored zero', () => {
    // The model replied, it just read nothing — that is a quality result and
    // belongs in the mean, unlike a call that never happened.
    const empty: SongReport = { index: 0, title: '곡', titleScore: 0, orderScore: 0, lyricsScore: 0, overall: 0 };
    const summary = summarize([empty, ok(1, 1)]);
    expect(summary.songs).toBe(2);
    expect(summary.failed).toBe(0);
    expect(summary.meanOverall).toBeCloseTo(0.5);
  });
});
