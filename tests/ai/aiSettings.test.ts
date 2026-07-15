import { describe, expect, it } from 'vitest';
import {
  DEFAULT_RECOGNITION_ORDER,
  getAiSettings,
  loadRecognitionOrder,
  sanitizeRecognitionOrder,
} from '../../src/lib/ai/aiSettings';

describe('sanitizeRecognitionOrder', () => {
  it('keeps a valid custom order', () => {
    expect(sanitizeRecognitionOrder(['huggingface', 'gemini'])).toEqual(['huggingface', 'gemini']);
  });

  it('drops unknown entries and duplicates, then appends missing engines', () => {
    expect(sanitizeRecognitionOrder(['huggingface', 'bogus', 'huggingface'])).toEqual(['huggingface', 'gemini']);
  });

  it('falls back to the default order for non-array input', () => {
    expect(sanitizeRecognitionOrder(null)).toEqual(DEFAULT_RECOGNITION_ORDER);
    expect(sanitizeRecognitionOrder('gemini')).toEqual(DEFAULT_RECOGNITION_ORDER);
  });
});

describe('recognition order without storage (node)', () => {
  it('defaults to Gemini → Hugging Face', () => {
    expect(loadRecognitionOrder()).toEqual(['gemini', 'huggingface']);
    const settings = getAiSettings();
    expect(settings.engine).toBe('gemini');
    expect(settings.fallbackEngines).toEqual(['huggingface']);
  });
});
