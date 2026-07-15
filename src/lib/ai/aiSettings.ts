// Fixed configuration for score recognition: Gemini primary (via the shared
// recognition proxy — see worker/ — or a build-time key), falling back to
// Hugging Face once Gemini's tokens/quota are exhausted or it otherwise fails.
// There is no user-facing settings screen; recognition always uses these
// defaults, so it works as soon as the recognize button is pressed.

export type RecognitionEngine = 'gemini' | 'huggingface' | 'off';

export interface AiSettings {
  engine: RecognitionEngine;
  geminiApiKey: string;
  geminiModel: string;
  /** Cross-check recognized lyrics against the web via Gemini's Google Search grounding. */
  geminiUseSearch: boolean;
  huggingfaceApiKey: string;
  /** Fallback engines to try if primary fails (e.g., ['huggingface']) */
  fallbackEngines: RecognitionEngine[];
}

export const DEFAULT_GEMINI_MODEL = 'gemini-2.5-flash';

export const DEFAULT_AI_SETTINGS: AiSettings = {
  engine: 'gemini',
  geminiApiKey: '',
  geminiModel: DEFAULT_GEMINI_MODEL,
  geminiUseSearch: true,
  huggingfaceApiKey: '',
  fallbackEngines: ['huggingface'],
};

/** Engines that can appear in the administrator-configured priority order. */
export const ORDERABLE_ENGINES: RecognitionEngine[] = ['gemini', 'huggingface'];

export const DEFAULT_RECOGNITION_ORDER: RecognitionEngine[] = [...ORDERABLE_ENGINES];

const RECOGNITION_ORDER_KEY = 'kccp-recognition-order';

/**
 * Coerce a stored value into a valid engine order: drop unknown entries and
 * duplicates, then append whichever engines are missing (in default order),
 * so every engine is always tried exactly once.
 */
export function sanitizeRecognitionOrder(raw: unknown): RecognitionEngine[] {
  const seen = new Set<RecognitionEngine>();
  const order: RecognitionEngine[] = [];
  if (Array.isArray(raw)) {
    for (const value of raw) {
      if (ORDERABLE_ENGINES.includes(value as RecognitionEngine) && !seen.has(value as RecognitionEngine)) {
        seen.add(value as RecognitionEngine);
        order.push(value as RecognitionEngine);
      }
    }
  }
  for (const engine of DEFAULT_RECOGNITION_ORDER) {
    if (!seen.has(engine)) order.push(engine);
  }
  return order;
}

/** Load the administrator-configured engine order (관리자 설정), if any. */
export function loadRecognitionOrder(): RecognitionEngine[] {
  try {
    const raw = localStorage.getItem(RECOGNITION_ORDER_KEY);
    return sanitizeRecognitionOrder(raw ? JSON.parse(raw) : null);
  } catch {
    return [...DEFAULT_RECOGNITION_ORDER];
  }
}

export function saveRecognitionOrder(order: RecognitionEngine[]): void {
  try {
    localStorage.setItem(RECOGNITION_ORDER_KEY, JSON.stringify(sanitizeRecognitionOrder(order)));
  } catch {
    // Private browsing without storage — the order just won't persist.
  }
}

/** Recognition settings honoring the administrator-configured engine order. */
export function getAiSettings(): AiSettings {
  const [engine, ...fallbackEngines] = loadRecognitionOrder();
  return { ...DEFAULT_AI_SETTINGS, engine, fallbackEngines };
}
