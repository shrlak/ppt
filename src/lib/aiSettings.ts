// Persistence for the score-recognition settings: which engine to use and,
// for Gemini, the user's own (free) Google AI Studio API key. Everything is
// kept in this browser's localStorage only — the key is never sent anywhere
// except directly to Google when a score is recognized.

export type RecognitionEngine = 'gemini' | 'tesseract' | 'off';

export interface AiSettings {
  engine: RecognitionEngine;
  geminiApiKey: string;
  geminiModel: string;
  /** Cross-check recognized lyrics against the web via Gemini's Google Search grounding. */
  geminiUseSearch: boolean;
}

const STORAGE_KEY = 'praise-lyrics-ai-settings';

export const DEFAULT_GEMINI_MODEL = 'gemini-2.5-flash';

export const DEFAULT_AI_SETTINGS: AiSettings = {
  engine: 'gemini',
  geminiApiKey: '',
  geminiModel: DEFAULT_GEMINI_MODEL,
  geminiUseSearch: true,
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
    return {
      engine: data.engine === 'tesseract' || data.engine === 'off' ? data.engine : 'gemini',
      geminiApiKey: typeof data.geminiApiKey === 'string' ? data.geminiApiKey : '',
      geminiModel:
        typeof data.geminiModel === 'string' && data.geminiModel.trim()
          ? data.geminiModel.trim()
          : DEFAULT_GEMINI_MODEL,
      geminiUseSearch: typeof data.geminiUseSearch === 'boolean' ? data.geminiUseSearch : true,
    };
  } catch {
    return { ...DEFAULT_AI_SETTINGS };
  }
}

export function saveAiSettings(settings: AiSettings): void {
  storage()?.setItem(STORAGE_KEY, JSON.stringify(settings));
}

/**
 * Whether a score should be auto-recognized on upload with these settings:
 * Gemini needs a key; the keyless OCR engine is ready as soon as it's picked.
 */
export function isRecognitionReady(settings: AiSettings): boolean {
  if (settings.engine === 'off') return false;
  if (settings.engine === 'gemini') return settings.geminiApiKey.trim().length > 0;
  return true;
}
