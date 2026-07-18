// Configuration for score recognition. Recognition works through an ordered
// list of ATTEMPTS — each one an engine plus a specific model — tried top to
// bottom until one succeeds. The order is managed in 관리자 설정 and stored
// on the shared recognition proxy (see worker/), so a change made on one
// device applies to everyone; localStorage keeps the last-known order as an
// offline cache. There is no per-user settings screen — recognition works
// out of the box with the defaults below.

export type RecognitionEngine = 'gemini' | 'nvidia' | 'huggingface' | 'off';

/** One recognition try: an engine and the exact model it should use. */
export interface RecognitionAttempt {
  engine: Exclude<RecognitionEngine, 'off'>;
  model: string;
}

export interface RecognitionModelInfo extends RecognitionAttempt {
  /** Short human label shown in 관리자 설정. */
  label: string;
  /** One-line description of when this model shines. */
  note: string;
}

/**
 * Every model recognition launches concurrently, grouped here by provider for
 * stable display. This is the
 * single source of truth: the concurrent model pool, the sanitizer, and the
 * proxy's OpenRouter allowlist all derive from it.
 *
 * Gemini 2.5 Flash and NVIDIA Nemotron Nano are the two PRIMARY models —
 * catalog order is priority order (earlier entries win a page when multiple
 * models answer it), so they lead the list. Every model after them is a
 * supporting/assistant model: it only fills in whatever the primary pair's
 * answers are missing (see fillScoreGaps in scoreRecognition.ts), never
 * overriding a primary model's answer for the same field.
 */
export const RECOGNITION_MODEL_CATALOG: RecognitionModelInfo[] = [
  // The 50-song accuracy benchmark measured Flash at 97-98% on this task.
  // Only Gemini models with a free API tier belong in
  // this catalog; paid-only models deliberately stay out of the concurrent pool.
  {
    engine: 'gemini',
    model: 'gemini-2.5-flash',
    label: 'Gemini 2.5 Flash',
    note: '주 모델 — 벤치마크 정확도 97%+, 주 1회 콘티는 무료 한도로 충분합니다',
  },
  {
    engine: 'nvidia',
    model: 'nvidia/nemotron-nano-12b-v2-vl',
    label: 'NVIDIA Nemotron Nano 12B VL · OpenRouter Free',
    note: '주 모델 — 문서·악보 OCR 특화 (입력과 출력이 공급자에 기록되는 시험용 무료 엔드포인트)',
  },
  {
    engine: 'gemini',
    model: 'gemini-2.0-flash',
    label: 'Gemini 2.0 Flash',
    note: '보조 모델 — 별도의 무료 한도를 가진 예비 Gemini',
  },
  {
    engine: 'nvidia',
    model: 'google/gemma-4-31b-it:free',
    label: 'OpenRouter Gemma 4 31B · Free',
    note: '보조 모델 — 강력한 대형 멀티모달 예비 모델, 이미지·텍스트 이해 및 구조화 출력',
  },
  {
    engine: 'nvidia',
    model: 'google/gemma-3-27b-it:free',
    label: 'OpenRouter Gemma 3 27B · Free',
    note: '보조 모델 — 140개 이상 언어를 지원하는 다국어 비전 모델, 한국어 가사 예비 인식',
  },
  {
    engine: 'huggingface',
    model: 'Qwen/Qwen2-VL-7B-Instruct',
    label: 'Hugging Face Qwen2-VL 7B',
    note: '보조 모델 — 마지막 예비 엔진',
  },
];

/** Stable display/storage order; execution starts every entry concurrently. */
export const DEFAULT_ATTEMPT_ORDER: RecognitionAttempt[] = RECOGNITION_MODEL_CATALOG.map(
  ({ engine, model }) => ({ engine, model }),
);

/**
 * Titles that must never appear in 찬양 편집 — songs the fixed slides
 * already cover (공동체 고백송) or that are sung before the service starts.
 * Editable in 관리자 설정; matching is normalized-substring, so an entry
 * matches a recognized title that contains it.
 */
export const DEFAULT_EXCLUDED_TITLES: string[] = ['공동체 고백송', '예배 전 준비 찬양'];

