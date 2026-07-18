// Shared recognition settings (concurrent model pool + excluded titles) served by
// the proxy so every device sees the same configuration. Pure helpers live
// here so they can be unit-tested; storage happens in the Durable Object.
//
// The catalog mirrors src/lib/ai/aiSettings.ts (a unit test keeps the two in
// sync). The Worker validates everything it stores or relays: only catalog
// models can be used. Every OpenAI-compatible vision model is
// pinned to an OpenRouter :free model. Arbitrary model IDs can never spend
// the shared OpenRouter key.

import { DEFAULT_NVIDIA_MODEL } from './usage.js';

/** The OpenRouter free variant used for the existing Nemotron catalog slot. */
export const OPENROUTER_NEMOTRON_MODEL = `${DEFAULT_NVIDIA_MODEL}:free`;

// Order is priority order (earlier entries win a page when several models
// answer it — see fillScoreGaps in src/lib/ai/scoreRecognition.ts). Gemini
// 2.5 Flash and Nemotron Nano are the two PRIMARY models; everything after
// them is a supporting/assistant model that only fills gaps the primary
// pair's answers left. Mirrors src/lib/ai/aiSettings.ts exactly.
export const RECOGNITION_MODEL_CATALOG = [
  { engine: 'gemini', model: 'gemini-2.5-flash' },
  { engine: 'nvidia', model: 'nvidia/nemotron-nano-12b-v2-vl' },
  { engine: 'gemini', model: 'gemini-2.0-flash' },
  { engine: 'nvidia', model: 'google/gemma-4-31b-it:free' },
  { engine: 'nvidia', model: 'google/gemma-3-27b-it:free' },
  { engine: 'huggingface', model: 'Qwen/Qwen2-VL-7B-Instruct' },
];

const OPENROUTER_MODEL_ALIASES = new Map([
  [DEFAULT_NVIDIA_MODEL, OPENROUTER_NEMOTRON_MODEL],
  ['google/gemma-4-31b-it:free', 'google/gemma-4-31b-it:free'],
  ['google/gemma-3-27b-it:free', 'google/gemma-3-27b-it:free'],
]);

export const DEFAULT_EXCLUDED_TITLES = ['공동체 고백송', '예배 전 준비 찬양'];

// Same soft gate as the client's 관리자 설정 — this is a static site with no
// user accounts, so the password only keeps casual visitors from rewriting
// the shared configuration. Override with the ADMIN_PASSWORD Worker secret.
export const DEFAULT_ADMIN_PASSWORD = 'kccpmedia1980';

function attemptKey(attempt) {
  return `${attempt.engine}:${attempt.model}`;
}

/** Keep only catalog entries, dedupe, then append missing catalog models. */
export function sanitizeAttemptOrder(raw) {
  const seen = new Set();
  const order = [];
  const push = (attempt) => {
    const key = attemptKey(attempt);
    if (!seen.has(key)) {
      seen.add(key);
      order.push({ engine: attempt.engine, model: attempt.model });
    }
  };
  if (Array.isArray(raw)) {
    for (const value of raw) {
      if (typeof value === 'string') {
        for (const entry of RECOGNITION_MODEL_CATALOG) {
          if (entry.engine === value) push(entry);
        }
        continue;
      }
      if (!value || typeof value.engine !== 'string' || typeof value.model !== 'string') continue;
      const known = RECOGNITION_MODEL_CATALOG.find(
        (entry) => entry.engine === value.engine && entry.model === value.model,
      );
      if (known) push(known);
    }
  }
  for (const entry of RECOGNITION_MODEL_CATALOG) push(entry);
  return order;
}

/** Non-empty trimmed strings, deduped case/spacing-insensitively, capped. */
export function sanitizeExcludedTitles(raw) {
  if (!Array.isArray(raw)) return [...DEFAULT_EXCLUDED_TITLES];
  const seen = new Set();
  const titles = [];
  for (const value of raw) {
    if (typeof value !== 'string') continue;
    const title = value.trim().slice(0, 100);
    if (!title) continue;
    const key = title.replace(/\s+/g, '').toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    titles.push(title);
    if (titles.length >= 100) break;
  }
  return titles;
}

export function sanitizeSharedSettings(raw) {
  const obj = raw && typeof raw === 'object' ? raw : {};
  return {
    attempts: sanitizeAttemptOrder(obj.attempts),
    excludedTitles: sanitizeExcludedTitles(obj.excludedTitles),
  };
}

/** Catalog models POST /openrouter may forward to with the shared key. */
export function allowedOpenRouterModels() {
  return new Set(
    RECOGNITION_MODEL_CATALOG.filter((entry) => entry.engine === 'nvidia').map((entry) => entry.model),
  );
}

/**
 * Resolve the shared `/openrouter` catalog request to its exact free upstream
 * slug. Nemotron keeps its suffix-free client ID for stored-settings
 * compatibility; the Worker adds `:free` before forwarding it.
 */
export function resolveOpenRouterRoute(requested) {
  const configuredModel = allowedOpenRouterModels().has(requested) ? requested : DEFAULT_NVIDIA_MODEL;
  return {
    configuredModel,
    upstreamModel: OPENROUTER_MODEL_ALIASES.get(configuredModel) || OPENROUTER_NEMOTRON_MODEL,
  };
}

export function adminPassword(env = {}) {
  return env.ADMIN_PASSWORD || DEFAULT_ADMIN_PASSWORD;
}

/**
 * Every model in the system as the {provider, model} pair it is METERED
 * under, so the 사용량 page can show a card per model even before its first
 * request. The OpenRouter lane meters the exact upstream :free slug the
 * Worker forwards to; Hugging Face meters whatever model the proxy is
 * pinned to (HUGGINGFACE_MODEL env override included).
 */
export function usageCatalogModels(env = {}) {
  const models = [];
  for (const entry of RECOGNITION_MODEL_CATALOG) {
    if (entry.engine === 'gemini') {
      models.push({ provider: 'gemini', model: entry.model });
    } else if (entry.engine === 'nvidia') {
      models.push({ provider: 'openrouter', model: resolveOpenRouterRoute(entry.model).upstreamModel });
    } else if (entry.engine === 'huggingface') {
      models.push({ provider: 'huggingface', model: env.HUGGINGFACE_MODEL || entry.model });
    }
  }
  return models;
}
