import { describe, expect, it } from 'vitest';
import { buildWeightedConsensus } from '../../src/lib/ai/weightedConsensus';
import { emptyReliability, type ModelReliability } from '../../src/lib/ai/modelReliability';
import type { RecognitionObservation } from '../../src/lib/ai/recognitionObservation';
import type { ParsedScore } from '../../src/lib/ai/scoreParser';

const NOW = new Date('2026-08-14T00:00:00.000Z');

/** A model whose measured lyric accuracy is `lyrics`, over enough samples to count. */
function proven(model: string, lyrics: number, samples = 40): ModelReliability {
  return {
    ...emptyReliability(`openrouter:${model}`, NOW),
    samples,
    title: lyrics,
    order: lyrics,
    lyrics,
    successRate: 1,
  };
}

function observation(model: string, score: ParsedScore | undefined, latencyMs = 1000): RecognitionObservation {
  return { attempt: { engine: 'openrouter', model }, score, latencyMs };
}

const verse = (lines: string[]): ParsedScore => ({
  title: '은혜의 노래',
  order: ['I', 'V'],
  sections: [{ label: 'V', lines }],
});

describe('buildWeightedConsensus', () => {
  it('lets two proven models correct one weak winner without importing a different line', () => {
    // The weak model leads on pool order but has the lowest measured accuracy;
    // the two proven models agree that its first line is a misread.
    const observations = [
      observation('weak', verse(['빛으로 인도하시내', '영원히 노래하리'])),
      observation('strong-a', verse(['빛으로 인도하시네', '영원히 노래하리'])),
      observation('strong-b', verse(['빛으로 인도하시네', '영원히 노래하리'])),
    ];
    const reliability = [proven('weak', 0.55), proven('strong-a', 0.95), proven('strong-b', 0.94)];

    const result = buildWeightedConsensus(observations, reliability);

    expect(result.score.sections[0].lines).toEqual(['빛으로 인도하시네', '영원히 노래하리']);
    expect(result.fieldConfidence.lyrics).toBeGreaterThan(0.75);
    expect(result.needsReview).toBe(false);
  });

  it('keeps the champion line when challengers are reading a different sentence', () => {
    // Two challengers agree with each other, but on something that is not the
    // champion's line at all. Agreement may correct a line, never replace one.
    const differentSentenceObservations = [
      observation('champion', verse(['악보에 적힌 고유한 문장', '영원히 노래하리'])),
      observation('challenger-a', verse(['다른 곳에서 옮겨 온 줄', '영원히 노래하리'])),
      observation('challenger-b', verse(['다른 곳에서 옮겨 온 줄', '영원히 노래하리'])),
    ];
    const reliability = [proven('champion', 0.95), proven('challenger-a', 0.7), proven('challenger-b', 0.7)];

    const result = buildWeightedConsensus(differentSentenceObservations, reliability);

    expect(result.score.sections[0].lines[0]).toBe('악보에 적힌 고유한 문장');
    expect(result.needsReview).toBe(true);
    // The disagreement is visible in the number, not just in the outcome.
    expect(result.fieldConfidence.lyrics).toBeLessThan(0.75);
  });

  it('treats an unmeasured model as neither trusted nor ignored', () => {
    const observations = [observation('unknown-a', verse(['첫 줄'])), observation('unknown-b', verse(['첫 줄']))];
    const result = buildWeightedConsensus(observations, []);
    expect(result.score.sections[0].lines).toEqual(['첫 줄']);
    expect(result.fieldConfidence.lyrics).toBe(1);
  });

  it('gives the title to the models that agree, weighted by title accuracy', () => {
    const observations = [
      observation('weak', { ...verse(['첫 줄']), title: '잘못 읽은 제목' }),
      observation('strong-a', { ...verse(['첫 줄']), title: '은혜의 노래' }),
      observation('strong-b', { ...verse(['첫 줄']), title: '은혜의 노래' }),
    ];
    const result = buildWeightedConsensus(observations, [
      proven('weak', 0.5),
      proven('strong-a', 0.95),
      proven('strong-b', 0.95),
    ]);
    expect(result.score.title).toBe('은혜의 노래');
    expect(result.fieldConfidence.title).toBeGreaterThan(0.75);
  });

  it('flags a page for review when only one model answered it', () => {
    const result = buildWeightedConsensus([observation('lonely', verse(['첫 줄']))], [proven('lonely', 0.99)]);
    // One model agreeing with itself is not agreement.
    expect(result.needsReview).toBe(true);
    expect(result.usedModels).toEqual(['openrouter:lonely']);
  });

  it('ignores a model that read the page as a different kind of page', () => {
    const sermon: ParsedScore = {
      pageType: 'non_score',
      sermonTitle: '믿음으로 걷기',
      order: [],
      sections: [],
    };
    const asScore: ParsedScore = {
      pageType: 'score',
      title: '엉뚱한 곡',
      order: ['I'],
      sections: [{ label: 'V', lines: ['잘못 읽은 가사'] }],
    };
    const result = buildWeightedConsensus(
      [observation('reads-sermon', sermon), observation('reads-score', asScore)],
      [proven('reads-sermon', 0.95), proven('reads-score', 0.6)],
    );
    expect(result.score.pageType).toBe('non_score');
    expect(result.score.title).toBeUndefined();
    expect(result.score.sections).toEqual([]);
  });

  it('ignores a model that answered about a different song entirely', () => {
    const unrelated: ParsedScore = {
      order: ['I', 'V', 'V2'],
      sections: [
        { label: 'V', lines: ['전혀 다른 노래의 가사입니다'] },
        { label: 'V2', lines: ['이 페이지와 상관없는 두 번째 절'] },
      ],
    };
    const result = buildWeightedConsensus(
      [observation('champion', verse(['주님만이 내 아픔 아시며'])), observation('lost', unrelated)],
      [proven('champion', 0.95), proven('lost', 0.9)],
    );
    // Its 진행 순서 must not outvote the champion's either.
    expect(result.score.order).toEqual(['I', 'V']);
    expect(result.score.sections).toEqual([{ label: 'V', lines: ['주님만이 내 아픔 아시며'] }]);
  });

  it('still counts a model that read only part of the page', () => {
    // Stopping short is the most common failure there is, so a partial reading
    // is the same page and its tail may be adopted.
    const short = verse(['빛으로 인도하시네']);
    const full = verse(['빛으로 인도하시네', '영원히 노래하리']);
    const result = buildWeightedConsensus(
      [observation('champion', short), observation('reader', full)],
      [proven('champion', 0.95), proven('reader', 0.9)],
    );
    expect(result.score.sections[0].lines).toEqual(['빛으로 인도하시네', '영원히 노래하리']);
  });

  it('fills the sections when the leading model only recognized a title', () => {
    const titleOnly: ParsedScore = { title: '은혜의 노래', order: [], sections: [] };
    const result = buildWeightedConsensus(
      [observation('titles-well', titleOnly), observation('reads-lyrics', verse(['첫 줄']))],
      [proven('titles-well', 0.95), proven('reads-lyrics', 0.8)],
    );
    expect(result.score.title).toBe('은혜의 노래');
    expect(result.score.sections).toEqual([{ label: 'V', lines: ['첫 줄'] }]);
    expect(result.score.order).toEqual(['I', 'V']);
  });

  it('returns an empty answer that needs review when every model failed', () => {
    const result = buildWeightedConsensus(
      [observation('a', undefined), observation('b', undefined)],
      [proven('a', 0.9)],
    );
    expect(result.score).toEqual({ order: [], sections: [] });
    expect(result.confidence).toBe(0);
    expect(result.needsReview).toBe(true);
    expect(result.usedModels).toEqual([]);
  });

  it('recovers stacked verses a leading model merged, even when it is the strongest', () => {
    const merged: ParsedScore = {
      order: ['I', 'V', 'C'],
      lyricRowCount: 2,
      sections: [
        { label: 'V', lines: ['첫째 절 첫 줄', '둘째 절 첫 줄', '첫째 절 둘째 줄', '둘째 절 둘째 줄'] },
        { label: 'C', lines: ['후렴 한 줄'] },
      ],
    };
    const split: ParsedScore = {
      order: ['I', 'V', 'V2', 'C'],
      sections: [
        { label: 'V', lines: ['첫째 절 첫 줄', '첫째 절 둘째 줄'] },
        { label: 'V2', lines: ['둘째 절 첫 줄', '둘째 절 둘째 줄'] },
        { label: 'C', lines: ['후렴 한 줄'] },
      ],
    };
    const result = buildWeightedConsensus(
      [observation('merger', merged), observation('splitter', split)],
      [proven('merger', 0.95), proven('splitter', 0.8)],
    );
    expect(result.score.sections).toEqual(split.sections);
    expect(result.score.order).toEqual(['I', 'V', 'V2', 'C']);
  });
});
