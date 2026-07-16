// Pure usage-metering helpers shared by the Worker and its unit tests.
// Gemini's free tier is request-limited per model/project/day, NVIDIA's API
// catalog (build.nvidia.com) grants a pool of free credits where one request
// costs one credit, and Hugging Face's included Inference Providers allowance
// is a monthly dollar credit. Provider dashboards remain authoritative; this
// module maintains the app's own counter because none of these APIs exposes a
// portable "remaining credit" API.

export const DEFAULT_GEMINI_MODEL = 'gemini-2.5-flash';
export const DEFAULT_NVIDIA_MODEL = 'nvidia/nemotron-nano-12b-v2-vl';
export const DEFAULT_HUGGINGFACE_MODEL = 'Qwen/Qwen2-VL-7B-Instruct';
export const DEFAULT_GEMINI_DAILY_REQUEST_LIMIT = 250;
// build.nvidia.com grants free API credits (1 credit = 1 request). The pool
// is per-account rather than per-month; the monthly bar is a pacing guide.
export const DEFAULT_NVIDIA_MONTHLY_REQUEST_LIMIT = 1000;
export const DEFAULT_HUGGINGFACE_MONTHLY_CREDIT_USD = 0.1;
// Hugging Face bills hf-inference by compute time x hardware price. This
// default mirrors the public pricing example and is deliberately configurable.
export const DEFAULT_HUGGINGFACE_USD_PER_SECOND = 0.00012;

const PROVIDERS = new Set(['gemini', 'nvidia', 'huggingface']);

/** Display/sort order of providers, matching the recognition priority. */
const PROVIDER_RANK = { gemini: 0, nvidia: 1, huggingface: 2 };

