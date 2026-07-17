export type UsageProvider = 'gemini' | 'openrouter' | 'nvidia' | 'huggingface';
export type UsageMetric = 'requests' | 'usd';

/** One period (day or month) of exact usage for the 사용량 graph. */
export interface UsageHistoryPoint {
  periodKey: string;
  requests: number;
  successfulRequests: number;
  failedRequests: number;
  totalTokens: number;
  computeSeconds: number;
}

export interface ModelUsage {
  provider: UsageProvider;
  model: string;
  period: 'day' | 'month';
  periodKey: string;
  requests: number;
  successfulRequests: number;
  failedRequests: number;
  promptTokens: number;
  outputTokens: number;
  totalTokens: number;
  computeSeconds: number;
  providerMeasuredRequests: number;
  updatedAt: string | null;
  metric: UsageMetric;
  used: number;
  limit: number;
  estimated: boolean;
  usdPerSecond?: number;
  /** Recent periods, oldest first (zero-filled server-side); [] on old proxies. */
  history: UsageHistoryPoint[];
}

export interface AiUsageSnapshot {
  generatedAt: string;
  source: 'shared-proxy';
  models: ModelUsage[];
}

function proxyUrl(): string | undefined {
  return import.meta.env.VITE_RECOGNITION_PROXY_URL?.trim() || undefined;
}

export function hasSharedUsageMonitor(): boolean {
  return !!proxyUrl();
}

function nonNegativeNumber(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

/** Coerce the proxy's history list; anything malformed just drops out. */
function parseHistory(raw: unknown): UsageHistoryPoint[] {
  if (!Array.isArray(raw)) return [];
  const points: UsageHistoryPoint[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const point = item as Record<string, unknown>;
    if (typeof point.periodKey !== 'string' || !point.periodKey) continue;
    points.push({
      periodKey: point.periodKey,
      requests: nonNegativeNumber(point.requests),
      successfulRequests: nonNegativeNumber(point.successfulRequests),
      failedRequests: nonNegativeNumber(point.failedRequests),
      totalTokens: nonNegativeNumber(point.totalTokens),
      computeSeconds: nonNegativeNumber(point.computeSeconds),
    });
  }
  return points;
}

export function parseUsageSnapshot(raw: unknown): AiUsageSnapshot {
  if (!raw || typeof raw !== 'object') throw new Error('사용량 응답 형식이 올바르지 않습니다.');
  const object = raw as Record<string, unknown>;
  if (!Array.isArray(object.models)) throw new Error('모델별 사용량이 응답에 없습니다.');
  const models: ModelUsage[] = object.models.map((item) => {
    if (!item || typeof item !== 'object') throw new Error('모델 사용량 형식이 올바르지 않습니다.');
    const model = item as Record<string, unknown>;
    const provider = model.provider;
    const metric = model.metric;
    const period = model.period;
    if (
      provider !== 'gemini' &&
      provider !== 'openrouter' &&
      provider !== 'nvidia' &&
      provider !== 'huggingface'
    )
      throw new Error('알 수 없는 AI 공급자입니다.');
    if (metric !== 'requests' && metric !== 'usd') throw new Error('알 수 없는 사용량 단위입니다.');
    if (period !== 'day' && period !== 'month') throw new Error('알 수 없는 사용량 기간입니다.');
    if (typeof model.model !== 'string' || !model.model.trim()) throw new Error('AI 모델명이 없습니다.');
    return {
      provider,
      model: model.model,
      period,
      periodKey: typeof model.periodKey === 'string' ? model.periodKey : '',
      requests: nonNegativeNumber(model.requests),
      successfulRequests: nonNegativeNumber(model.successfulRequests),
      failedRequests: nonNegativeNumber(model.failedRequests),
      promptTokens: nonNegativeNumber(model.promptTokens),
      outputTokens: nonNegativeNumber(model.outputTokens),
      totalTokens: nonNegativeNumber(model.totalTokens),
      computeSeconds: nonNegativeNumber(model.computeSeconds),
      providerMeasuredRequests: nonNegativeNumber(model.providerMeasuredRequests),
      updatedAt: typeof model.updatedAt === 'string' ? model.updatedAt : null,
      metric,
      used: nonNegativeNumber(model.used),
      limit: nonNegativeNumber(model.limit),
      estimated: model.estimated === true,
      usdPerSecond: model.usdPerSecond == null ? undefined : nonNegativeNumber(model.usdPerSecond),
      history: parseHistory(model.history),
    };
  });
  return {
    generatedAt: typeof object.generatedAt === 'string' ? object.generatedAt : new Date().toISOString(),
    source: 'shared-proxy',
    models,
  };
}

export async function fetchAiUsage(signal?: AbortSignal): Promise<AiUsageSnapshot> {
  const base = proxyUrl();
  if (!base) throw new Error('공유 AI 프록시가 연결되지 않았습니다.');
  const response = await fetch(`${base.replace(/\/$/, '')}/usage`, {
    method: 'GET',
    headers: { Accept: 'application/json' },
    signal,
  });
  if (!response.ok) {
    let detail = `HTTP ${response.status}`;
    try {
      const payload = (await response.json()) as { error?: string };
      if (payload.error) detail = payload.error;
    } catch {
      // Keep the HTTP status when the proxy did not return JSON.
    }
    throw new Error(`AI 사용량을 불러오지 못했습니다: ${detail}`);
  }
  return parseUsageSnapshot((await response.json()) as unknown);
}
