import { describe, expect, it } from 'vitest';
import {
  CHAMPION_PROMOTION_MARGIN,
  RECENT_WINDOW,
  applyPauseRules,
  assignRoles,
  composite,
  compositeAccuracy,
  conservativeScore,
  decayFactor,
  emptyReliability,
  mergeModelEvaluation,
  modelKeyFor,
  rankModels,
  scoreObservation,
  type ModelReliability,
} from '../../src/lib/ai/modelReliability';
import type { RecognitionModelInfo } from '../../src/lib/ai/aiSettings';
import {
  mergeModelEvaluation as workerMerge,
  modelStatsKey,
  sanitizeModelEvaluation,
} from '../../worker/src/modelStats.js';

const NOW = new Date('2026-08-14T00:00:00.000Z');

/** A model with the given composite accuracy over `samples` evaluations. */
function stat(modelKey: string, accuracy: number, samples: number, extra: Partial<ModelReliability> = {}) {
  return {
    ...emptyReliability(modelKey, NOW),
    samples,
    title: accuracy,
    order: accuracy,
    lyrics: accuracy,
    successRate: 1,
    ...extra,
  };
}

function catalogEntry(model: string, role: RecognitionModelInfo['role'] = 'challenger'): RecognitionModelInfo {
  return {
    engine: 'openrouter',
    model,
    upstreamModel: `${model}:free`,
    role,
    label: model,
    note: '',
  };
}

const catalog = [catalogEntry('new'), catalogEntry('proven', 'champion')];

describe('composite accuracy', () => {
  it('weights lyrics far above everything else', () => {
    expect(compositeAccuracy({ title: 0, artist: 0, order: 0, lyrics: 1 })).toBeCloseTo(0.7, 6);
    expect(compositeAccuracy({ title: 1, artist: 1, order: 1, lyrics: 0 })).toBeCloseTo(0.3, 6);
  });

  it('gives the artist weight back to the title when no artist was printed', () => {
    // A score with no artist must not be graded out of a smaller total than
    // one that has an artist, or artist-less pages would look easier.
    expect(compositeAccuracy({ title: 1, order: 1, lyrics: 1 })).toBeCloseTo(1, 6);
    expect(compositeAccuracy({ title: 1, order: 0, lyrics: 0 })).toBeCloseTo(0.2, 6);
    expect(compositeAccuracy({ title: 1, artist: 0, order: 0, lyrics: 0 })).toBeCloseTo(0.1, 6);
  });

  it('ignores a stored artist average nothing was ever measured into', () => {
    expect(composite(stat('m', 1, 4, { artist: 0, artistSamples: 0 }))).toBeCloseTo(1, 6);
  });
});

describe('conservativeScore', () => {
  it('stays wide for a tiny sample and tightens as evidence accumulates', () => {
    const few = conservativeScore(stat('m', 1, 1));
    const many = conservativeScore(stat('m', 1, 200));
    expect(few).toBeLessThan(0.5);
    expect(many).toBeGreaterThan(0.95);
    expect(many).toBeGreaterThan(few);
  });

  it('is zero for a model that has never been evaluated', () => {
    expect(conservativeScore(emptyReliability('m', NOW))).toBe(0);
  });
});

describe('rankModels', () => {
  it('keeps a perfect one-sample challenger below an established champion', () => {
    const ranked = rankModels(catalog, [stat('openrouter:new', 1, 1), stat('openrouter:proven', 0.94, 50)], NOW);
    expect(ranked[0].model).toBe('proven');
  });

  it('lets confidence in a stale measurement decay', () => {
    const stale = stat('openrouter:proven', 0.94, 50);
    const muchLater = new Date('2027-08-14T00:00:00.000Z');
    const fresh = rankModels(catalog, [stale], NOW)[0].conservative;
    const aged = rankModels(catalog, [stale], muchLater)[0].conservative;
    expect(aged).toBeLessThan(fresh);
    expect(decayFactor(stale.updatedAt, muchLater)).toBeLessThan(0.1);
  });

  it('reports an unmeasured catalog model rather than dropping it', () => {
    const ranked = rankModels(catalog, [], NOW);
    expect(ranked.map((entry) => entry.model).sort()).toEqual(['new', 'proven']);
    expect(ranked.every((entry) => entry.samples === 0 && entry.conservative === 0)).toBe(true);
  });
});