function finiteNonNegative(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

function positiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

/** Calendar date in the Pacific timezone where Gemini's RPD quota resets. */
export function pacificDateKey(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const part = (type) => parts.find((item) => item.type === type)?.value || '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

/** Hugging Face's included credit is monthly, so group it by UTC month. */
export function utcMonthKey(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  return date.toISOString().slice(0, 7);
}

export function usagePeriod(provider, value = new Date()) {
  if (provider === 'gemini') {
    return { period: 'day', periodKey: pacificDateKey(value) };
  }
  // NVIDIA credits and Hugging Face credit are both tracked per UTC month.
  return { period: 'month', periodKey: utcMonthKey(value) };
}

export function sanitizeUsageEvent(raw, now = new Date()) {
  const provider = typeof raw?.provider === 'string' ? raw.provider : '';
  const model = typeof raw?.model === 'string' ? raw.model.trim() : '';
  if (!PROVIDERS.has(provider) || !model) {
    throw new Error('invalid AI usage event');
  }
  const timestamp = new Date(raw?.timestamp || now);
  if (Number.isNaN(timestamp.getTime())) throw new Error('invalid AI usage timestamp');
  const computeSource = raw?.computeSource === 'provider' ? 'provider' : 'wall';
  return {
    provider,
    model,
    success: raw?.success === true,
    timestamp: timestamp.toISOString(),
    promptTokens: Math.round(finiteNonNegative(raw?.promptTokens)),
    outputTokens: Math.round(finiteNonNegative(raw?.outputTokens)),
    totalTokens: Math.round(finiteNonNegative(raw?.totalTokens)),
    computeSeconds: finiteNonNegative(raw?.computeSeconds),
    wallSeconds: finiteNonNegative(raw?.wallSeconds),
    computeSource,
  };
}

export function usageStorageKey(event) {
  const { periodKey } = usagePeriod(event.provider, event.timestamp);
  return `usage:${event.provider}:${periodKey}:${encodeURIComponent(event.model)}`;
}

export function mergeUsageRecord(current, rawEvent) {
  const event = sanitizeUsageEvent(rawEvent);
  const { period, periodKey } = usagePeriod(event.provider, event.timestamp);
  const previous =
    current &&
    current.provider === event.provider &&
    current.model === event.model &&
    current.periodKey === periodKey
      ? current
      : {};
  return {
    provider: event.provider,
    model: event.model,
    period,
    periodKey,
    requests: finiteNonNegative(previous.requests) + 1,
    successfulRequests: finiteNonNegative(previous.successfulRequests) + (event.success ? 1 : 0),
    failedRequests: finiteNonNegative(previous.failedRequests) + (event.success ? 0 : 1),
    promptTokens: finiteNonNegative(previous.promptTokens) + event.promptTokens,
    outputTokens: finiteNonNegative(previous.outputTokens) + event.outputTokens,
    totalTokens: finiteNonNegative(previous.totalTokens) + event.totalTokens,
    computeSeconds: finiteNonNegative(previous.computeSeconds) + event.computeSeconds,
    wallSeconds: finiteNonNegative(previous.wallSeconds) + event.wallSeconds,
    providerMeasuredRequests:
      finiteNonNegative(previous.providerMeasuredRequests) + (event.computeSource === 'provider' ? 1 : 0),
    updatedAt: event.timestamp,
  };
}

function emptyRecord(provider, model, now) {
  const { period, periodKey } = usagePeriod(provider, now);
  return {
    provider,
    model,
    period,
    periodKey,
    requests: 0,
    successfulRequests: 0,
    failedRequests: 0,
    promptTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    computeSeconds: 0,
    wallSeconds: 0,
    providerMeasuredRequests: 0,
    updatedAt: null,
  };
}

/** Convert current-period records into the browser-facing, model-level view. */
export function buildUsageSnapshot(records, env = {}, now = new Date()) {
  const geminiLimit = positiveNumber(
    env.GEMINI_DAILY_REQUEST_LIMIT,
    DEFAULT_GEMINI_DAILY_REQUEST_LIMIT,
  );
  const nvidiaLimit = positiveNumber(
    env.NVIDIA_MONTHLY_REQUEST_LIMIT,
    DEFAULT_NVIDIA_MONTHLY_REQUEST_LIMIT,
  );
  const huggingFaceLimit = positiveNumber(
    env.HUGGINGFACE_MONTHLY_CREDIT_USD,
    DEFAULT_HUGGINGFACE_MONTHLY_CREDIT_USD,
  );
  const huggingFaceRate = positiveNumber(
    env.HUGGINGFACE_USD_PER_SECOND,
    DEFAULT_HUGGINGFACE_USD_PER_SECOND,
  );
  const defaults = [
    emptyRecord('gemini', env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL, now),
    emptyRecord('nvidia', env.NVIDIA_MODEL || DEFAULT_NVIDIA_MODEL, now),
    emptyRecord('huggingface', env.HUGGINGFACE_MODEL || DEFAULT_HUGGINGFACE_MODEL, now),
  ];
  const current = Array.isArray(records)
    ? records.filter((record) => {
        if (!record || !PROVIDERS.has(record.provider)) return false;
        return record.periodKey === usagePeriod(record.provider, now).periodKey;
      })
    : [];
  const byModel = new Map(defaults.map((record) => [`${record.provider}:${record.model}`, record]));
  for (const record of current) byModel.set(`${record.provider}:${record.model}`, record);

  const models = [...byModel.values()]
    .map((record) => {
      const requests = finiteNonNegative(record.requests);
      const common = {
        provider: record.provider,
        model: record.model,
        period: record.period,
        periodKey: record.periodKey,
        requests,
        successfulRequests: finiteNonNegative(record.successfulRequests),
        failedRequests: finiteNonNegative(record.failedRequests),
        promptTokens: finiteNonNegative(record.promptTokens),
        outputTokens: finiteNonNegative(record.outputTokens),
        totalTokens: finiteNonNegative(record.totalTokens),
        computeSeconds: finiteNonNegative(record.computeSeconds),
        providerMeasuredRequests: finiteNonNegative(record.providerMeasuredRequests),
        updatedAt: record.updatedAt || null,
      };
      if (record.provider === 'gemini') {
        return {
          ...common,
          metric: 'requests',
          used: requests,
          limit: geminiLimit,
          estimated: false,
        };
      }
      if (record.provider === 'nvidia') {
        // build.nvidia.com charges one credit per request, so the request
        // count IS the credit spend — no estimation involved.
        return {
          ...common,
          metric: 'requests',
          used: requests,
          limit: nvidiaLimit,
          estimated: false,
        };
      }
      return {
        ...common,
        metric: 'usd',
        used: common.computeSeconds * huggingFaceRate,
        limit: huggingFaceLimit,
        estimated: true,
        usdPerSecond: huggingFaceRate,
      };
    })
    .sort((a, b) => {
      if (a.provider !== b.provider) {
        return (PROVIDER_RANK[a.provider] ?? 9) - (PROVIDER_RANK[b.provider] ?? 9);
      }
      return a.model.localeCompare(b.model);
    });

  return {
    generatedAt: now.toISOString(),
    source: 'shared-proxy',
    models,
  };
}
