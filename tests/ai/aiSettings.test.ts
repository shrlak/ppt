import { describe, expect, it } from 'vitest';
import {
  DEFAULT_RECOGNITION_ORDER,
  getAiSettings,
  loadRecognitionOrder,
  sanitizeRecognitionOrder,
} from '../../src/lib/ai/aiSettings';

describe('sanitizeRecognitionOrder', () => {
  it('keeps a valid custom order', () => {
    expect(sanitizeRecognitionOrder(['huggingface', 'nvidia', 'gemini'])).toEqual([
      'huggingface',
      'nvidia',
      'gemini',
    ]);
  });

  it('drops unknown entries and duplicates, then appends missing engines', () => {
    expect(sanitizeRecognitionOrder(['huggingface', 'bogus', 'huggingface'])).toEqual([
      'huggingface',
      'gemini',
      'nvidia',
    ]);
  });

  it('appends newly added engines to an order saved before they existed', () => {
    // A browser that stored ['huggingface','gemini'] before the NVIDIA engine
    // shipped still gets NVIDIA appended so every engine is tried.
    expect(sanitizeRecognitionOrder(['huggingface', 'gemini'])).toEqual(['huggingface', 'gemini', 'nvidia']);
  });

  it('falls back to the default order for non-array input', () => {
    expect(sanitizeRecognitionOrder(null)).toEqual(DEFAULT_RECOGNITION_ORDER);
    expect(sanitizeRecognitionOrder('gemini')).toEqual(DEFAULT_RECOGNITION_ORDER);
  });
});

describe('recognition order without storage (node)', () => {
  it('defaults to Gemini → NVIDIA → Hugging Face', () => {
    expect(loadRecognitionOrder()).toEqual(['gemini', 'nvidia', 'huggingface']);
    const settings = getAiSettings();
    expect(settings.engine).toBe('gemini');
    expect(settings.fallbackEngines).toEqual(['nvidia', 'huggingface']);
  });
});
