// Storage shape for per-model reliability, kept by the shared proxy.
//
// The client measures a model's answer against the lyrics the user verified
// and posts the resulting field scores here; the Worker only aggregates. That
// split matters for privacy: the proxy stores accuracy NUMBERS, never the
// lyrics or the score image they were derived from, so the learning record
// cannot leak copyrighted text.
//
// The merge math mirrors src/lib/ai/modelReliability.ts exactly. A unit test
// keeps the two in lockstep, the same way config.js mirrors aiSettings.ts.

export const MIN_CHAMPION_SAMPLES = 20;
export const RECENT_WINDOW = 20;
export const PAUSE_FAILURE_RATE = 0.2;
export const PAUSE_REGRESSION = 0.05;
export const DECAY_HALF_LIFE_DAYS = 90;

/** Most models we will ever keep statistics for; bounds the storage listing. */
export const MAX_TRACKED_MODELS = 100;

const ENGINES = new Set(['gemini', 'openrouter']);

/** `learning:model:<engine>:<encoded-model>` */
export function modelStatsKey(modelKey) {
  const separator = String(modelKey ?? '').indexOf(':');
  if (separator <= 0) return null;
  const engine = modelKey.slice(0, separator);
  const model = modelKey.slice(separator + 1);
  if (!ENGINES.has(engine) || !model || model.length > 200) return null;
  return `learning:model:${engine}:${encodeURIComponent(model)}`;
}

function unitNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 && number <= 1 ? number : null;
}

/**
 * Validate one client-calculated evaluation. Every accuracy must be a finite
 * number in [0,1]: an out-of-range value would poison a running average that
 * no later evaluation could pull back.
 */
export function sanitizeModelEvaluation(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (typeof raw.modelKey !== 'string' || !modelStatsKey(raw.modelKey)) return null;
  const title = unitNumber(raw.title);
  const order = unitNumber(raw.order);
  const lyrics = unitNumber(raw.lyrics);
  if (title === null || order === null || lyrics === null) return null;
  const artist = raw.artist === undefined || raw.artist === null ? undefined : unitNumber(raw.artist);
  if (artist === null) return null;
  const latency = Number(raw.latencyMs);
  return {
    modelKey: raw.modelKey,
    title,
    ...(artist === undefined ? {} : { artist }),
    order,
    lyrics,
    success: raw.success === true,
    latencyMs: Number.isFinite(latency) && latency >= 0 ? Math.min(latency, 600_000) : 0,
  };
}

/** Overall accuracy; see compositeAccuracy in src/lib/ai/modelReliability.ts. */
export function compositeAccuracy(fields) {
  const hasArtist = typeof fields.artist === 'number';
  const artistWeight = hasArtist ? 0.1 : 0;
  const titleWeight = 0.2 - artistWeight;
  return (
    titleWeight * fields.title + artistWeight * (fields.artist ?? 0) + 0.1 * fields.order + 0.7 * fields.lyrics
  );
}

export function composite(value) {
  return compositeAccuracy({
    title: value.title,
    artist: value.artistSamples > 0 ? value.artist : undefined,
    order: value.order,
    lyrics: value.lyrics,
  });
}

export function emptyReliability(modelKey, now = new Date()) {
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

export function decayFactor(updatedAt, now) {
  const started = new Date(updatedAt).getTime();
  if (!Number.isFinite(started)) return 1;
  const days = Math.max(0, (now.getTime() - started) / 86_400_000);
  return 0.5 ** (days / DECAY_HALF_LIFE_DAYS);
}

function blend(previous, weight, value) {
  return weight + 1 <= 0 ? value : (previous * weight + value) / (weight + 1);
}

/** Pause a model that started failing or got worse than its own past. */
export function applyPauseRules(value) {
  const next = { ...value, paused: false };
  delete next.pausedReason;
  if (value.recent.length < RECENT_WINDOW) return next;

  const failures = value.recent.filter((item) => !item.success).length / value.recent.length;
  if (failures > PAUSE_FAILURE_RATE) return { ...next, paused: true, pausedReason: 'failures' };

  const recentComposite = value.recent.reduce((sum, item) => sum + item.composite, 0) / value.recent.length;
  if (value.baseline > 0 && recentComposite < value.baseline - PAUSE_REGRESSION) {
    return { ...next, paused: true, pausedReason: 'regression' };
  }
  return next;
}

/** Fold one evaluation into a model's running statistics, ageing first. */
export function mergeModelEvaluation(current, evaluation, now = new Date()) {
  const base = current ?? emptyReliability(evaluation.modelKey, now);
  const decay = decayFactor(base.updatedAt, now);
  const weight = base.samples * decay;
  const artistWeight = base.artistSamples * decay;
  const hasArtist = typeof evaluation.artist === 'number';

  const merged = {
    modelKey: evaluation.modelKey,
    samples: weight + 1,
    title: blend(base.title, weight, evaluation.title),
    artist: hasArtist ? blend(base.artist, artistWeight, evaluation.artist) : base.artist,
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

  if (base.recent.length >= RECENT_WINDOW) {
    merged.baseline = base.recent.reduce((sum, item) => sum + item.composite, 0) / base.recent.length;
  } else if (base.samples === 0) {
    merged.baseline = compositeAccuracy(evaluation);
  }

  return applyPauseRules(merged);
}

/**
 * The public view of a model's statistics: accuracy and counts only. Nothing
 * derived from lyric TEXT ever leaves the Worker, so the dashboard can be read
 * by anyone who can reach the proxy.
 */
export function publicModelStats(value) {
  return {
    modelKey: value.modelKey,
    samples: Number(value.samples.toFixed(3)),
    title: value.title,
    artist: value.artist,
    artistSamples: Number(value.artistSamples.toFixed(3)),
    order: value.order,
    lyrics: value.lyrics,
    successRate: value.successRate,
    latencyMs: Math.round(value.latencyMs),
    composite: composite(value),
    updatedAt: value.updatedAt,
    paused: !!value.paused,
    ...(value.pausedReason ? { pausedReason: value.pausedReason } : {}),
    recentSamples: value.recent.length,
  };
}
