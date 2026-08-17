// Talking to the shared proxy's learning endpoints.
//
// Every call here is best-effort. Recognition has always worked with no proxy
// at all, and learning must not change that: a failed fetch means the pipeline
// runs on catalog defaults instead of measured accuracy, never that it stops.
import type { ModelReliability } from '../ai/modelReliability';

const PROXY_URL = import.meta.env.VITE_RECOGNITION_PROXY_URL?.trim() || undefined;

/** How long a learning lookup may hold up recognition. */
const LEARNING_TIMEOUT_MS = 6000;

export function hasLearningProxy(): boolean {
  return !!PROXY_URL;
}

function trimTrailingSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}

export function learningUrl(path: string): string | undefined {
  return PROXY_URL ? `${trimTrailingSlash(PROXY_URL)}${path}` : undefined;
}

/** Fetch with a hard timeout so a slow proxy cannot stall a conti. */
export async function learningFetch(path: string, init: RequestInit = {}): Promise<Response | null> {
  const url = learningUrl(path);
  if (!url) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LEARNING_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function unitNumber(value: unknown, fallback = 0): number {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 && number <= 1 ? number : fallback;
}

/** Coerce one proxy row into the shape the ranking math expects. */
export function sanitizeReliability(raw: unknown): ModelReliability | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>;
  if (typeof value.modelKey !== 'string' || !value.modelKey) return null;
  const samples = Number(value.samples);
  return {
    modelKey: value.modelKey,
    samples: Number.isFinite(samples) && samples >= 0 ? samples : 0,
    title: unitNumber(value.title),
    artist: unitNumber(value.artist),
    artistSamples: Number.isFinite(Number(value.artistSamples)) ? Number(value.artistSamples) : 0,
    order: unitNumber(value.order),
    lyrics: unitNumber(value.lyrics),
    successRate: unitNumber(value.successRate),
    latencyMs: Number.isFinite(Number(value.latencyMs)) ? Number(value.latencyMs) : 0,
    updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : new Date().toISOString(),
    // The proxy sends only the window's size; the window itself never leaves it.
    recent: [],
    baseline: unitNumber(value.baseline),
    paused: value.paused === true,
  };
}

/**
 * Measured per-model accuracy, or an empty list when there is no proxy or the
 * lookup fails — in which case the catalog's declared roles decide instead.
 */
export async function fetchModelReliabilities(): Promise<ModelReliability[]> {
  const response = await learningFetch('/learning/models', {
    method: 'GET',
    headers: { Accept: 'application/json' },
  });
  if (!response?.ok) return [];
  try {
    const payload = (await response.json()) as { models?: unknown };
    if (!Array.isArray(payload.models)) return [];
    return payload.models
      .map(sanitizeReliability)
      .filter((value): value is ModelReliability => value !== null);
  } catch {
    return [];
  }
}
