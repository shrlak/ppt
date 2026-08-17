export interface ModelEvaluation {
  modelKey: string;
  title: number;
  artist?: number;
  order: number;
  lyrics: number;
  success: boolean;
  latencyMs: number;
}

export interface ModelReliabilityRecord extends ModelEvaluation {
  samples: number;
  artistSamples: number;
  successRate: number;
  updatedAt: string;
  recent: { composite: number; success: boolean }[];
  baseline: number;
  paused?: boolean;
  pausedReason?: 'failures' | 'regression';
}

export const MIN_CHAMPION_SAMPLES: number;
export const RECENT_WINDOW: number;
export const PAUSE_FAILURE_RATE: number;
export const PAUSE_REGRESSION: number;
export const DECAY_HALF_LIFE_DAYS: number;
export const MAX_TRACKED_MODELS: number;

export function modelStatsKey(modelKey: unknown): string | null;
export function sanitizeModelEvaluation(raw: unknown): ModelEvaluation | null;
export function compositeAccuracy(fields: {
  title: number;
  artist?: number;
  order: number;
  lyrics: number;
}): number;
export function composite(value: ModelReliabilityRecord): number;
export function emptyReliability(modelKey: string, now?: Date): ModelReliabilityRecord;
export function decayFactor(updatedAt: string, now: Date): number;
export function applyPauseRules(value: ModelReliabilityRecord): ModelReliabilityRecord;
export function mergeModelEvaluation(
  current: ModelReliabilityRecord | null | undefined,
  evaluation: ModelEvaluation,
  now?: Date,
): ModelReliabilityRecord;
export function publicModelStats(value: ModelReliabilityRecord): Record<string, unknown>;
