// Shared recognition settings (concurrent model pool + excluded titles) served by
// the proxy so every device sees the same configuration. Pure helpers live
// here so they can be unit-tested; storage happens in the Durable Object.
//
// The catalog mirrors src/lib/ai/aiSettings.ts (a unit test keeps the two in
// sync). The Worker validates everything it stores or relays: only catalog
// models can be used. Every OpenAI-compatible vision model is
// pinned to an OpenRouter :free model. Arbitrary model IDs can never spend
// the shared OpenRouter key.

// Each entry declares its starting ROLE: champions read every page,
// challengers are called only for pages the champions disagreed on. Only
// currently-best free vision models belong here — see the entry bar
// documented in src/lib/ai/aiSettings.ts, which this mirrors exactly.
//
// `upstreamModel` is what the proxy actually forwards to. Every OpenRouter
// route ends in `:free`, so the shared key can never be spent on a paid
// model. A model the catalog no longer lists (Nemotron Nano 12B VL, whose free
// endpoint OpenRouter withdrew) is refused and dropped from stored settings.
export const RECOGNITION_MODEL_CATALOG = [
  { engine: 'gemini', model: 'gemini-3.6-flash', upstreamModel: 'gemini-3.6-flash', role: 'champion' },
  { engine: 'gemini', model: 'gemini-3.5-flash', upstreamModel: 'gemini-3.5-flash', role: 'champion' },
  { engine: 'gemini', model: 'gemini-3.5-flash-lite', upstreamModel: 'gemini-3.5-flash-lite', role: 'champion' },
  { engine: 'gemini', model: 'gemini-3.7-flash', upstreamModel: 'gemini-3.7-flash', role: 'challenger' },
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

/** Song the back deck's 공동체 고백 block is rewritten to, unless changed. */
export const DEFAULT_CONFESSION_SONG = '우리는 주의 움직이는 교회';

/** The 고백송 the bundled back deck prints — and the default before version 2. */
export const BUNDLED_CONFESSION_SONG = 'Celebrate the Light';

/** The 설교 후 찬양 a Sunday deck gets when its conti names none. */
export const DEFAULT_POST_SERMON_SONG = '영접송';

/**
 * Which defaults stored settings were saved under. Before version 2 the
 * bundled deck's 고백송 was stored because it was the default, and moves to
 * the new default once; saved at version 2 it is a choice, and stays.
 */
export const SETTINGS_DEFAULTS_VERSION = 2;

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
  return withMissingCatalogModels(order);
}

/**
 * A stored order plus the catalog models it does not list yet, each right
 * after the listed model that comes before it in the catalog (mirrors
 * src/lib/ai/aiSettings.ts): a new primary model is not queued behind every
 * slow challenger.
 */
function withMissingCatalogModels(order) {
  const rank = (attempt) => RECOGNITION_MODEL_CATALOG.findIndex((entry) => attemptKey(entry) === attemptKey(attempt));
  const result = [...order];
  for (const entry of RECOGNITION_MODEL_CATALOG) {
    if (result.some((attempt) => attemptKey(attempt) === attemptKey(entry))) continue;
    const own = rank(entry);
    let at = 0;
    result.forEach((attempt, index) => {
      if (rank(attempt) < own) at = index + 1;
    });
    result.splice(at, 0, { engine: entry.engine, model: entry.model });
  }
  return result;
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

/** A 공동체 고백송 title; a blank one means "leave the back slides alone". */
export function sanitizeConfessionSong(raw, defaultsVersion = SETTINGS_DEFAULTS_VERSION) {
  if (typeof raw !== 'string') return DEFAULT_CONFESSION_SONG;
  const title = raw.trim().slice(0, 100);
  const legacyDefault =
    defaultsVersion !== SETTINGS_DEFAULTS_VERSION && title.toLowerCase() === BUNDLED_CONFESSION_SONG.toLowerCase();
  return legacyDefault ? DEFAULT_CONFESSION_SONG : title;
}

/** A 설교 후 찬양 title; a blank one means "add none". */
export function sanitizePostSermonSong(raw) {
  if (typeof raw !== 'string') return DEFAULT_POST_SERMON_SONG;
  return raw.trim().slice(0, 100);
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
    // No version stored means saved before versions existed (1).
    confessionSong: sanitizeConfessionSong(obj.confessionSong, obj.defaultsVersion ?? 1),
    postSermonSong: sanitizePostSermonSong(obj.postSermonSong),
    defaultsVersion: SETTINGS_DEFAULTS_VERSION,
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
 * wrong model.
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
