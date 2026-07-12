// Persistence for the score-recognition settings: which engine to use and,
// for Gemini, the user's own (free) Google AI Studio API key. Everything is
// kept in this browser's localStorage only — the key is never sent anywhere
// except directly to Google when a score is recognized.

export type RecognitionEngine = 'gemini' | 'huggingface' | 'tesseract' | 'off';

export interface AiSettings {
  engine: RecognitionEngine;
  geminiApiKey: string;
  geminiModel: string;
  /** Cross-check recognized lyrics against the web via Gemini's Google Search grounding. */
  geminiUseSearch: boolean;
  huggingfaceApiKey: string;
  /** Fallback engines to try if primary fails (e.g., ['huggingface', 'tesseract']) */
  fallbackEngines: RecognitionEngine[];
}

const STORAGE_KEY = 'praise-lyrics-ai-settings';

export const DEFAULT_GEMINI_MODEL = 'gemini-2.5-flash';
// 'gemini-2.5-flash-lite' was briefly the default but isn't a valid model for
// this API version and made every recognition call fail — auto-revert anyone
// who got switched onto it back to the known-working model.
const BROKEN_GEMINI_MODEL = 'gemini-2.5-flash-lite';

export const DEFAULT_AI_SETTINGS: AiSettings = {
  engine: 'gemini',
  geminiApiKey: '',
  geminiModel: DEFAULT_GEMINI_MODEL,
  geminiUseSearch: true,
  huggingfaceApiKey: '',
  fallbackEngines: ['huggingface', 'tesseract'],
};

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

export function loadAiSettings(): AiSettings {
  const store = storage();
  if (!store) return { ...DEFAULT_AI_SETTINGS };
  try {
    const raw = store.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_AI_SETTINGS };
    const data = JSON.parse(raw) as Partial<AiSettings>;
    const fallbackEngines = Array.isArray(data.fallbackEngines)
      ? data.fallbackEngines.filter((e): e is RecognitionEngine => ['gemini', 'huggingface', 'tesseract', 'off'].includes(e))
      : DEFAULT_AI_SETTINGS.fallbackEngines;
    return {
      engine: ['huggingface', 'tesseract', 'off'].includes(data.engine ?? '') ? (data.engine as RecognitionEngine) : 'gemini',
      geminiApiKey: typeof data.geminiApiKey === 'string' ? data.geminiApiKey : '',
      geminiModel:
        typeof data.geminiModel === 'string' && data.geminiModel.trim()
          ? data.geminiModel.trim() === BROKEN_GEMINI_MODEL
            ? DEFAULT_GEMINI_MODEL
            : data.geminiModel.trim()
          : DEFAULT_GEMINI_MODEL,
      geminiUseSearch: typeof data.geminiUseSearch === 'boolean' ? data.geminiUseSearch : true,
      huggingfaceApiKey: typeof data.huggingfaceApiKey === 'string' ? data.huggingfaceApiKey : '',
      fallbackEngines,
    };
  } catch {
    return { ...DEFAULT_AI_SETTINGS };
  }
}

export function saveAiSettings(settings: AiSettings): void {
  storage()?.setItem(STORAGE_KEY, JSON.stringify(settings));
}

/**
 * Whether a score should be auto-recognized on upload with these settings.
 * Gemini and Hugging Face need a personal key UNLESS a shared recognition
 * proxy is configured for this build (see worker/) — then a blank key still
 * works, since the request is routed through the proxy's own key instead.
 * The keyless OCR engine is ready as soon as it's picked.
 */
export function isRecognitionReady(settings: AiSettings): boolean {
  if (settings.engine === 'off') return false;
  const proxyConfigured = Boolean(import.meta.env.VITE_RECOGNITION_PROXY_URL?.trim());
  if (settings.engine === 'gemini') return settings.geminiApiKey.trim().length > 0 || proxyConfigured;
  if (settings.engine === 'huggingface') return settings.huggingfaceApiKey.trim().length > 0 || proxyConfigured;
  return true;
}
