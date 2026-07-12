// Fixed configuration for score recognition: Gemini primary (via the shared
// recognition proxy — see worker/ — or a build-time key), falling back to
// Hugging Face and then on-device Tesseract OCR if earlier engines fail.
// There is no user-facing settings screen; recognition always uses these
// defaults, so it works as soon as the recognize button is pressed.

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

export const DEFAULT_GEMINI_MODEL = 'gemini-2.5-flash';

export const DEFAULT_AI_SETTINGS: AiSettings = {
  engine: 'gemini',
  geminiApiKey: '',
  geminiModel: DEFAULT_GEMINI_MODEL,
  geminiUseSearch: true,
  huggingfaceApiKey: '',
  fallbackEngines: ['huggingface', 'tesseract'],
};
