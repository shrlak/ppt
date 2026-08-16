import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ATTEMPT_ORDER,
  DEFAULT_EXCLUDED_TITLES,
  RECOGNITION_MODEL_CATALOG,
  attemptKey,
  findModelInfo,
  getAiSettings,
  isFreeVisionCatalogEntry,
  migrateEngineName,
  sanitizeAttemptOrder,
  sanitizeExcludedTitles,
  sanitizeSharedSettings,
} from '../../src/lib/ai/aiSettings';
import {
  OPENROUTER_NEMOTRON_MODEL,
  RECOGNITION_MODEL_CATALOG as WORKER_CATALOG,
  DEFAULT_EXCLUDED_TITLES as WORKER_EXCLUDED,
  migrateEngineName as workerMigrateEngineName,
  resolveOpenRouterRoute,
  sanitizeSharedSettings as workerSanitize,
} from '../../worker/src/config.js';

describe('recognition model catalog', () => {
  it('has a unique, stable concurrent model catalog', () => {
    const keys = RECOGNITION_MODEL_CATALOG.map(attemptKey);
    expect(new Set(keys).size).toBe(keys.length);
    // Stable display order starts with the benchmark-validated Flash model.
    expect(RECOGNITION_MODEL_CATALOG[0]).toMatchObject({ engine: 'gemini', model: 'gemini-3.6-flash' });
    // Multiple providers and multiple models per provider are available.
    expect(RECOGNITION_MODEL_CATALOG.filter((entry) => entry.engine === 'gemini').length).toBeGreaterThan(1);
    expect(RECOGNITION_MODEL_CATALOG.filter((entry) => entry.engine === 'openrouter').length).toBeGreaterThan(1);
  });

  it('registers three initial champions and free challengers', () => {
    expect(RECOGNITION_MODEL_CATALOG.filter((model) => model.role === 'champion')).toHaveLength(3);
    expect(RECOGNITION_MODEL_CATALOG.filter((model) => model.role === 'challenger').length).toBeGreaterThanOrEqual(2);
    expect(
      RECOGNITION_MODEL_CATALOG.filter((model) => model.engine === 'openrouter').every((model) =>
        model.upstreamModel.endsWith(':free'),
      ),
    ).toBe(true);
    expect(RECOGNITION_MODEL_CATALOG.every(isFreeVisionCatalogEntry)).toBe(true);
  });

  it('leaves out the free Gemma variant the benchmark already rejected', () => {
    expect(RECOGNITION_MODEL_CATALOG.map((entry) => entry.model)).not.toContain(
      'google/gemma-4-26b-a4b-it:free',
    );
  });

  it('matches the proxy-side catalog exactly (kept in lockstep)', () => {
    expect(
      RECOGNITION_MODEL_CATALOG.map(({ engine, model, upstreamModel, role }) => ({
        engine,
        model,
        upstreamModel,
        role,
      })),
    ).toEqual(WORKER_CATALOG);
    expect(DEFAULT_EXCLUDED_TITLES).toEqual(WORKER_EXCLUDED);
  });

  it('pins every OpenRouter fallback to an allowlisted free vision model', () => {
    expect(resolveOpenRouterRoute('nvidia/nemotron-nano-12b-v2-vl')).toEqual({
      configuredModel: 'nvidia/nemotron-nano-12b-v2-vl',
      upstreamModel: OPENROUTER_NEMOTRON_MODEL,
    });
    expect(resolveOpenRouterRoute('nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free')).toEqual({
      configuredModel: 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free',
      upstreamModel: 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free',
    });
    // A model outside the free catalog is refused, never silently swapped:
    // substituting would spend the shared key on a request nobody made and
    // would credit the accuracy to the wrong model.
    expect(resolveOpenRouterRoute('paid/or-made-up-model')).toBeNull();
  });
});

describe('migrateEngineName', () => {
  it('maps the legacy nvidia lane onto openrouter and rejects anything else', () => {
    expect(migrateEngineName('nvidia')).toBe('openrouter');
    expect(migrateEngineName('openrouter')).toBe('openrouter');
    expect(migrateEngineName('gemini')).toBe('gemini');
    expect(migrateEngineName('off')).toBeUndefined();
    expect(migrateEngineName(undefined)).toBeUndefined();
  });

  it('agrees with the proxy-side migration (kept in lockstep)', () => {
    for (const value of ['nvidia', 'openrouter', 'gemini', 'off', '', null]) {
      expect(migrateEngineName(value)).toBe(workerMigrateEngineName(value));
    }
  });

  it('still resolves catalog info for a stored legacy attempt', () => {
    expect(
      findModelInfo({ engine: 'nvidia' as 'openrouter', model: 'nvidia/nemotron-nano-12b-v2-vl' })?.role,
    ).toBe('champion');
  });
});

describe('sanitizeAttemptOrder', () => {
  it('migrates the legacy nvidia engine without changing its model', () => {
    expect(sanitizeAttemptOrder([{ engine: 'nvidia', model: 'nvidia/nemotron-nano-12b-v2-vl' }])[0]).toEqual({
      engine: 'openrouter',
      model: 'nvidia/nemotron-nano-12b-v2-vl',
    });
  });

  it('keeps a valid custom order and appends the missing catalog models', () => {
    const custom = [
      { engine: 'openrouter', model: 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free' },
      { engine: 'gemini', model: 'gemini-3.6-flash' },
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
      { engine: 'gemini', model: 'gemini-3.5-flash' },
      { engine: 'gemini', model: 'gemini-3.5-flash' },
    ]);
    expect(order[0]).toEqual({ engine: 'gemini', model: 'gemini-3.5-flash' });
    expect(order).toHaveLength(DEFAULT_ATTEMPT_ORDER.length);
  });

  it('expands legacy plain-engine entries into that engine’s catalog models', () => {
    const order = sanitizeAttemptOrder(['nvidia', 'gemini']);
    expect(order[0].engine).toBe('openrouter');
    const firstGemini = order.findIndex((attempt) => attempt.engine === 'gemini');
    const openRouterCount = RECOGNITION_MODEL_CATALOG.filter((entry) => entry.engine === 'openrouter').length;
    expect(firstGemini).toBe(openRouterCount);
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
      attempts: [
        { engine: 'nvidia', model: 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free' },
        'gemini',
        { engine: 'x', model: 'y' },
      ],
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
    expect(settings.attempts[0]).toEqual({ engine: 'gemini', model: 'gemini-3.6-flash' });
  });
});
