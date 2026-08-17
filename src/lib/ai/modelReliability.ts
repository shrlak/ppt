// How much each free vision model can be trusted, measured from verified user
// corrections rather than assumed from a catalog order.
//
// Every recognition produces one observation per model. When the user later
// saves that song as verified or edited, the saved version becomes truth and
// each observation is scored against it (see feedbackQueue.ts). Those scores
// accumulate here, and they decide two things: how much weight a model's
// answer carries in consensus, and whether it is called on every page
// (champion), held back for uncertain pages (challenger), or not called at
// all (paused).
//
// Everything in this file is a pure function of its inputs. The Worker stores
// the aggregates; worker/src/modelStats.js mirrors the merge math and a unit
// test keeps the two in lockstep.
import type { ModelRole, RecognitionAttempt, RecognitionModelInfo } from './aiSettings';
import { attemptKey, migrateEngineName } from './aiSettings';
import { lyricsSimilarity, orderSimilarity, textSimilarity } from './recognitionScoring';
import type { ParsedScore } from './scoreParser';

/** Evaluations before a model may be judged on its statistics at all. */
export const MIN_CHAMPION_SAMPLES = 20;

/** How many models read every page. */
export const CHAMPION_SLOTS = 3;

/** Lead a challenger needs to take a slot from a sitting champion. */
export const CHAMPION_PROMOTION_MARGIN = 0.02;

/** Rolling window the pause rules look at. */
export const RECENT_WINDOW = 20;

/** Failure rate over the recent window that pauses a model. */
export const PAUSE_FAILURE_RATE = 0.2;

/** Drop below the model's own prior baseline that pauses it. */
export const PAUSE_REGRESSION = 0.05;

/** Half-life of an evaluation's influence, in days. */
export const DECAY_HALF_LIFE_DAYS = 90;

/** Accuracy of one model's answer for one page, field by field. */
export interface FieldAccuracy {
  title: number;
  /** Undefined when the verified truth printed no artist to compare against. */
  artist?: number;
  order: number;
  lyrics: number;
  success: boolean;
  latencyMs: number;
}

/** One evaluation ready to be merged into a model's running statistics. */
export interface ModelEvaluation extends FieldAccuracy {
  modelKey: string;
}

/** A model's accumulated accuracy, as stored by the Worker. */
export interface ModelReliability {
  modelKey: string;
  samples: number;
  title: number;
  artist: number;
  /** How many of the samples actually had an artist to compare. */
  artistSamples: number;
  order: number;
  lyrics: number;
  successRate: number;
  latencyMs: number;
  updatedAt: string;
  /** Composite of each of the last RECENT_WINDOW evaluations, newest last. */
  recent: { composite: number; success: boolean }[];
  /** Composite as of before the current window, for regression detection. */
  baseline: number;
  paused?: boolean;
  pausedReason?: 'failures' | 'regression';
}

/** Anything shaped like a settled model call (see recognitionObservation.ts). */
export interface ObservationLike {
  attempt: RecognitionAttempt;
  score?: ParsedScore;
  error?: string;
  latencyMs: number;
}

/** Stable storage/lookup key for a model, robust to the legacy engine name. */
export function modelKeyFor(attempt: RecognitionAttempt): string {
  return attemptKey({ engine: migrateEngineName(attempt.engine) ?? attempt.engine, model: attempt.model });
}

export function emptyReliability(modelKey: string, now = new Date()): ModelReliability {
  return {
    modelKey,
    samples: 0,
    title: 0,
    artist: 0,
    artistSamples: 0,
    order: 0,
    lyrics: 0,
    successRate: 0,
    latencyMs: 0,
    updatedAt: now.toISOString(),
    recent: [],
    baseline: 0,
  };
}

/**
 * Overall accuracy of a set of field scores.
 *
 * Lyrics dominate because they are what ends up on the slide: a model that
 * reads the title perfectly and the words badly is useless here. When no
 * artist was measured its weight goes to the title rather than being dropped,
 * so a model measured on artist-less scores is not scored out of a smaller
 * total than one that was.
 */
export function compositeAccuracy(fields: {
  title: number;
  artist?: number;
  order: number;
  lyrics: number;
}): number {
  const hasArtist = typeof fields.artist === 'number';
  const artistWeight = hasArtist ? 0.1 : 0;
  const titleWeight = 0.2 - artistWeight;
  return (
    titleWeight * fields.title +
    artistWeight * (fields.artist ?? 0) +
    0.1 * fields.order +
    0.7 * fields.lyrics
  );
}

/** Overall accuracy of a model's accumulated statistics. */
export function composite(value: ModelReliability): number {
  return compositeAccuracy({
    title: value.title,
    artist: value.artistSamples > 0 ? value.artist : undefined,
    order: value.order,
    lyrics: value.lyrics,
  });
}