describe('assignRoles', () => {
  it('promotes a challenger only after 20 samples and a 2 point lower-bound lead', () => {
    expect(assignRoles([stat('champ', 0.88, 60), stat('challenger', 0.94, 19)])['challenger']).toBe('challenger');
    expect(assignRoles([stat('champ', 0.88, 60), stat('challenger', 0.94, 25)])['challenger']).toBe('champion');
  });

  it('keeps exactly three champions once enough models qualify', () => {
    const roles = assignRoles([
      stat('a', 0.95, 40),
      stat('b', 0.93, 40),
      stat('c', 0.91, 40),
      stat('d', 0.89, 40),
    ]);
    expect(Object.values(roles).filter((role) => role === 'champion')).toHaveLength(3);
    expect(roles['d']).toBe('challenger');
  });

  it('does not unseat a sitting champion on a lead smaller than the margin', () => {
    const current = { a: 'champion', b: 'champion', c: 'champion' } as const;
    const stats = [
      stat('a', 0.95, 40),
      stat('b', 0.93, 40),
      stat('c', 0.905, 40),
      stat('d', 0.907, 40),
    ];
    expect(conservativeScore(stats[3]) - conservativeScore(stats[2])).toBeLessThan(CHAMPION_PROMOTION_MARGIN);
    expect(assignRoles(stats, { ...current })['c']).toBe('champion');
    expect(assignRoles(stats, { ...current })['d']).toBe('challenger');
    // With no incumbency recorded, the ranking alone decides.
    expect(assignRoles(stats)['d']).toBe('champion');
  });

  it('never calls a paused model, however good its average looks', () => {
    const paused = { ...stat('broken', 0.99, 80), paused: true as const };
    expect(assignRoles([paused, stat('ok', 0.7, 40)])['broken']).toBe('paused');
  });
});

describe('pause rules', () => {
  const window = (composites: number[], successes: boolean[]) =>
    composites.map((value, index) => ({ composite: value, success: successes[index] }));

  it('pauses a model failing more than a fifth of its recent calls', () => {
    const recent = window(
      Array.from({ length: RECENT_WINDOW }, () => 0.9),
      Array.from({ length: RECENT_WINDOW }, (_, index) => index >= 5),
    );
    expect(applyPauseRules({ ...stat('m', 0.9, 40), recent, baseline: 0.9 })).toMatchObject({
      paused: true,
      pausedReason: 'failures',
    });
  });

  it('pauses a model that has got worse than its own baseline', () => {
    const recent = window(
      Array.from({ length: RECENT_WINDOW }, () => 0.8),
      Array.from({ length: RECENT_WINDOW }, () => true),
    );
    expect(applyPauseRules({ ...stat('m', 0.8, 40), recent, baseline: 0.9 })).toMatchObject({
      paused: true,
      pausedReason: 'regression',
    });
  });

  it('needs a full window before it will pause anything', () => {
    const recent = window([0, 0, 0], [false, false, false]);
    expect(applyPauseRules({ ...stat('m', 0.9, 3), recent, baseline: 0.9 }).paused).toBe(false);
  });
});

