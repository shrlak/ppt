import { describe, expect, it } from 'vitest';
import { RecognitionError, parseRetryAfterMs } from '../../src/lib/ai/recognitionError';
import {
  classifyRecognitionError,
  isExhaustedForToday,
  isRetryableRecognitionError,
} from '../../src/lib/ai/recognitionObservation';

const GEMINI_QUOTA = 'Gemini 일괄 호출 실패: You exceeded your current quota, please check your plan and billing details.';

describe('classifyRecognitionError', () => {
  it('tells Gemini’s per-minute limit from its daily one by the quota it names', () => {
    // Both arrive as 429 and both say "quota"; dropping a model for the whole
    // conti over a limit that lifts in seconds left pages unread.
    const perMinute = new RecognitionError(`${GEMINI_QUOTA} [GenerateRequestsPerMinutePerProjectPerModel-FreeTier]`, 429);
    const perDay = new RecognitionError(`${GEMINI_QUOTA} [GenerateRequestsPerDayPerProjectPerModel-FreeTier]`, 429);
    expect(classifyRecognitionError(perMinute)).toBe('rate-limit');
    expect(classifyRecognitionError(perDay)).toBe('quota');
    expect(isExhaustedForToday(classifyRecognitionError(perMinute))).toBe(false);
    expect(isExhaustedForToday(classifyRecognitionError(perDay))).toBe(true);
  });

  it('still reads a bare quota message as spent', () => {
    expect(classifyRecognitionError(new RecognitionError(GEMINI_QUOTA, 429))).toBe('quota');
    expect(classifyRecognitionError(new RecognitionError('Rate limit exceeded: free-models-per-day', 429))).toBe(
      'quota',
    );
  });

  it('reads OpenRouter’s upstream rate limit as a burst', () => {
    const upstream = new RecognitionError(
      'OpenRouter 호출 실패: Provider returned error (google/gemma-4-31b-it:free is temporarily rate-limited upstream. Please retry shortly)',
      429,
    );
    expect(classifyRecognitionError(upstream)).toBe('rate-limit');
  });
});

describe('isRetryableRecognitionError', () => {
  it('retries a busy provider, a burst limit, a timeout and a dropped connection', () => {
    expect(isRetryableRecognitionError(new RecognitionError('high demand', 503))).toBe(true);
    expect(isRetryableRecognitionError(new RecognitionError('bad gateway', 502))).toBe(true);
    expect(isRetryableRecognitionError(new RecognitionError('timeout', 408))).toBe(true);
    expect(isRetryableRecognitionError(new RecognitionError('[…PerMinute…]', 429))).toBe(true);
    expect(isRetryableRecognitionError(new TypeError('Failed to fetch'))).toBe(true);
  });

  it('does not retry what another try cannot fix', () => {
    expect(isRetryableRecognitionError(new RecognitionError('[…PerDay…]', 429))).toBe(false);
    expect(isRetryableRecognitionError(new RecognitionError('No endpoints found', 404))).toBe(false);
    expect(isRetryableRecognitionError(new RecognitionError('bad key', 403))).toBe(false);
    expect(isRetryableRecognitionError(new Error('Gemini 응답을 JSON으로 해석하지 못했습니다.'))).toBe(false);
  });
});

describe('parseRetryAfterMs', () => {
  it('reads seconds from a Retry-After header or a RetryInfo delay', () => {
    expect(parseRetryAfterMs('41s')).toBe(41_000);
    expect(parseRetryAfterMs('1.5s')).toBe(1500);
    expect(parseRetryAfterMs('20')).toBe(20_000);
    expect(parseRetryAfterMs('Wed, 21 Oct 2026 07:28:00 GMT')).toBeUndefined();
    expect(parseRetryAfterMs(null)).toBeUndefined();
  });
});
