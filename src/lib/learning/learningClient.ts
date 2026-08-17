// Talking to the shared proxy's learning endpoints.
//
// Every call here is best-effort. Recognition has always worked with no proxy
// at all, and learning must not change that: a failed fetch means the pipeline
// runs on catalog defaults instead of measured accuracy, never that it stops.
import type { ModelReliability } from '../ai/modelReliability';
import { EMPTY_MEMORY, type LearningMemory } from './onlineLearning';
import { ADMIN_PASSWORD } from '../adminAuth';

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

function trimmedText(value: unknown, maxLength: number): string {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

function positiveInteger(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

/**
 * What the app has already learned to fix, or an empty memory.
 *
 * Empty is always a valid answer: with no proxy, or a proxy that is down,
 * recognition simply runs without the shortcuts it would otherwise have.
 */
export async function fetchLearningMemory(title = ''): Promise<LearningMemory> {
  const query = title.trim() ? `?title=${encodeURIComponent(title.trim().slice(0, 100))}` : '';
  const response = await learningFetch(`/learning/memory${query}`, {
    method: 'GET',
    headers: { Accept: 'application/json' },
  });
  if (!response?.ok) return EMPTY_MEMORY;
  try {
    const payload = (await response.json()) as Record<string, unknown>;
    return {
      titleAliases: (Array.isArray(payload.titleAliases) ? payload.titleAliases : [])
        .map((raw) => {
          const value = (raw ?? {}) as Record<string, unknown>;
          const from = trimmedText(value.from, 200);
          const to = trimmedText(value.to, 200);
          return from && to ? { from, to, support: positiveInteger(value.support) } : null;
        })
        .filter((alias): alias is LearningMemory['titleAliases'][number] => alias !== null),
      corrections: (Array.isArray(payload.corrections) ? payload.corrections : [])
        .map((raw) => {
          const value = (raw ?? {}) as Record<string, unknown>;
          const before = trimmedText(value.before, 120);
          const after = trimmedText(value.after, 120);
          if (!before || !after) return null;
          return {
            before,
            after,
            contextBefore: trimmedText(value.contextBefore, 40),
            contextAfter: trimmedText(value.contextAfter, 40),
            support: positiveInteger(value.support),
            seen: positiveInteger(value.seen),
          };
        })
        .filter((correction): correction is LearningMemory['corrections'][number] => correction !== null),
      examples: (Array.isArray(payload.examples) ? payload.examples : [])
        .map((raw) => {
          const value = (raw ?? {}) as Record<string, unknown>;
          const before = trimmedText(value.before, 120);
          const after = trimmedText(value.after, 120);
          if (!before || !after) return null;
          const example: LearningMemory['examples'][number] = { before, after };
          const exampleTitle = trimmedText(value.title, 200);
          if (exampleTitle) example.title = exampleTitle;
          const label = trimmedText(value.label, 30);
          if (label) example.label = label;
          return example;
        })
        .filter((example): example is LearningMemory['examples'][number] => example !== null)
        .slice(0, 3),
    };
  } catch {
    return EMPTY_MEMORY;
  }
}

/** Chunk size the proxy expects for a training image. */
const TRAINING_CHUNK_BYTES = 1024 * 1024;

function adminHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { Authorization: `Bearer ${ADMIN_PASSWORD}`, ...extra };
}

/**
 * Store one verified page in the training corpus: metadata first, then the
 * image in chunks.
 *
 * Best-effort like everything else here. A save has already succeeded by the
 * time this runs, so a failure costs one training example and nothing the user
 * can see.
 */
export async function uploadTrainingRecord(
  manifest: Record<string, unknown>,
  image?: Uint8Array,
): Promise<boolean> {
  const stored = await learningFetch('/learning/corpus', {
    method: 'PUT',
    headers: adminHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ manifest }),
  });
  if (!stored?.ok) return false;
  if (!image) return true;

  const id = String(manifest.id);
  for (let index = 0; index * TRAINING_CHUNK_BYTES < image.byteLength; index += 1) {
    const chunk = image.slice(index * TRAINING_CHUNK_BYTES, (index + 1) * TRAINING_CHUNK_BYTES);
    const response = await learningFetch(`/learning/corpus/${encodeURIComponent(id)}/chunks/${index}`, {
      method: 'PUT',
      headers: adminHeaders({ 'Content-Type': 'application/octet-stream' }),
      body: chunk as BodyInit,
    });
    if (!response?.ok) return false;
  }
  return true;
}

export interface TrainingCorpusStatus {
  total: number;
  verified: number;
  edited: number;
  withImage: number;
  exported: number;
  bytes: number;
  limit: number;
}

export async function fetchTrainingCorpusStatus(): Promise<TrainingCorpusStatus | null> {
  const response = await learningFetch('/learning/corpus', { method: 'GET', headers: adminHeaders() });
  if (!response?.ok) return null;
  try {
    return (await response.json()) as TrainingCorpusStatus;
  } catch {
    return null;
  }
}
