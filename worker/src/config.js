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

// Each entry declares its starting ROLE: champions read every page,
// challengers are called only for pages the champions disagreed on. Only
// currently-best free vision models belong here — see the entry bar
// documented in src/lib/ai/aiSettings.ts, which this mirrors exactly.
//
// `upstreamModel` is what the proxy actually forwards to. It differs from
// `model` only for the legacy suffix-free Nemotron ID that stored settings
// still carry; every OpenRouter route ends in `:free`, so the shared key can
// never be spent on a paid model.
export const RECOGNITION_MODEL_CATALOG = [
  { engine: 'gemini', model: 'gemini-3.6-flash', upstreamModel: 'gemini-3.6-flash', role: 'champion' },
  { engine: 'gemini', model: 'gemini-3.5-flash', upstreamModel: 'gemini-3.5-flash', role: 'champion' },
  {
    engine: 'openrouter',
    model: 'nvidia/nemotron-nano-12b-v2-vl',
    upstreamModel: OPENROUTER_NEMOTRON_MODEL,
    role: 'champion',
  },
  {
    engine: 'openrouter',
    model: 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free',
    upstreamModel: 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free',
    role: 'challenger',
  },
  {
    engine: 'openrouter',
    model: 'dots-studio/dots-3-note-preview:free',
    upstreamModel: 'dots-studio/dots-3-note-preview:free',
    role: 'challenger',
  },
  {
    engine: 'openrouter',
    model: 'google/gemma-4-31b-it:free',
    upstreamModel: 'google/gemma-4-31b-it:free',
    role: 'challenger',
  },
];

/**
 * Map an engine name from stored settings onto a current one. The OpenRouter
 * lane used to be called 'nvidia'; migrating here keeps every device's cached
 * settings valid instead of discarding them.
 */
export function migrateEngineName(value) {
  if (value === 'gemini') return 'gemini';
  if (value === 'openrouter' || value === 'nvidia') return 'openrouter';
  return undefined;
}

/** True unless this entry would route an OpenRouter call to a non-free model. */
export function isFreeVisionCatalogEntry(entry) {
  return entry.engine !== 'openrouter' || entry.upstreamModel.endsWith(':free');
}

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
        const legacyEngine = migrateEngineName(value);
        if (!legacyEngine) continue;
        for (const entry of RECOGNITION_MODEL_CATALOG) {
          if (entry.engine === legacyEngine) push(entry);
        }
        continue;
      }
      if (!value || typeof value.model !== 'string') continue;
      const engine = migrateEngineName(value.engine);
      if (!engine) continue;
      const known = RECOGNITION_MODEL_CATALOG.find(
        (entry) => entry.engine === engine && entry.model === value.model,
      );
      // A model that is not in the catalog — a paid route, or one this build
      // no longer ships — is dropped rather than silently swapped for another.
      if (known && isFreeVisionCatalogEntry(known)) push(known);
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

/** Keep only overrides that name a catalog model and a real role. */
export function sanitizeRoleOverrides(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const roles = ['champion', 'challenger', 'paused'];
  const overrides = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!roles.includes(value)) continue;
    if (RECOGNITION_MODEL_CATALOG.some((entry) => attemptKey(entry) === key)) overrides[key] = value;
  }
  return overrides;
}

export function sanitizeSharedSettings(raw) {
  const obj = raw && typeof raw === 'object' ? raw : {};
  return {
    attempts: sanitizeAttemptOrder(obj.attempts),
    excludedTitles: sanitizeExcludedTitles(obj.excludedTitles),
    roleOverrides: sanitizeRoleOverrides(obj.roleOverrides),
  };
}

/** Catalog models POST /openrouter may forward to with the shared key. */
export function allowedOpenRouterModels() {
  return new Set(
    RECOGNITION_MODEL_CATALOG.filter((entry) => entry.engine === 'openrouter').map((entry) => entry.model),
  );
}

/**
 * Resolve a shared `/openrouter` catalog request to its exact free upstream
 * slug, or null when the requested model is not one this proxy will pay for.
 *
 * Rejecting is deliberate: quietly substituting another model would spend the
 * shared key on a request nobody asked for and would report accuracy for the
 * wrong model. Nemotron keeps its suffix-free client ID for stored-settings
 * compatibility, and the Worker adds `:free` before forwarding it.
 */
export function resolveOpenRouterRoute(requested) {
  const known = RECOGNITION_MODEL_CATALOG.find(
    (entry) => entry.engine === 'openrouter' && entry.model === requested,
  );
  if (!known || !isFreeVisionCatalogEntry(known)) return null;
  return { configuredModel: known.model, upstreamModel: known.upstreamModel };
}

export function adminPassword(env = {}) {
  return env.ADMIN_PASSWORD || DEFAULT_ADMIN_PASSWORD;
}

/**
 * Every model in the system as the {provider, model} pair it is METERED
 * under, so the 사용량 page can show a card per model even before its first
 * request. The OpenRouter lane meters the exact upstream :free slug the
 * Worker forwards to, which is why this is not just the catalog itself.
 */
export function usageCatalogModels() {
  const models = [];
  for (const entry of RECOGNITION_MODEL_CATALOG) {
    if (entry.engine === 'gemini') {
      models.push({ provider: 'gemini', model: entry.model });
    } else if (entry.engine === 'openrouter') {
      models.push({ provider: 'openrouter', model: entry.upstreamModel });
    }
  }
  return models;
}
