// Shared recognition settings (model priority + excluded titles) served by
// the proxy so every device sees the same configuration. Pure helpers live
// here so they can be unit-tested; storage happens in the Durable Object.
//
// The catalog mirrors src/lib/ai/aiSettings.ts (a unit test keeps the two in
// sync). The Worker validates everything it stores or relays: only catalog
// models can be prioritized, and only catalog NVIDIA models (plus the
// NVIDIA_MODEL env override) may be requested through POST /nvidia — the
// shared key must not be usable with arbitrary expensive models.

export const RECOGNITION_MODEL_CATALOG = [
  { engine: 'gemini', model: 'gemini-2.5-pro' },
  { engine: 'gemini', model: 'gemini-2.5-flash' },
  { engine: 'gemini', model: 'gemini-2.0-flash' },
  { engine: 'nvidia', model: 'nvidia/nemotron-nano-12b-v2-vl' },
  { engine: 'nvidia', model: 'meta/llama-3.2-90b-vision-instruct' },
  { engine: 'nvidia', model: 'google/gemma-3-27b-it' },
  { engine: 'nvidia', model: 'microsoft/phi-4-multimodal-instruct' },
  { engine: 'huggingface', model: 'Qwen/Qwen2-VL-7B-Instruct' },
];

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

/** NVIDIA models POST /nvidia may forward to with the shared key. */
export function allowedNvidiaModels(env = {}) {
  const models = new Set(
    RECOGNITION_MODEL_CATALOG.filter((entry) => entry.engine === 'nvidia').map((entry) => entry.model),
  );
  if (env.NVIDIA_MODEL) models.add(env.NVIDIA_MODEL);
  return models;
}

export function adminPassword(env = {}) {
  return env.ADMIN_PASSWORD || DEFAULT_ADMIN_PASSWORD;
}