/** The part of the settings shared across every device via the proxy. */
export interface SharedRecognitionSettings {
  attempts: RecognitionAttempt[];
  excludedTitles: string[];
}

export const DEFAULT_SHARED_SETTINGS: SharedRecognitionSettings = {
  attempts: [...DEFAULT_ATTEMPT_ORDER],
  excludedTitles: [...DEFAULT_EXCLUDED_TITLES],
};

export interface AiSettings extends SharedRecognitionSettings {
  geminiApiKey: string;
  /** Model for the quick title-identification pass (speed matters there). */
  geminiModel: string;
  /** Cross-check recognized lyrics against the web via Gemini's Google Search grounding. */
  geminiUseSearch: boolean;
  openrouterApiKey: string;
  huggingfaceApiKey: string;
}

export const DEFAULT_GEMINI_MODEL = 'gemini-2.5-flash';

export const DEFAULT_AI_SETTINGS: AiSettings = {
  attempts: [...DEFAULT_ATTEMPT_ORDER],
  excludedTitles: [...DEFAULT_EXCLUDED_TITLES],
  geminiApiKey: '',
  geminiModel: DEFAULT_GEMINI_MODEL,
  geminiUseSearch: true,
  openrouterApiKey: '',
  huggingfaceApiKey: '',
};

export function attemptKey(attempt: RecognitionAttempt): string {
  return `${attempt.engine}:${attempt.model}`;
}

export function findModelInfo(attempt: RecognitionAttempt): RecognitionModelInfo | undefined {
  return RECOGNITION_MODEL_CATALOG.find(
    (entry) => entry.engine === attempt.engine && entry.model === attempt.model,
  );
}

/**
 * Coerce a stored/received value into a valid attempt order: keep only
 * catalog entries, drop duplicates, then append whichever catalog models are
 * missing (in default order) so newly added models are always reachable and
 * every model appears exactly once. Legacy plain-engine entries ("gemini")
 * from the pre-catalog format expand into that engine's catalog models.
 */
export function sanitizeAttemptOrder(raw: unknown): RecognitionAttempt[] {
  const seen = new Set<string>();
  const order: RecognitionAttempt[] = [];
  const push = (attempt: RecognitionAttempt) => {
    const key = attemptKey(attempt);
    if (!seen.has(key)) {
      seen.add(key);
      order.push({ engine: attempt.engine, model: attempt.model });
    }
  };
  if (Array.isArray(raw)) {
    for (const value of raw) {
      if (typeof value === 'string') {
        // Legacy format: an engine name — expand to its catalog models.
        for (const entry of RECOGNITION_MODEL_CATALOG) {
          if (entry.engine === value) push(entry);
        }
        continue;
      }
      const candidate = value as Partial<RecognitionAttempt> | null;
      if (!candidate || typeof candidate.engine !== 'string' || typeof candidate.model !== 'string') continue;
      const known = RECOGNITION_MODEL_CATALOG.find(
        (entry) => entry.engine === candidate.engine && entry.model === candidate.model,
      );
      if (known) push(known);
    }
  }
  for (const entry of DEFAULT_ATTEMPT_ORDER) push(entry);
  return order;
}

/**
 * Coerce a stored/received exclusion list: non-empty trimmed strings only,
 * deduplicated (case/spacing-insensitively), capped to sane sizes.
 */