/**
 * Accuracy we are confident the model actually has, not the accuracy it
 * happened to show.
 *
 * This is the Wilson score lower bound. The textbook normal-approximation
 * interval collapses to nothing when a model is 3-for-3, which would let a
 * model with a single lucky page outrank one measured over fifty — exactly the
 * mistake this ranking exists to prevent. Wilson stays wide at small n and
 * tightens as evidence accumulates, so a new model has to earn its way up.
 */
export function conservativeScore(value: ModelReliability): number {
  const p = Math.min(1, Math.max(0, composite(value)));
  const n = Math.max(0, value.samples);
  if (n <= 0) return 0;
  const z = 1.96;
  const z2 = z * z;
  const denominator = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denominator;
  const margin = (z / denominator) * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  return Math.max(0, center - margin);
}

/** Days between two instants, never negative. */
function daysBetween(from: string, to: Date): number {
  const started = new Date(from).getTime();
  if (!Number.isFinite(started)) return 0;
  return Math.max(0, (to.getTime() - started) / 86_400_000);
}

/**
 * Weight older evidence less. A model that was strong three months ago and has
 * not been used since should not outrank one measured last week, and a
 * provider that silently swapped its serving model should be re-earned rather
 * than coasting on an old average.
 */
export function decayFactor(updatedAt: string, now: Date): number {
  return 0.5 ** (daysBetween(updatedAt, now) / DECAY_HALF_LIFE_DAYS);
}

/** Score one model's answer against the verified truth for that page. */
export function scoreObservation(
  observation: ObservationLike,
  truth: { title?: string; artist?: string; order: string[]; sections: ParsedScore['sections'] },
): ModelEvaluation {
  const modelKey = modelKeyFor(observation.attempt);
  const score = observation.score;
  if (!score) {
    // A call that never answered is a failure, not a zero-accuracy answer.
    // Averaging it in as 0% would make an exhausted free quota look identical
    // to a catastrophic quality regression.
    return {
      modelKey,
      title: 0,
      artist: truth.artist ? 0 : undefined,
      order: 0,
      lyrics: 0,
      success: false,
      latencyMs: Math.max(0, observation.latencyMs),
    };
  }
  return {
    modelKey,
    title: textSimilarity(score.title ?? '', truth.title ?? ''),
    // Only an artist the verified truth actually carries can be scored.
    artist: truth.artist ? textSimilarity(score.artist ?? '', truth.artist) : undefined,
    order: orderSimilarity(score.order, truth.order),
    lyrics: lyricsSimilarity(score, truth),
    success: true,
    latencyMs: Math.max(0, observation.latencyMs),
  };
}

function blend(previous: number, weight: number, value: number): number {
  return weight + 1 <= 0 ? value : (previous * weight + value) / (weight + 1);
}

/**
 * Fold one evaluation into a model's running statistics, ageing what is
 * already there first, and re-check the pause rules afterwards.
 */
export function mergeModelEvaluation(
  current: ModelReliability | undefined | null,
  evaluation: ModelEvaluation,
  now = new Date(),
): ModelReliability {
  const base = current ?? emptyReliability(evaluation.modelKey, now);
  const decay = decayFactor(base.updatedAt, now);
  const weight = base.samples * decay;
  const artistWeight = base.artistSamples * decay;
  const hasArtist = typeof evaluation.artist === 'number';

  const merged: ModelReliability = {
    modelKey: evaluation.modelKey,
    samples: weight + 1,
    title: blend(base.title, weight, evaluation.title),
    artist: hasArtist ? blend(base.artist, artistWeight, evaluation.artist as number) : base.artist,
    artistSamples: hasArtist ? artistWeight + 1 : artistWeight,
    order: blend(base.order, weight, evaluation.order),
    lyrics: blend(base.lyrics, weight, evaluation.lyrics),
    successRate: blend(base.successRate, weight, evaluation.success ? 1 : 0),
    latencyMs: blend(base.latencyMs, weight, evaluation.latencyMs),
    updatedAt: now.toISOString(),
    recent: [...base.recent, { composite: compositeAccuracy(evaluation), success: evaluation.success }].slice(
      -RECENT_WINDOW,
    ),
    baseline: base.baseline,
  };

  // The baseline is what the model looked like BEFORE the current window, so a
  // regression is measured against its own past rather than against the pool.
  if (base.recent.length >= RECENT_WINDOW) {
    merged.baseline = base.recent.reduce((sum, item) => sum + item.composite, 0) / base.recent.length;
  } else if (base.samples === 0) {
    merged.baseline = compositeAccuracy(evaluation);
  }

  return applyPauseRules(merged);
}

/**
 * Pause a model that has started failing or has got worse.
 *
 * Both rules read the recent window only: a model that was excellent for two
 * months and broke yesterday must stop being called today, and a lifetime
 * average is far too slow to notice that. A full window is required first, so
 * two bad pages in a row cannot pause a model.
 */
