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

/** Most feedback records kept, so the learning store stays bounded. */
export const MAX_FEEDBACK_RECORDS = 2000;

const VERIFICATIONS = new Set(['verified', 'edited']);

function trimmed(value, maxLength) {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

/** Hex hash of the shape the client sends; also the storage key suffix. */
function validHash(value) {
  return typeof value === 'string' && /^[0-9a-f]{16,128}$/.test(value);
}

function sanitizeSections(raw) {
  if (!Array.isArray(raw)) return [];
  const sections = [];
  for (const candidate of raw.slice(0, 50)) {
    if (!candidate || typeof candidate !== 'object' || !Array.isArray(candidate.lines)) continue;
    const label = trimmed(candidate.label, 30);
    if (!label) continue;
    sections.push({
      label,
      lines: candidate.lines.filter((line) => typeof line === 'string').map((line) => line.slice(0, 500)).slice(0, 200),
    });
  }
  return sections;
}

function sanitizeScore(raw) {
  if (!raw || typeof raw !== 'object') return null;
  return {
    ...(trimmed(raw.title, 200) ? { title: trimmed(raw.title, 200) } : {}),
    ...(trimmed(raw.artist, 200) ? { artist: trimmed(raw.artist, 200) } : {}),
    ...(trimmed(raw.key, 20) ? { key: trimmed(raw.key, 20) } : {}),
    order: Array.isArray(raw.order)
      ? raw.order.map((token) => trimmed(token, 30)).filter(Boolean).slice(0, 200)
      : [],
    sections: sanitizeSections(raw.sections),
  };
}

/** The provenance of one offered web page — never its lyric text. */
function sanitizeWebCandidate(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const url = trimmed(raw.url, 500);
  if (!/^https?:\/\//.test(url)) return null;
  return {
    id: trimmed(raw.id, 200),
    title: trimmed(raw.title, 200),
    ...(trimmed(raw.artist, 200) ? { artist: trimmed(raw.artist, 200) } : {}),
    url,
    host: trimmed(raw.host, 200),
    source: trimmed(raw.source, 40),
    score: unitNumber(raw.score) ?? 0,
    titleScore: unitNumber(raw.titleScore) ?? 0,
    artistScore: unitNumber(raw.artistScore) ?? 0,
    lyricsScore: unitNumber(raw.lyricsScore) ?? 0,
    decision: ['auto', 'review', 'reject'].includes(raw.decision) ? raw.decision : 'reject',
  };
}

/**
 * Validate one verified correction.
 *
 * The page hash and the final hash together are the idempotency key: the same
 * page saved with the same answer is the same evidence, however many times the
 * client sends it, and counting it twice would inflate every model's sample
 * count.
 */
export function sanitizeFeedbackExample(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = trimmed(raw.id, 100);
  if (!id || !/^[A-Za-z0-9_-]+$/.test(id)) return null;
  if (!validHash(raw.pageHash) || !validHash(raw.finalHash)) return null;
  if (!VERIFICATIONS.has(raw.verification)) return null;
  const baseline = sanitizeScore(raw.baseline);
  const final = sanitizeScore(raw.final);
  if (!baseline || !final || final.sections.length === 0) return null;

  const createdAt = new Date(raw.createdAt);
  const observations = Array.isArray(raw.observations)
    ? raw.observations
        .slice(0, 12)
        .map((observation) => {
          if (!observation || typeof observation !== 'object') return null;
          const attempt = observation.attempt;
          if (!attempt || typeof attempt.engine !== 'string' || typeof attempt.model !== 'string') return null;
          const latency = Number(observation.latencyMs);
          return {
            attempt: { engine: trimmed(attempt.engine, 20), model: trimmed(attempt.model, 200) },
            ...(observation.score ? { score: sanitizeScore(observation.score) } : {}),
            ...(trimmed(observation.error, 30) ? { error: trimmed(observation.error, 30) } : {}),
            latencyMs: Number.isFinite(latency) && latency >= 0 ? Math.min(latency, 600_000) : 0,
          };
        })
        .filter(Boolean)
    : [];

  return {
    id,
    pageHash: raw.pageHash,
    finalHash: raw.finalHash,
    createdAt: Number.isFinite(createdAt.getTime()) ? createdAt.toISOString() : new Date().toISOString(),
    observations,
    baseline,
    final,
    webCandidates: Array.isArray(raw.webCandidates)
      ? raw.webCandidates.slice(0, 3).map(sanitizeWebCandidate).filter(Boolean)
      : [],
    ...(trimmed(raw.selectedWebCandidateId, 200)
      ? { selectedWebCandidateId: trimmed(raw.selectedWebCandidateId, 200) }
      : {}),
    diff: raw.diff && typeof raw.diff === 'object' ? raw.diff : {},
    verification: raw.verification,
    evaluations: Array.isArray(raw.evaluations)
      ? raw.evaluations.slice(0, 12).map(sanitizeModelEvaluation).filter(Boolean)
      : [],
  };
}

/** `learning:feedback:<pageHash>:<finalHash>` — the idempotency key itself. */
export function feedbackKey(example) {
  return `learning:feedback:${example.pageHash}:${example.finalHash}`;
}
