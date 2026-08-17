import { describe, expect, it } from 'vitest';
import {
  buildUsageSnapshot,
  mergeUsageRecord,
  pacificDateKey,
  utcDateKey,
  utcMonthKey,
  usageStorageKey,
} from '../../worker/src/usage.js';
import { RECOGNITION_MODEL_CATALOG, usageCatalogModels } from '../../worker/src/config.js';
import { createWorkerHarness } from '../support/workerHarness';

describe('AI proxy usage periods', () => {
  it('uses Pacific days for Gemini, UTC days for OpenRouter, and UTC months for Hugging Face', () => {
    const instant = new Date('2026-07-15T05:30:00.000Z');
    expect(pacificDateKey(instant)).toBe('2026-07-14');
    expect(utcDateKey(instant)).toBe('2026-07-15');
    expect(utcMonthKey(instant)).toBe('2026-07');
  });
});

describe('AI proxy usage records', () => {
  it('accumulates requests and token metadata per exact Gemini model', () => {
    const first = mergeUsageRecord(undefined, {
      provider: 'gemini',
      model: 'gemini-3.6-flash',
      success: true,
      timestamp: '2026-07-15T16:00:00.000Z',
      promptTokens: 100,
      outputTokens: 20,
      totalTokens: 120,
    });
    const second = mergeUsageRecord(first, {
      provider: 'gemini',
      model: 'gemini-3.6-flash',
      success: false,
      timestamp: '2026-07-15T17:00:00.000Z',
      promptTokens: 50,
    });

    expect(second).toMatchObject({
      requests: 2,
      successfulRequests: 1,
      failedRequests: 1,
      promptTokens: 150,
      outputTokens: 20,
      totalTokens: 120,
    });
    expect(
      usageStorageKey({
        provider: 'gemini',
        model: 'gemini-3.6-flash',
        timestamp: '2026-07-15T16:00:00.000Z',
      }),
    ).toContain('gemini-3.6-flash');
  });

  it('accumulates OpenRouter requests per UTC day', () => {
    const record = mergeUsageRecord(undefined, {
      provider: 'openrouter',
      model: 'nvidia/nemotron-nano-12b-v2-vl:free',
      success: true,
      timestamp: '2026-07-15T16:00:00.000Z',
      promptTokens: 900,
      outputTokens: 120,
      totalTokens: 1020,
    });

    expect(record).toMatchObject({
      provider: 'openrouter',
      period: 'day',
      periodKey: '2026-07-15',
      requests: 1,
      successfulRequests: 1,
      totalTokens: 1020,
    });
  });

  it('builds request and estimated-credit bars for the current periods', () => {
    const now = new Date('2026-07-15T16:00:00.000Z');
    const gemini = mergeUsageRecord(undefined, {
      provider: 'gemini',
      model: 'gemini-3.6-flash',
      success: true,
      timestamp: now,
      totalTokens: 500,
    });
    const openRouter = mergeUsageRecord(undefined, {
      provider: 'openrouter',
      model: 'nvidia/nemotron-nano-12b-v2-vl:free',
      success: true,
      timestamp: now,
      totalTokens: 700,
    });
    const openRouterGemma = mergeUsageRecord(undefined, {
      provider: 'openrouter',
      model: 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free',
      success: true,
      timestamp: now,
      totalTokens: 800,
    });
    const snapshot = buildUsageSnapshot(
      [gemini, openRouter, openRouterGemma],
      {
        GEMINI_DAILY_REQUEST_LIMIT: '100',
        OPENROUTER_DAILY_REQUEST_LIMIT: '50',
      },
      now,
    );

    expect(snapshot.models).toHaveLength(3);
    expect(snapshot.models[0]).toMatchObject({ provider: 'gemini', used: 1, limit: 100 });
    expect(snapshot.models.filter((model) => model.provider === 'openrouter')).toHaveLength(2);
    expect(
      snapshot.models.find((model) => model.model === 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free'),
    ).toMatchObject({
      provider: 'openrouter',
      model: 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free',
      metric: 'requests',
      used: 1,
      limit: 50,
      estimated: false,
    });
  });

  it('maps every catalog model to the provider/model pair it is metered under', () => {
    const pairs = usageCatalogModels();
    expect(pairs).toHaveLength(RECOGNITION_MODEL_CATALOG.length);
    // The Nemotron slot meters as the exact :free slug the Worker forwards to.
    expect(pairs).toContainEqual({ provider: 'openrouter', model: 'nvidia/nemotron-nano-12b-v2-vl:free' });
    expect(pairs).toContainEqual({ provider: 'gemini', model: 'gemini-3.6-flash' });
    expect(pairs).toContainEqual({ provider: 'gemini', model: 'gemini-3.5-flash' });
    expect(pairs).toContainEqual({
      provider: 'openrouter',
      model: 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free',
    });
    // Three champions plus the free challengers used for cross-checking.
    expect(pairs).toHaveLength(6);
    expect(pairs).toContainEqual({ provider: 'openrouter', model: 'dots-studio/dots-3-note-preview:free' });
    expect(pairs).toContainEqual({ provider: 'openrouter', model: 'google/gemma-4-31b-it:free' });
  });

  it('shows a card for EVERY system model, including ones with no usage yet', () => {
    const now = new Date('2026-07-15T16:00:00.000Z');
    const onlyGemini = mergeUsageRecord(undefined, {
      provider: 'gemini',
      model: 'gemini-3.6-flash',
      success: true,
      timestamp: now,
      totalTokens: 500,
    });

    const snapshot = buildUsageSnapshot([onlyGemini], {}, now, usageCatalogModels());

    expect(snapshot.models).toHaveLength(RECOGNITION_MODEL_CATALOG.length);
    expect(snapshot.models.find((model) => model.model === 'gemini-3.6-flash')).toMatchObject({ used: 1 });
    // Untouched models still appear, as explicit zero rows.
    expect(
      snapshot.models.find((model) => model.model === 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free'),
    ).toMatchObject({
      provider: 'openrouter',
      requests: 0,
      used: 0,
      limit: 50,
    });
    expect(snapshot.models.find((model) => model.model === 'gemini-3.5-flash')).toMatchObject({
      provider: 'gemini',
      requests: 0,
      used: 0,
    });
    expect(snapshot.models.filter((model) => model.provider === 'openrouter')).toHaveLength(
      RECOGNITION_MODEL_CATALOG.filter((entry) => entry.engine === 'openrouter').length,
    );
  });
});

describe('learning model statistics routes', () => {
  const evaluation = (lyrics: number) => ({
    modelKey: 'openrouter:nvidia/nemotron-nano-12b-v2-vl',
    title: 1,
    order: 1,
    lyrics,
    success: true,
    latencyMs: 900,
  });

  it('records accuracy from verified corrections and reads it back without lyrics', async () => {
    const harness = createWorkerHarness();
    const posted = await harness.fetch('/learning/models/evaluations', {
      method: 'POST',
      admin: true,
      body: JSON.stringify({ evaluations: [evaluation(1), evaluation(0)] }),
    });
    expect(posted.status).toBe(200);

    const read = await harness.fetch('/learning/models');
    const body = (await read.json()) as { models: Record<string, unknown>[] };
    expect(body.models).toHaveLength(1);
    expect(body.models[0]).toMatchObject({
      modelKey: 'openrouter:nvidia/nemotron-nano-12b-v2-vl',
      samples: 2,
      lyrics: 0.5,
    });
    // Accuracy numbers only — no lyric text can reach the dashboard.
    expect(JSON.stringify(body)).not.toMatch(/sections|lines|가사/);
  });

  it('refuses to record an evaluation without the administrator password', async () => {
    const harness = createWorkerHarness();
    const response = await harness.fetch('/learning/models/evaluations', {
      method: 'POST',
      body: JSON.stringify({ evaluations: [evaluation(1)] }),
    });
    expect(response.status).toBe(403);
    const read = (await (await harness.fetch('/learning/models')).json()) as { models: unknown[] };
    expect(read.models).toEqual([]);
  });

  it('rejects a batch with no usable evaluation rather than storing a partial one', async () => {
    const harness = createWorkerHarness();
    const response = await harness.fetch('/learning/models/evaluations', {
      method: 'POST',
      admin: true,
      body: JSON.stringify({ evaluations: [{ ...evaluation(1), lyrics: 7 }] }),
    });
    expect(response.status).toBe(400);
  });

  it('refuses a paid or unknown OpenRouter model instead of substituting one', async () => {
    const harness = createWorkerHarness({ OPENROUTER_API_KEY: 'test-key' });
    const response = await harness.fetch('/openrouter', {
      method: 'POST',
      body: JSON.stringify({ model: 'paid/expensive-vision', messages: [] }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: expect.stringContaining('not allowed') });
  });
});