export function applyPauseRules(value: ModelReliability): ModelReliability {
  const next: ModelReliability = { ...value, paused: false };
  delete next.pausedReason;
  if (value.recent.length < RECENT_WINDOW) return next;

  const failures = value.recent.filter((item) => !item.success).length / value.recent.length;
  if (failures > PAUSE_FAILURE_RATE) {
    return { ...next, paused: true, pausedReason: 'failures' };
  }

  const recentComposite = value.recent.reduce((sum, item) => sum + item.composite, 0) / value.recent.length;
  if (value.baseline > 0 && recentComposite < value.baseline - PAUSE_REGRESSION) {
    return { ...next, paused: true, pausedReason: 'regression' };
  }
  return next;
}

/** A catalog model with whatever has been measured about it so far. */
export interface RankedModel {
  engine: RecognitionAttempt['engine'];
  model: string;
  modelKey: string;
  /** Role from the catalog, before measurements are applied. */
  catalogRole: ModelRole;
  reliability?: ModelReliability;
  samples: number;
  conservative: number;
  paused: boolean;
}

/**
 * Order the catalog by how well each model has actually done, best first.
 *
 * Confidence in a measurement ages: a model's sample count is decayed by how
 * long ago it was last evaluated, so stale evidence widens the interval and
 * the model drifts down rather than sitting on an old score forever.
 */
export function rankModels(
  catalog: RecognitionModelInfo[],
  stats: ModelReliability[],
  now = new Date(),
): RankedModel[] {
  const byKey = new Map(stats.map((value) => [value.modelKey, value]));
  return catalog
    .map((entry) => {
      const modelKey = modelKeyFor(entry);
      const reliability = byKey.get(modelKey);
      const aged = reliability
        ? { ...reliability, samples: reliability.samples * decayFactor(reliability.updatedAt, now) }
        : undefined;
      return {
        engine: entry.engine,
        model: entry.model,
        modelKey,
        catalogRole: entry.role,
        reliability,
        samples: aged?.samples ?? 0,
        conservative: aged ? conservativeScore(aged) : 0,
        paused: !!reliability?.paused,
      };
    })
    .sort((a, b) => b.conservative - a.conservative);
}

/**
 * Decide who reads every page and who waits in reserve.
 *
 * A model needs MIN_CHAMPION_SAMPLES verified evaluations before its
 * statistics are allowed to decide anything: below that, one lucky page is
 * indistinguishable from real skill. Among models that clear the bar, the top
 * CHAMPION_SLOTS by conservative score are champions. When `currentRoles` says
 * who is already a champion, an incumbent is only displaced by a lead of
 * CHAMPION_PROMOTION_MARGIN, so the pool does not churn on noise.
 */
export function assignRoles(
  stats: ModelReliability[],
  currentRoles: Record<string, ModelRole> = {},
): Record<string, ModelRole> {
  const roles: Record<string, ModelRole> = {};
  const eligible: ModelReliability[] = [];
  for (const value of stats) {
    if (value.paused) {
      roles[value.modelKey] = 'paused';
      continue;
    }
    if (value.samples < MIN_CHAMPION_SAMPLES) {
      roles[value.modelKey] = 'challenger';
      continue;
    }
    eligible.push(value);
  }

  const score = new Map(eligible.map((value) => [value.modelKey, conservativeScore(value)]));
  const ordered = [...eligible].sort((a, b) => (score.get(b.modelKey) ?? 0) - (score.get(a.modelKey) ?? 0));
  const champions = ordered.slice(0, CHAMPION_SLOTS);
  const isIncumbent = (value: ModelReliability) => currentRoles[value.modelKey] === 'champion';

  // Hand a slot back to any sitting champion the newcomer did not clearly
  // beat. Without this the pool would churn every week on measurement noise,
  // and each swap costs the incoming model a fresh warm-up period.
  const benched = ordered.slice(CHAMPION_SLOTS).filter(isIncumbent);
  for (const incumbent of benched) {
    const weakestNewcomer = [...champions]
      .filter((value) => !isIncumbent(value))
      .sort((a, b) => (score.get(a.modelKey) ?? 0) - (score.get(b.modelKey) ?? 0))[0];
    if (!weakestNewcomer) break;
    const lead = (score.get(weakestNewcomer.modelKey) ?? 0) - (score.get(incumbent.modelKey) ?? 0);
    if (lead >= CHAMPION_PROMOTION_MARGIN) continue;
    champions.splice(champions.indexOf(weakestNewcomer), 1, incumbent);
  }

  for (const value of ordered) {
    roles[value.modelKey] = champions.includes(value) ? 'champion' : 'challenger';
  }
  return roles;
}
