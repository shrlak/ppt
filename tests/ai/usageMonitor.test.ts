import { describe, expect, it } from 'vitest';
import { parseUsageSnapshot } from '../../src/lib/ai/usageMonitor';

describe('parseUsageSnapshot', () => {
  it('normalizes a model-level proxy usage response', () => {
    const snapshot = parseUsageSnapshot({
      generatedAt: '2026-07-15T12:00:00.000Z',
      source: 'shared-proxy',
      models: [
        {
          provider: 'gemini',
          model: 'gemini-2.5-flash',
          period: 'day',
          periodKey: '2026-07-15',
          requests: 3,
          successfulRequests: 2,
          failedRequests: 1,
          promptTokens: 1200,
          outputTokens: 300,
          totalTokens: 1500,
          computeSeconds: 0,
          providerMeasuredRequests: 0,
          metric: 'requests',
          used: 3,
          limit: 250,
          estimated: false,
        },
      ],
    });

    expect(snapshot.models).toHaveLength(1);
    expect(snapshot.models[0]).toMatchObject({
      provider: 'gemini',
      model: 'gemini-2.5-flash',
      requests: 3,
      totalTokens: 1500,
      used: 3,
      limit: 250,
    });
  });

  it('accepts NVIDIA usage rows', () => {
    const snapshot = parseUsageSnapshot({
      generatedAt: '2026-07-15T12:00:00.000Z',
      source: 'shared-proxy',
      models: [
        {
          provider: 'nvidia',
          model: 'nvidia/nemotron-nano-12b-v2-vl',
          period: 'month',
          periodKey: '2026-07',
          requests: 4,
          successfulRequests: 4,
          failedRequests: 0,
          promptTokens: 4000,
          outputTokens: 900,
          totalTokens: 4900,
          computeSeconds: 0,
          providerMeasuredRequests: 0,
          metric: 'requests',
          used: 4,
          limit: 1000,
          estimated: false,
        },
      ],
    });

    expect(snapshot.models[0]).toMatchObject({
      provider: 'nvidia',
      metric: 'requests',
      used: 4,
      limit: 1000,
    });
  });

  it('accepts OpenRouter free-model usage rows', () => {
    const snapshot = parseUsageSnapshot({
      models: [
        {
          provider: 'openrouter',
          model: 'nvidia/nemotron-nano-12b-v2-vl:free',
          period: 'day',
          periodKey: '2026-07-15',
          requests: 2,
          successfulRequests: 2,
          failedRequests: 0,
          promptTokens: 1000,
          outputTokens: 300,
          totalTokens: 1300,
          metric: 'requests',
          used: 2,
          limit: 50,
          estimated: false,
        },
      ],
    });

    expect(snapshot.models[0]).toMatchObject({
      provider: 'openrouter',
      model: 'nvidia/nemotron-nano-12b-v2-vl:free',
      used: 2,
      limit: 50,
    });
  });

  it('rejects unknown providers instead of displaying untrusted data', () => {
    expect(() =>
      parseUsageSnapshot({
        models: [{ provider: 'unknown', model: 'x', period: 'day', metric: 'requests' }],
      }),
    ).toThrow(/공급자/);
  });

  it('parses the exact usage-graph history and tolerates proxies without one', () => {
    const base = {
      provider: 'openrouter',
      model: 'nvidia/nemotron-nano-12b-v2-vl:free',
      period: 'day',
      periodKey: '2026-07-15',
      metric: 'requests',
      used: 2,
      limit: 50,
      estimated: false,
    };
    const withHistory = parseUsageSnapshot({
      models: [
        {
          ...base,
          history: [
            { periodKey: '2026-07-14', requests: 3, successfulRequests: 2, failedRequests: 1, totalTokens: 900 },
            { periodKey: '2026-07-15', requests: '2', successfulRequests: 2 },
            { periodKey: '', requests: 9 },
            'garbage',
          ],
        },
      ],
    });
    expect(withHistory.models[0].history).toEqual([
      {
        periodKey: '2026-07-14',
        requests: 3,
        successfulRequests: 2,
        failedRequests: 1,
        totalTokens: 900,
        computeSeconds: 0,
      },
      {
        periodKey: '2026-07-15',
        requests: 2,
        successfulRequests: 2,
        failedRequests: 0,
        totalTokens: 0,
        computeSeconds: 0,
      },
    ]);

    const withoutHistory = parseUsageSnapshot({ models: [base] });
    expect(withoutHistory.models[0].history).toEqual([]);
  });
});