export function sanitizeExcludedTitles(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [...DEFAULT_EXCLUDED_TITLES];
  const seen = new Set<string>();
  const titles: string[] = [];
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

export function sanitizeSharedSettings(raw: unknown): SharedRecognitionSettings {
  const obj = (raw ?? {}) as Record<string, unknown>;
  return {
    attempts: sanitizeAttemptOrder(obj.attempts),
    excludedTitles: sanitizeExcludedTitles(obj.excludedTitles),
  };
}

const SHARED_SETTINGS_KEY = 'kccp-shared-recognition-settings';
/** Pre-catalog storage key that held plain engine names. */
const LEGACY_ORDER_KEY = 'kccp-recognition-order';

/** Last-known shared settings from this browser (offline cache). */
export function loadLocalSharedSettings(): SharedRecognitionSettings {
  try {
    const raw = localStorage.getItem(SHARED_SETTINGS_KEY);
    if (raw) return sanitizeSharedSettings(JSON.parse(raw));
    const legacy = localStorage.getItem(LEGACY_ORDER_KEY);
    if (legacy) return sanitizeSharedSettings({ attempts: JSON.parse(legacy) });
    return {
      attempts: [...DEFAULT_ATTEMPT_ORDER],
      excludedTitles: [...DEFAULT_EXCLUDED_TITLES],
    };
  } catch {
    return {
      attempts: [...DEFAULT_ATTEMPT_ORDER],
      excludedTitles: [...DEFAULT_EXCLUDED_TITLES],
    };
  }
}

export function saveLocalSharedSettings(settings: SharedRecognitionSettings): void {
  try {
    localStorage.setItem(SHARED_SETTINGS_KEY, JSON.stringify(sanitizeSharedSettings(settings)));
  } catch {
    // Private browsing without storage — the settings just won't persist locally.
  }
}

/** Strip a trailing slash so callers can pass either form of a base URL. */
function trimTrailingSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}

function proxyUrl(): string | undefined {
  return import.meta.env.VITE_RECOGNITION_PROXY_URL?.trim() || undefined;
}

export function hasSharedSettings(): boolean {
  return !!proxyUrl();
}

/**
 * Fetch the shared settings from the recognition proxy. Returns null when
 * there is no proxy or the request fails — callers fall back to the local
 * cache. A successful fetch refreshes the cache so the shared settings
 * survive offline reloads.
 */
export async function fetchSharedSettings(signal?: AbortSignal): Promise<SharedRecognitionSettings | null> {
  const base = proxyUrl();
  if (!base) return null;
  try {
    const response = await fetch(`${trimTrailingSlash(base)}/settings`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal,
    });
    if (!response.ok) return null;
    const settings = sanitizeSharedSettings((await response.json()) as unknown);
    saveLocalSharedSettings(settings);
    return settings;
  } catch {
    return null;
  }
}

/**
 * Publish new shared settings so every device picks them up. The password
 * is the 관리자 설정 password — the proxy checks it server-side (same soft
 * gate as the admin panel itself). Throws with a readable message on
 * failure; on success the local cache and memo refresh immediately.
 */
export async function pushSharedSettings(
  settings: SharedRecognitionSettings,
  password: string,
): Promise<void> {
  const base = proxyUrl();
  if (!base) throw new Error('공유 프록시가 연결되지 않아 이 브라우저에만 저장됩니다.');
  const clean = sanitizeSharedSettings(settings);
  const response = await fetch(`${trimTrailingSlash(base)}/settings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password, ...clean }),
  });
  if (!response.ok) {
    let detail = `HTTP ${response.status}`;
    try {
      const payload = (await response.json()) as { error?: string };
      if (payload.error) detail = payload.error;
    } catch {
      // keep the status code
    }
    throw new Error(`공유 설정 저장 실패: ${detail}`);
  }
  saveLocalSharedSettings(clean);
  invalidateSharedSettings();
}

// The shared settings are fetched at most once per page load (recognition
// runs close together); an admin save invalidates the memo so the same
// session sees its own change immediately.
let sharedSettingsMemo: Promise<SharedRecognitionSettings | null> | null = null;

export function invalidateSharedSettings(): void {
  sharedSettingsMemo = null;
}

/** Recognition settings honoring the shared (or locally cached) settings. */
export async function getSyncedAiSettings(): Promise<AiSettings> {
  if (!sharedSettingsMemo) sharedSettingsMemo = fetchSharedSettings();
  const shared = (await sharedSettingsMemo) ?? loadLocalSharedSettings();
  return { ...DEFAULT_AI_SETTINGS, ...shared };
}

/** Synchronous settings from the local cache (tests, non-async callers). */
export function getAiSettings(): AiSettings {
  return { ...DEFAULT_AI_SETTINGS, ...loadLocalSharedSettings() };
}
