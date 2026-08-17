// One model's settled attempt at one page.
//
// Recognition used to keep only the answer that won a page and drop the rest.
// The losing answers are the evidence: they are what lets models outvote each
// other, and — once the user verifies the song — what each model's accuracy is
// measured from. So every call now resolves to an observation, successful or
// not.
//
// Failures are recorded as a CATEGORY, never as the provider's response body.
// A body can contain the prompt back, and the prompt contains lyrics; a
// category is enough to decide whether to retry, pause, or stop calling a
// model for the rest of the job.
import type { RecognitionAttempt } from './aiSettings';
import { RecognitionError } from './recognitionError';
import type { ParsedScore } from './scoreParser';

/** Why a model call did not produce an answer. */
export type RecognitionErrorCategory =
  /** The free daily allowance is gone; it will not recover within this job. */
  | 'quota'
  /** Too many requests just now — the same model may work again shortly. */
  | 'rate-limit'
  | 'auth'
  | 'timeout'
  | 'server'
  | 'network'
  /** The model answered, but not with anything parseable. */
  | 'format'
  | 'unknown';

export interface RecognitionObservation {
  attempt: RecognitionAttempt;
  /** The model's answer; absent when the call failed. */
  score?: ParsedScore;
  error?: RecognitionErrorCategory;
  latencyMs: number;
}

/** Wording providers use when the allowance is spent for the day, not the minute. */
const DAILY_LIMIT_WORDING =
  /per[- ]?day|per[- ]?d\b|daily|하루|일일|rpd|free-models-per-day|quota|exhaust/i;

/**
 * Reduce a thrown error to a storable category.
 *
 * Telling a daily exhaustion apart from a burst rate-limit is the distinction
 * that matters: retrying a burst can succeed within seconds, and retrying an
 * exhausted daily quota cannot succeed at all today. Both arrive as HTTP 429,
 * so the provider's wording is the only signal — it is read here and then
 * discarded.
 */
export function classifyRecognitionError(error: unknown): RecognitionErrorCategory {
  const message = error instanceof Error ? error.message : String(error ?? '');
  if (error instanceof RecognitionError && error.status != null) {
    const { status } = error;
    if (status === 429) return DAILY_LIMIT_WORDING.test(message) ? 'quota' : 'rate-limit';
    if (status === 401 || status === 403) return 'auth';
    if (status === 408) return 'timeout';
    if (status >= 500) return 'server';
    if (status === 402) return 'quota';
  }
  if (error instanceof TypeError) return 'network';
  if (/JSON|해석하지 못했습니다|비어 있습니다/i.test(message)) return 'format';
  if (/abort|timeout/i.test(message)) return 'timeout';
  return 'unknown';
}

/** True when this model is finished for the rest of the job, not just this call. */
export function isExhaustedForToday(category: RecognitionErrorCategory | undefined): boolean {
  return category === 'quota';
}

/** The category as text the UI can show, separated from a plain read failure. */
export const ERROR_CATEGORY_LABELS: Record<RecognitionErrorCategory, string> = {
  quota: '무료 한도 소진',
  'rate-limit': '요청이 몰려 잠시 실패',
  auth: 'API 키 오류',
  timeout: '응답 시간 초과',
  server: '제공자 서버 오류',
  network: '네트워크 오류',
  format: '응답 형식 오류',
  unknown: '인식 실패',
};

/** Observations that actually carry an answer. */
export function answeredObservations(observations: RecognitionObservation[]): RecognitionObservation[] {
  return observations.filter((observation) => !!observation.score);
}
