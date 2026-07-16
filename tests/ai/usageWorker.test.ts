import { describe, expect, it } from 'vitest';
import {
  buildUsageSnapshot,
  mergeUsageRecord,
  pacificDateKey,
  utcMonthKey,
  usageStorageKey,
} from '../../worker/src/usage.js';

describe('AI proxy usage periods', () => {
  it('uses Pacific calendar days for Gemini and UTC months for Hugging Face', () => {
    const instant = new Date('2026-07-15T05:30:00.000Z');
    expect(pacificDateKey(instant)).toBe('2026-07-14');
    expect(utcMonthKey(instant)).toBe('2026-07');
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

  it('accumulates NVIDIA requests per UTC month', () => {
    const record = mergeUsageRecord(undefined, {
      provider: 'nvidia',
      model: 'nvidia/nemotron-nano-12b-v2-vl',
      success: true,
      timestamp: '2026-07-15T16:00:00.000Z',
      promptTokens: 900,
      outputTokens: 120,
      totalTokens: 1020,
    });

    expect(record).toMatchObject({
      provider: 'nvidia',
      period: 'month',
      periodKey: '2026-07',
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
    const nvidia = mergeUsageRecord(undefined, {
      provider: 'nvidia',
      model: 'nvidia/nemotron-nano-12b-v2-vl',
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
      [gemini, nvidia, huggingFace],
      {
        GEMINI_DAILY_REQUEST_LIMIT: '100',
        NVIDIA_MONTHLY_REQUEST_LIMIT: '1000',
        HUGGINGFACE_MONTHLY_CREDIT_USD: '0.10',
        HUGGINGFACE_USD_PER_SECOND: '0.00012',
      },
      now,
    );

    expect(snapshot.models).toHaveLength(3);
    expect(snapshot.models[0]).toMatchObject({ provider: 'gemini', used: 1, limit: 100 });
    expect(snapshot.models[1]).toMatchObject({
      provider: 'nvidia',
      metric: 'requests',
      used: 1,
      limit: 1000,
      estimated: false,
    });
    expect(snapshot.models[2]).toMatchObject({
      provider: 'huggingface',
      limit: 0.1,
      providerMeasuredRequests: 1,
    });
    expect(snapshot.models[2].used).toBeCloseTo(0.0012);
  });
});