describe('scoreObservation', () => {
  const truth = {
    title: '은혜의 노래',
    order: ['I', 'V', 'C'],
    sections: [
      { label: 'V', lines: ['빛으로 인도하시네', '영원히 노래하리'] },
      { label: 'C', lines: ['높이 부르는 이름'] },
    ],
  };
  const attempt = { engine: 'openrouter' as const, model: 'nvidia/nemotron-nano-12b-v2-vl' };

  it('scores a perfect reading as one across every measured field', () => {
    const evaluation = scoreObservation({ attempt, score: { ...truth }, latencyMs: 1200 }, truth);
    expect(evaluation).toMatchObject({ title: 1, order: 1, success: true, latencyMs: 1200 });
    expect(evaluation.lyrics).toBeCloseTo(1, 6);
    // No artist in the truth, so none is scored.
    expect(evaluation.artist).toBeUndefined();
  });

  it('records a failed call as a failure rather than a zero-accuracy answer', () => {
    const evaluation = scoreObservation({ attempt, error: 'rate limited', latencyMs: 400 }, truth);
    expect(evaluation.success).toBe(false);
    expect(evaluation.lyrics).toBe(0);
  });

  it('scores the artist only when the verified truth carries one', () => {
    const withArtist = { ...truth, artist: '새로운 팀' };
    const evaluation = scoreObservation(
      { attempt, score: { ...withArtist, artist: '새로운 팀' }, latencyMs: 10 },
      withArtist,
    );
    expect(evaluation.artist).toBe(1);
    expect(scoreObservation({ attempt, score: { ...truth }, latencyMs: 10 }, withArtist).artist).toBe(0);
  });

  it('keys an observation by its migrated engine name', () => {
    expect(modelKeyFor({ engine: 'nvidia' as 'openrouter', model: 'x' })).toBe('openrouter:x');
  });
});

describe('merging evaluations', () => {
  const evaluation = { modelKey: 'openrouter:m', title: 1, order: 1, lyrics: 1, success: true, latencyMs: 100 };

  it('averages new evidence into the running statistics', () => {
    const first = mergeModelEvaluation(undefined, evaluation, NOW);
    const second = mergeModelEvaluation(first, { ...evaluation, lyrics: 0 }, NOW);
    expect(first.samples).toBe(1);
    expect(second.samples).toBe(2);
    expect(second.lyrics).toBeCloseTo(0.5, 6);
  });

  it('weights an old average down before folding in a new sample', () => {
    const old = mergeModelEvaluation(undefined, evaluation, NOW);
    const muchLater = new Date('2026-11-12T00:00:00.000Z'); // one half-life on
    const merged = mergeModelEvaluation(old, { ...evaluation, lyrics: 0 }, muchLater);
    expect(merged.samples).toBeCloseTo(1.5, 3);
    // The stale perfect sample now counts half as much as the fresh zero.
    expect(merged.lyrics).toBeCloseTo(1 / 3, 3);
  });

  it('produces exactly the same record as the proxy-side merge (kept in lockstep)', () => {
    const client = mergeModelEvaluation(mergeModelEvaluation(undefined, evaluation, NOW), evaluation, NOW);
    const worker = workerMerge(workerMerge(undefined, evaluation, NOW), evaluation, NOW);
    expect(client).toEqual(worker);
  });
});

describe('proxy-side evaluation validation', () => {
  const valid = { modelKey: 'openrouter:m', title: 1, order: 1, lyrics: 1, success: true, latencyMs: 100 };

  it('rejects a score outside 0–1, which no later sample could pull back', () => {
    expect(sanitizeModelEvaluation({ ...valid, lyrics: 1.4 })).toBeNull();
    expect(sanitizeModelEvaluation({ ...valid, title: -1 })).toBeNull();
    expect(sanitizeModelEvaluation({ ...valid, order: Number.POSITIVE_INFINITY })).toBeNull();
    expect(sanitizeModelEvaluation({ ...valid, artist: 2 })).toBeNull();
  });

  it('rejects an unknown engine and keeps the key encodable', () => {
    expect(sanitizeModelEvaluation({ ...valid, modelKey: 'huggingface:m' })).toBeNull();
    expect(sanitizeModelEvaluation({ ...valid, modelKey: 'openrouter:' })).toBeNull();
    expect(modelStatsKey('openrouter:google/gemma-4-31b-it:free')).toBe(
      'learning:model:openrouter:google%2Fgemma-4-31b-it%3Afree',
    );
  });

  it('accepts a well-formed evaluation with or without an artist', () => {
    expect(sanitizeModelEvaluation(valid)).toMatchObject({ modelKey: 'openrouter:m', success: true });
    expect(sanitizeModelEvaluation({ ...valid, artist: 0.5 })?.artist).toBe(0.5);
    expect(sanitizeModelEvaluation({ ...valid, success: 'yes' })?.success).toBe(false);
  });
});
