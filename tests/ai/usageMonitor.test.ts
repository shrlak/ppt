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

  it('rejects unknown providers instead of displaying untrusted data', () => {
    expect(() =>
      parseUsageSnapshot({
        models: [{ provider: 'unknown', model: 'x', period: 'day', metric: 'requests' }],
      }),
    ).toThrow(/공급자/);
  });
});
