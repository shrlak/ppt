import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ATTEMPT_ORDER,
  DEFAULT_EXCLUDED_TITLES,
  RECOGNITION_MODEL_CATALOG,
  attemptKey,
  getAiSettings,
  sanitizeAttemptOrder,
  sanitizeExcludedTitles,
  sanitizeSharedSettings,
} from '../../src/lib/ai/aiSettings';
import {
  RECOGNITION_MODEL_CATALOG as WORKER_CATALOG,
  DEFAULT_EXCLUDED_TITLES as WORKER_EXCLUDED,
  sanitizeSharedSettings as workerSanitize,
} from '../../worker/src/config.js';

describe('recognition model catalog', () => {
  it('has unique engine+model entries and starts with the strongest Gemini', () => {
    const keys = RECOGNITION_MODEL_CATALOG.map(attemptKey);
    expect(new Set(keys).size).toBe(keys.length);
    expect(RECOGNITION_MODEL_CATALOG[0]).toMatchObject({ engine: 'gemini', model: 'gemini-2.5-pro' });
    // Multiple providers and multiple models per provider are available.
    expect(RECOGNITION_MODEL_CATALOG.filter((entry) => entry.engine === 'gemini').length).toBeGreaterThan(1);
    expect(RECOGNITION_MODEL_CATALOG.filter((entry) => entry.engine === 'nvidia').length).toBeGreaterThan(1);
  });

  it('matches the proxy-side catalog exactly (kept in lockstep)', () => {
    expect(RECOGNITION_MODEL_CATALOG.map(({ engine, model }) => ({ engine, model }))).toEqual(WORKER_CATALOG);
    expect(DEFAULT_EXCLUDED_TITLES).toEqual(WORKER_EXCLUDED);
  });
});

describe('sanitizeAttemptOrder', () => {
  it('keeps a valid custom order and appends the missing catalog models', () => {
    const custom = [
      { engine: 'nvidia', model: 'google/gemma-3-27b-it' },
      { engine: 'gemini', model: 'gemini-2.5-flash' },
    ];
    const order = sanitizeAttemptOrder(custom);
    expect(order.slice(0, 2)).toEqual(custom);
    expect(order).toHaveLength(DEFAULT_ATTEMPT_ORDER.length);
    expect(new Set(order.map(attemptKey)).size).toBe(order.length);
  });

  it('drops unknown models and duplicates', () => {
    const order = sanitizeAttemptOrder([
      { engine: 'gemini', model: 'made-up-model' },
      { engine: 'gemini', model: 'gemini-2.5-pro' },
      { engine: 'gemini', model: 'gemini-2.5-pro' },
    ]);
    expect(order[0]).toEqual({ engine: 'gemini', model: 'gemini-2.5-pro' });
    expect(order).toHaveLength(DEFAULT_ATTEMPT_ORDER.length);
  });

  it('expands legacy plain-engine entries into that engine’s catalog models', () => {
    const order = sanitizeAttemptOrder(['nvidia', 'gemini']);
    expect(order[0].engine).toBe('nvidia');
    const firstGemini = order.findIndex((attempt) => attempt.engine === 'gemini');
    const nvidiaCount = RECOGNITION_MODEL_CATALOG.filter((entry) => entry.engine === 'nvidia').length;
    expect(firstGemini).toBe(nvidiaCount);
  });

  it('falls back to the default order for non-array input', () => {
    expect(sanitizeAttemptOrder(null)).toEqual(DEFAULT_ATTEMPT_ORDER);
    expect(sanitizeAttemptOrder('gemini')).toEqual(DEFAULT_ATTEMPT_ORDER);
  });
});

describe('sanitizeExcludedTitles', () => {
  it('trims, dedupes (spacing/case-insensitively), and drops blanks', () => {
    expect(sanitizeExcludedTitles([' 공동체 고백송 ', '공동체고백송', '', '  ', '예배 전 준비 찬양'])).toEqual([
      '공동체 고백송',
      '예배 전 준비 찬양',
    ]);
  });

  it('defaults when the stored value is not a list', () => {
    expect(sanitizeExcludedTitles(undefined)).toEqual(DEFAULT_EXCLUDED_TITLES);
  });

  it('accepts an explicitly empty list (admin cleared it)', () => {
    expect(sanitizeExcludedTitles([])).toEqual([]);
  });
});

describe('shared settings sanitizers (client vs proxy)', () => {
  it('produce identical results for the same raw payload', () => {
    const raw = {
      attempts: [{ engine: 'nvidia', model: 'google/gemma-3-27b-it' }, 'gemini', { engine: 'x', model: 'y' }],
      excludedTitles: [' 공동체 고백송 ', 42, '준비 찬양'],
    };
    expect(sanitizeSharedSettings(raw)).toEqual(workerSanitize(raw));
  });
});

describe('recognition settings without storage (node)', () => {
  it('defaults to the full catalog order and default exclusions', () => {
    const settings = getAiSettings();
    expect(settings.attempts).toEqual(DEFAULT_ATTEMPT_ORDER);
    expect(settings.excludedTitles).toEqual(DEFAULT_EXCLUDED_TITLES);
    expect(settings.attempts[0]).toEqual({ engine: 'gemini', model: 'gemini-2.5-pro' });
  });
});
