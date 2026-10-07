import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ATTEMPT_ORDER,
  DEFAULT_CONFESSION_SONG,
  DEFAULT_EXCLUDED_TITLES,
  DEFAULT_POST_SERMON_SONG,
  SETTINGS_DEFAULTS_VERSION,
  RECOGNITION_MODEL_CATALOG,
  attemptKey,
  findModelInfo,
  getAiSettings,
  isFreeVisionCatalogEntry,
  migrateEngineName,
  sanitizeAttemptOrder,
  sanitizeExcludedTitles,
  sanitizeConfessionSong,
  sanitizeSharedSettings,
} from '../../src/lib/ai/aiSettings';
import {
  RECOGNITION_MODEL_CATALOG as WORKER_CATALOG,
  DEFAULT_CONFESSION_SONG as WORKER_CONFESSION,
  DEFAULT_POST_SERMON_SONG as WORKER_POST_SERMON,
  DEFAULT_EXCLUDED_TITLES as WORKER_EXCLUDED,
  migrateEngineName as workerMigrateEngineName,
  resolveOpenRouterRoute,
  sanitizeAttemptOrder as workerSanitizeAttemptOrder,
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
    expect(DEFAULT_CONFESSION_SONG).toBe(WORKER_CONFESSION);
    expect(DEFAULT_POST_SERMON_SONG).toBe(WORKER_POST_SERMON);
  });

  it('pins every OpenRouter fallback to an allowlisted free vision model', () => {
    expect(resolveOpenRouterRoute('nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free')).toEqual({
      configuredModel: 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free',
      upstreamModel: 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free',
    });
    // A model outside the free catalog is refused, never silently swapped:
    // substituting would spend the shared key on a request nobody made and
    // would credit the accuracy to the wrong model.
    expect(resolveOpenRouterRoute('paid/or-made-up-model')).toBeNull();
    // OpenRouter withdrew Nemotron Nano 12B VL's free endpoint; it is no
    // longer in the catalog, so a stale client asking for it is refused.
    expect(resolveOpenRouterRoute('nvidia/nemotron-nano-12b-v2-vl')).toBeNull();
  });

  it('keeps a Gemini Flash-Lite among the champions, so a Flash-wide 503 spike still leaves a reader', () => {
    const champions = RECOGNITION_MODEL_CATALOG.filter((entry) => entry.role === 'champion').map((entry) => entry.model);
    expect(champions).toEqual(['gemini-3.6-flash', 'gemini-3.5-flash', 'gemini-3.5-flash-lite']);
    expect(RECOGNITION_MODEL_CATALOG.some((entry) => entry.model === 'nvidia/nemotron-nano-12b-v2-vl')).toBe(false);
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
      findModelInfo({
        engine: 'nvidia' as 'openrouter',
        model: 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free',
      })?.role,
    ).toBe('challenger');
  });
});

