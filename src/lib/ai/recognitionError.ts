// Error type shared by the recognition engines so the orchestrator can tell
// transient failures (worth trying again shortly) from permanent ones (let the
// other concurrently running models carry the request).

/** An engine call that failed with a known HTTP status. */
export class RecognitionError extends Error {
  readonly status?: number;
  /** How long the provider asked to wait before trying again, when it said. */
  readonly retryAfterMs?: number;

  constructor(message: string, status?: number, retryAfterMs?: number) {
    super(message);
    this.name = 'RecognitionError';
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

/**
 * A provider's "try again in N" as milliseconds: an HTTP Retry-After header
 * (seconds) or a duration such as Gemini's RetryInfo `"41s"` / `"1.5s"`.
 */
export function parseRetryAfterMs(value: string | null | undefined): number | undefined {
  const match = /^\s*(\d+(?:\.\d+)?)\s*s?\s*$/.exec(value ?? '');
  if (!match) return undefined;
  const ms = Math.round(Number(match[1]) * 1000);
  return Number.isFinite(ms) && ms >= 0 ? ms : undefined;
}

/**
 * True for failures that often succeed when tried again shortly: request
 * timeout (408), server-side errors (5xx — above all Gemini's 503 "This model
 * is currently experiencing high demand", which free-tier calls get in spikes
 * that can last a minute), and network-level fetch failures (which surface as
 * TypeError in browsers).
 *
 * 429 is not decided here: a burst rate limit is worth waiting out, a spent
 * daily quota never recovers today, and only the provider's wording tells them
 * apart (see classifyRecognitionError).
 */
export function isTransientRecognitionError(error: unknown): boolean {
  if (error instanceof RecognitionError && error.status != null) {
    return error.status === 408 || error.status >= 500;
  }
  return error instanceof TypeError;
}
