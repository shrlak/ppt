// Configuration for score recognition. Recognition works through an ordered
// list of ATTEMPTS — each one an engine plus a specific model — tried top to
// bottom until one succeeds. The order is managed in 관리자 설정 and stored
// on the shared recognition proxy (see worker/), so a change made on one
// device applies to everyone; localStorage keeps the last-known order as an
// offline cache. There is no per-user settings screen — recognition works
// out of the box with the defaults below.

export type RecognitionEngine = 'gemini' | 'openrouter' | 'off';

/** One recognition try: an engine and the exact model it should use. */
export interface RecognitionAttempt {
  engine: Exclude<RecognitionEngine, 'off'>;
  model: string;
}

/**
 * What a model is currently allowed to do.
 *
 * 'champion'   — one of the three models every page is read by.
 * 'challenger' — called only for a page the champions were not sure about.
 * 'paused'     — failing or regressing; not called at all until it recovers.
 */
export type ModelRole = 'champion' | 'challenger' | 'paused';

export interface RecognitionModelInfo extends RecognitionAttempt {
  /** Short human label shown in 관리자 설정. */
  label: string;
  /** One-line description of when this model shines. */
  note: string;
  /** Starting role, used until measured reliability takes over (see modelReliability.ts). */
  role: ModelRole;
  /**
   * Exact slug the request is forwarded to. It differs from `model` only for
   * the legacy suffix-free Nemotron ID, which stored settings still carry;
   * every OpenRouter route ends in `:free` so the shared key can never be
   * spent on a paid model.
   */
  upstreamModel: string;
}

/**
 * Map an engine name from stored settings onto a current one.
 *
 * The OpenRouter lane was originally called 'nvidia' because Nemotron was its
 * only model. Renaming it in place would have invalidated every device's
 * cached settings, so the old name is migrated here instead.
 */
export function migrateEngineName(value: unknown): 'gemini' | 'openrouter' | undefined {
  if (value === 'gemini') return 'gemini';
  if (value === 'openrouter' || value === 'nvidia') return 'openrouter';
  return undefined;
}

/** True unless this entry would route an OpenRouter call to a non-free model. */
export function isFreeVisionCatalogEntry(entry: RecognitionModelInfo): boolean {
  return entry.engine !== 'openrouter' || entry.upstreamModel.endsWith(':free');
}

/**
 * The complete model pool, grouped by provider for stable display. This is the
 * single source of truth: the concurrent model pool, the sanitizer, and the
 * proxy's OpenRouter allowlist all derive from it.
 *
 * Each entry declares a starting ROLE. Champions read every page; challengers
 * are called only for a page the champions disagreed on (see
 * adaptiveRecognition.ts). These are starting values only — once a model has
 * enough verified corrections behind it, measured reliability decides its role
 * instead (see modelReliability.ts).
 *
 * ENTRY BAR: a model earns a slot only if it is (a) genuinely free — free API
 * tier or an OpenRouter `:free` endpoint — and (b) currently among the
 * strongest free vision models for this job, which is reading small Korean
 * lyric type under a staff and recovering the part labels and 진행 순서 from
 * the page. Weak or superseded models are removed rather than kept as a last
 * resort: an extra answer that is usually wrong costs accuracy in the merge
 * (line-level consensus lets models outvote each other) and burns free quota
 * that a strong model could have spent.
 */