describe('sanitizeAttemptOrder', () => {
  it('migrates the legacy nvidia engine without changing its model', () => {
    const order = sanitizeAttemptOrder([
      { engine: 'nvidia', model: 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free' },
    ]);
    expect(order).toContainEqual({
      engine: 'openrouter',
      model: 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free',
    });
  });

  it('drops a model the catalog withdrew and puts the new ones beside their catalog neighbours', () => {
    // The pool every device had stored before Nemotron Nano 12B VL's free
    // endpoint went away.
    const stored = [
      { engine: 'openrouter', model: 'nvidia/nemotron-nano-12b-v2-vl' },
      { engine: 'gemini', model: 'gemini-3.6-flash' },
      { engine: 'gemini', model: 'gemini-3.5-flash' },
      { engine: 'openrouter', model: 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free' },
      { engine: 'openrouter', model: 'dots-studio/dots-3-note-preview:free' },
      { engine: 'openrouter', model: 'google/gemma-4-31b-it:free' },
    ];
    // Not behind the slow challengers: the rescue takes the first answer
    // down this order.
    expect(sanitizeAttemptOrder(stored).map((attempt) => attempt.model)).toEqual([
      'gemini-3.6-flash',
      'gemini-3.5-flash',
      'gemini-3.5-flash-lite',
      'gemini-3.7-flash',
      'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free',
      'dots-studio/dots-3-note-preview:free',
      'google/gemma-4-31b-it:free',
    ]);
    expect(workerSanitizeAttemptOrder(stored)).toEqual(sanitizeAttemptOrder(stored));
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
    expect(order.filter((attempt) => attempt.model === 'gemini-3.5-flash')).toHaveLength(1);
    expect(order.some((attempt) => attempt.model === 'made-up-model' || attempt.model === 'gemini-2.5-pro')).toBe(false);
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

describe('sanitizeConfessionSong', () => {
  it('trims the title and keeps it as typed otherwise', () => {
    expect(sanitizeConfessionSong('  나의 반석이신 하나님 ')).toBe('나의 반석이신 하나님');
  });

  it('defaults when the stored value is not a string', () => {
    expect(sanitizeConfessionSong(undefined)).toBe(DEFAULT_CONFESSION_SONG);
    expect(sanitizeConfessionSong(42)).toBe(DEFAULT_CONFESSION_SONG);
  });

  it('keeps an explicitly blank title (leave the back slides alone)', () => {
    expect(sanitizeConfessionSong('   ')).toBe('');
  });

  it('defaults to 우리는 주의 움직이는 교회', () => {
    expect(DEFAULT_CONFESSION_SONG).toBe('우리는 주의 움직이는 교회');
  });

  it('moves settings saved under the old default to the new one, once', () => {
    // Saved before version 2: Celebrate the Light was there only as the default.
    expect(sanitizeSharedSettings({ confessionSong: 'Celebrate the Light' }).confessionSong).toBe(
      DEFAULT_CONFESSION_SONG,
    );
    // Any other song an administrator chose is kept.
    expect(sanitizeSharedSettings({ confessionSong: '주 은혜임을' }).confessionSong).toBe('주 은혜임을');
    // Chosen again after the change, Celebrate the Light stays.
    expect(
      sanitizeSharedSettings({ confessionSong: 'Celebrate the Light', defaultsVersion: SETTINGS_DEFAULTS_VERSION })
        .confessionSong,
    ).toBe('Celebrate the Light');
  });
});

describe('the default 설교 후 찬양', () => {
  it('is 영접송, and can be changed or cleared', () => {
    expect(sanitizeSharedSettings({}).postSermonSong).toBe('영접송');
    expect(sanitizeSharedSettings({ postSermonSong: ' 축복하노라 ' }).postSermonSong).toBe('축복하노라');
    expect(sanitizeSharedSettings({ postSermonSong: '' }).postSermonSong).toBe('');
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
      confessionSong: '  나의 반석이신 하나님  ',
      postSermonSong: ' 영접송 ',
    };
    expect(sanitizeSharedSettings(raw)).toEqual(workerSanitize(raw));
    // The one-time move off the old default happens on both sides alike.
    expect(sanitizeSharedSettings({ confessionSong: 'Celebrate the Light' })).toEqual(
      workerSanitize({ confessionSong: 'Celebrate the Light' }),
    );
  });
});

describe('recognition settings without storage (node)', () => {
  it('defaults to the full catalog order and default exclusions', () => {
    const settings = getAiSettings();
    expect(settings.attempts).toEqual(DEFAULT_ATTEMPT_ORDER);
    expect(settings.excludedTitles).toEqual(DEFAULT_EXCLUDED_TITLES);
    expect(settings.confessionSong).toBe(DEFAULT_CONFESSION_SONG);
    expect(settings.attempts[0]).toEqual({ engine: 'gemini', model: 'gemini-3.6-flash' });
  });
});
