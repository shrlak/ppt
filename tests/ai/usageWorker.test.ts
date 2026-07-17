import { describe, expect, it } from 'vitest';
import {
  USAGE_HISTORY_DAYS,
  USAGE_HISTORY_MONTHS,
  buildUsageSnapshot,
  mergeUsageRecord,
  pacificDateKey,
  recentPeriodKeys,
  utcDateKey,
  utcMonthKey,
  usageStorageKey,
} from '../../worker/src/usage.js';

describe('AI proxy usage periods', () => {
  it('uses Pacific days for Gemini, UTC days for OpenRouter, and UTC months for Hugging Face', () => {
    const instant = new Date('2026-07-15T05:30:00.000Z');
    expect(pacificDateKey(instant)).toBe('2026-07-14');
    expect(utcDateKey(instant)).toBe('2026-07-15');
    expect(utcMonthKey(instant)).toBe('2026-07');
  });

  it('lists the recent daily periods oldest-first, ending today, across month boundaries', () => {
    const keys = recentPeriodKeys('openrouter', new Date('2026-07-03T12:00:00.000Z'));
    expect(keys).toHaveLength(USAGE_HISTORY_DAYS);
    expect(keys[0]).toBe('2026-06-20');
    expect(keys[keys.length - 1]).toBe('2026-07-03');
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('lists recent months for monthly providers, crossing the year boundary', () => {
    const keys = recentPeriodKeys('huggingface', new Date('2026-02-10T12:00:00.000Z'));
    expect(keys).toHaveLength(USAGE_HISTORY_MONTHS);
    expect(keys[0]).toBe('2025-09');
    expect(keys[keys.length - 1]).toBe('2026-02');
  });
});

describe('AI proxy usage records', () => {
  it('accumulates requests and token metadata per exact Gemini model', () => {
    const first = mergeUsageRecord(undefined, {
      provider: 'gemini',
      model: 'gemini-2.5-flash',
      success: true,
      timestamp: '2026-07-15T16:00:00.000Z',
      promptTokens: 100,
      outputTokens: 20,
      totalTokens: 120,
    });
    const second = mergeUsageRecord(first, {
      provider: 'gemini',
      model: 'gemini-2.5-flash',
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
        model: 'gemini-2.5-flash',
        timestamp: '2026-07-15T16:00:00.000Z',
      }),
    ).toContain('gemini-2.5-flash');
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
      model: 'gemini-2.5-flash',
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
      model: 'google/gemma-4-31b-it:free',
      success: true,
      timestamp: now,
      totalTokens: 800,
    });
    const huggingFace = mergeUsageRecord(undefined, {
      provider: 'huggingface',
      model: 'Qwen/Qwen2-VL-7B-Instruct',
      success: true,
      timestamp: now,
      computeSeconds: 10,
      computeSource: 'provider',
    });
    const snapshot = buildUsageSnapshot(
      [gemini, openRouter, openRouterGemma, huggingFace],
      {
        GEMINI_DAILY_REQUEST_LIMIT: '100',
        OPENROUTER_DAILY_REQUEST_LIMIT: '50',
        HUGGINGFACE_MONTHLY_CREDIT_USD: '0.10',
        HUGGINGFACE_USD_PER_SECOND: '0.00012',
      },
      now,
    );

    expect(snapshot.models).toHaveLength(4);
    expect(snapshot.models[0]).toMatchObject({ provider: 'gemini', used: 1, limit: 100 });
    expect(snapshot.models.filter((model) => model.provider === 'openrouter')).toHaveLength(2);
    expect(snapshot.models.find((model) => model.model === 'google/gemma-4-31b-it:free')).toMatchObject({
      provider: 'openrouter',
      model: 'google/gemma-4-31b-it:free',
      metric: 'requests',
      used: 1,
      limit: 50,
      estimated: false,
    });
    const huggingFaceUsage = snapshot.models.find((model) => model.provider === 'huggingface');
    expect(huggingFaceUsage).toMatchObject({
      provider: 'huggingface',
      limit: 0.1,
      providerMeasuredRequests: 1,
    });
    expect(huggingFaceUsage?.used).toBeCloseTo(0.0012);
  });

  it('carries an exact zero-filled history for the usage graph', () => {
    const now = new Date('2026-07-15T16:00:00.000Z');
    const today = mergeUsageRecord(undefined, {
      provider: 'openrouter',
      model: 'nvidia/nemotron-nano-12b-v2-vl:free',
      success: true,
      timestamp: now,
    });
    const twoDaysAgo = mergeUsageRecord(
      mergeUsageRecord(undefined, {
        provider: 'openrouter',
        model: 'nvidia/nemotron-nano-12b-v2-vl:free',
        success: true,
        timestamp: '2026-07-13T10:00:00.000Z',
        totalTokens: 300,
      }),
      {
        provider: 'openrouter',
        model: 'nvidia/nemotron-nano-12b-v2-vl:free',
        success: false,
        timestamp: '2026-07-13T11:00:00.000Z',
      },
    );

    const snapshot = buildUsageSnapshot([today, twoDaysAgo], {}, now);
    const row = snapshot.models.find((model) => model.model === 'nvidia/nemotron-nano-12b-v2-vl:free');

    expect(row?.history).toHaveLength(USAGE_HISTORY_DAYS);
    // Oldest first; quiet days are explicit zeros, not gaps.
    expect(row?.history[0]).toMatchObject({ periodKey: '2026-07-02', requests: 0 });
    expect(row?.history[USAGE_HISTORY_DAYS - 1]).toMatchObject({ periodKey: '2026-07-15', requests: 1 });
    expect(row?.history[USAGE_HISTORY_DAYS - 3]).toMatchObject({
      periodKey: '2026-07-13',
      requests: 2,
      successfulRequests: 1,
      failedRequests: 1,
      totalTokens: 300,
    });
    // Only the CURRENT period feeds the limit bar; history stays separate.
    expect(row?.used).toBe(1);
  });
});