export const RECOGNITION_MODEL_CATALOG: RecognitionModelInfo[] = [
  // Google's free tier carries Flash and Flash-Lite only (Pro models left it
  // in April 2026), so the two strongest Flash releases are the primaries.
  // They meter against separate quotas, so running both costs nothing extra.
  {
    engine: 'gemini',
    model: 'gemini-3.6-flash',
    upstreamModel: 'gemini-3.6-flash',
    role: 'champion',
    label: 'Gemini 3.6 Flash',
    note: '주 모델 — 현재 무료 티어에서 가장 강력한 Gemini (10 RPM · 1,500 RPD)',
  },
  {
    engine: 'gemini',
    model: 'gemini-3.5-flash',
    upstreamModel: 'gemini-3.5-flash',
    role: 'champion',
    label: 'Gemini 3.5 Flash',
    note: '주 모델 — 별도 무료 한도를 가진 상위 Gemini (15 RPM · 1,500 RPD)',
  },
  {
    engine: 'openrouter',
    model: 'nvidia/nemotron-nano-12b-v2-vl',
    upstreamModel: 'nvidia/nemotron-nano-12b-v2-vl:free',
    role: 'champion',
    label: 'NVIDIA Nemotron Nano 12B VL · OpenRouter Free',
    note: '주 모델 — 문서 OCR·표 인식 특화로 악보의 작은 가사 글씨에 강합니다',
  },
  {
    engine: 'openrouter',
    model: 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free',
    upstreamModel: 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free',
    role: 'challenger',
    label: 'NVIDIA Nemotron 3 Nano Omni 30B (reasoning) · Free',
    note: '교차 검증 — 추론형 멀티모달, 1절·2절이 겹쳐 적힌 악보의 구조 판단에 강합니다',
  },
  {
    engine: 'openrouter',
    model: 'dots-studio/dots-3-note-preview:free',
    upstreamModel: 'dots-studio/dots-3-note-preview:free',
    role: 'challenger',
    label: 'dots.note 3 (preview) · Free',
    note: '교차 검증 — 필기·인쇄가 섞인 문서 이미지에 특화된 신규 무료 모델',
  },
  {
    engine: 'openrouter',
    model: 'google/gemma-4-31b-it:free',
    upstreamModel: 'google/gemma-4-31b-it:free',
    role: 'challenger',
    // gemma-4-26b-a4b-it was benchmarked and rejected; do not re-add it.
    note: '교차 검증 — Gemini와 다른 계열의 오독을 잡아내는 대형 오픈 웨이트 모델',
    label: 'Google Gemma 4 31B IT · Free',
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

/**
 * The song sung as the 공동체 고백송. Its lyric slides live inside the fixed
 * back-slides deck, so this is what the generator rewrites that block to —
 * and what the 콘티 splits off from the songs that need generated slides.
 * The default is the song the bundled back deck already prints.
 */
export const DEFAULT_CONFESSION_SONG = 'Celebrate the Light';

/** The part of the settings shared across every device via the proxy. */
export interface SharedRecognitionSettings {
  attempts: RecognitionAttempt[];
  excludedTitles: string[];
  /**
   * Title of this season's 공동체 고백송, looked up in the 곡 라이브러리 to
   * rewrite the back deck's 공동체 고백 block. An empty string means "leave
   * the back slides exactly as they were supplied".
   */
  confessionSong: string;
  /**
   * Roles the administrator pinned by hand, keyed by `engine:model`.
   *
   * Measured accuracy decides roles on its own. This exists for the cases
   * measurement cannot see yet: a provider announcing a deprecation, or a
   * model that has started returning something odd in a way the pause rules
   * have not caught. An override always wins.
   */
  roleOverrides: Partial<Record<string, ModelRole>>;
}

export const DEFAULT_SHARED_SETTINGS: SharedRecognitionSettings = {
  attempts: [...DEFAULT_ATTEMPT_ORDER],
  excludedTitles: [...DEFAULT_EXCLUDED_TITLES],
  confessionSong: DEFAULT_CONFESSION_SONG,
  roleOverrides: {},
};

export interface AiSettings extends SharedRecognitionSettings {
  geminiApiKey: string;
  /** Model for the quick title-identification pass (speed matters there). */
  geminiModel: string;
  /** Cross-check recognized lyrics against the web via Gemini's Google Search grounding. */
  geminiUseSearch: boolean;
  openrouterApiKey: string;
}

export const DEFAULT_GEMINI_MODEL = 'gemini-3.6-flash';

export const DEFAULT_AI_SETTINGS: AiSettings = {
  attempts: [...DEFAULT_ATTEMPT_ORDER],
  excludedTitles: [...DEFAULT_EXCLUDED_TITLES],
  confessionSong: DEFAULT_CONFESSION_SONG,
  roleOverrides: {},
  geminiApiKey: '',
  geminiModel: DEFAULT_GEMINI_MODEL,
  geminiUseSearch: true,
  openrouterApiKey: '',
};

export function attemptKey(attempt: RecognitionAttempt): string {
  return `${attempt.engine}:${attempt.model}`;
}

export function findModelInfo(attempt: RecognitionAttempt): RecognitionModelInfo | undefined {
  const engine = migrateEngineName(attempt.engine);
  if (!engine) return undefined;
  return RECOGNITION_MODEL_CATALOG.find((entry) => entry.engine === engine && entry.model === attempt.model);
}

/**
 * Coerce a stored/received value into a valid attempt order: keep only
 * catalog entries, drop duplicates, then append whichever catalog models are
 * missing (in default order) so newly added models are always reachable and
 * every model appears exactly once. Legacy plain-engine entries ("gemini")
 * from the pre-catalog format expand into that engine's catalog models, and
 * the legacy "nvidia" engine name is migrated to "openrouter" with its model
 * left untouched.
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
        const engine = migrateEngineName(value);
        if (!engine) continue;
        for (const entry of RECOGNITION_MODEL_CATALOG) {
          if (entry.engine === engine) push(entry);
        }
        continue;
      }
      const candidate = value as Partial<RecognitionAttempt> | null;
      if (!candidate || typeof candidate.model !== 'string') continue;
      const engine = migrateEngineName(candidate.engine);
      if (!engine) continue;
      const known = RECOGNITION_MODEL_CATALOG.find(
        (entry) => entry.engine === engine && entry.model === candidate.model,
      );
      // A model that is not in the catalog — a paid route, or one this build
      // no longer ships — is dropped rather than silently swapped for another.
      if (known && isFreeVisionCatalogEntry(known)) push(known);
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

/**
 * Coerce a stored/received 공동체 고백송 title. Anything that is not a string
 * falls back to the default (the song the bundled back deck prints); an
 * explicitly blank title is kept, and means "don't touch the back slides".
 */
export function sanitizeConfessionSong(raw: unknown): string {
  if (typeof raw !== 'string') return DEFAULT_CONFESSION_SONG;
  return raw.trim().slice(0, 100);
}

/**
 * Keep only overrides that name a catalog model and a real role. An override
 * for a model this build no longer ships would otherwise sit in shared
 * settings forever, invisible and unexplained.
 */
export function sanitizeRoleOverrides(raw: unknown): Partial<Record<string, ModelRole>> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const roles: ModelRole[] = ['champion', 'challenger', 'paused'];
  const overrides: Partial<Record<string, ModelRole>> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!roles.includes(value as ModelRole)) continue;
    const known = RECOGNITION_MODEL_CATALOG.find((entry) => attemptKey(entry) === key);
    if (known) overrides[key] = value as ModelRole;
  }
  return overrides;
}

export function sanitizeSharedSettings(raw: unknown): SharedRecognitionSettings {
  const obj = (raw ?? {}) as Record<string, unknown>;
  return {
    attempts: sanitizeAttemptOrder(obj.attempts),
    excludedTitles: sanitizeExcludedTitles(obj.excludedTitles),
    confessionSong: sanitizeConfessionSong(obj.confessionSong),
    roleOverrides: sanitizeRoleOverrides(obj.roleOverrides),
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
    return { ...DEFAULT_SHARED_SETTINGS, attempts: [...DEFAULT_ATTEMPT_ORDER] };
  } catch {
    return { ...DEFAULT_SHARED_SETTINGS, attempts: [...DEFAULT_ATTEMPT_ORDER] };
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
