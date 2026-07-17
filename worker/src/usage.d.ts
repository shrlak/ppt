export type UsageProvider = 'gemini' | 'openrouter' | 'nvidia' | 'huggingface';

export interface UsageEvent {
  provider: UsageProvider;
  model: string;
  success?: boolean;
  timestamp?: string | Date;
  promptTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  computeSeconds?: number;
  wallSeconds?: number;
  computeSource?: 'provider' | 'wall';
}

export interface UsageRecord {
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
  wallSeconds: number;
  providerMeasuredRequests: number;
  updatedAt: string | null;
}

export const DEFAULT_GEMINI_MODEL: string;
export const DEFAULT_NVIDIA_MODEL: string;
export const DEFAULT_OPENROUTER_MODEL: string;
export const DEFAULT_HUGGINGFACE_MODEL: string;
export const DEFAULT_GEMINI_DAILY_REQUEST_LIMIT: number;
export const DEFAULT_OPENROUTER_DAILY_REQUEST_LIMIT: number;
export const DEFAULT_NVIDIA_MONTHLY_REQUEST_LIMIT: number;
export const DEFAULT_HUGGINGFACE_MONTHLY_CREDIT_USD: number;
export const DEFAULT_HUGGINGFACE_USD_PER_SECOND: number;

export function pacificDateKey(value?: string | Date): string;
export function utcDateKey(value?: string | Date): string;
export function utcMonthKey(value?: string | Date): string;
export function usagePeriod(
  provider: UsageProvider,
  value?: string | Date,
): { period: 'day' | 'month'; periodKey: string };
export function sanitizeUsageEvent(raw: UsageEvent, now?: Date): Required<UsageEvent>;
export function usageStorageKey(event: UsageEvent): string;
export function mergeUsageRecord(current: UsageRecord | undefined, rawEvent: UsageEvent): UsageRecord;
export function buildUsageSnapshot(
  records: UsageRecord[],
  env?: Record<string, string | undefined>,
  now?: Date,
  catalogModels?: { provider: UsageProvider; model: string }[] | null,
): {
  generatedAt: string;
  source: 'shared-proxy';
  models: Array<UsageRecord & {
    metric: 'requests' | 'usd';
    used: number;
    limit: number;
    estimated: boolean;
    usdPerSecond?: number;
  }>;
};
