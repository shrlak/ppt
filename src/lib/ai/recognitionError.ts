// Error type shared by the recognition engines so the orchestrator can tell
// transient failures (worth one quick retry) from permanent ones (let the
// other concurrently running models carry the request).

/** An engine call that failed with a known HTTP status. */
export class RecognitionError extends Error {
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = 'RecognitionError';
    this.status = status;
  }
}

/**
 * True for failures that often succeed on an immediate retry: request
 * timeout (408), server-side errors (5xx), and network-level fetch failures
 * (which surface as TypeError in browsers).
 *
 * 429 is deliberately NOT transient: Gemini free-tier rate limits ask for
 * 15-50s waits (and exhausted daily/zero quotas never recover), so a quick
 * retry of the same model is wasted — the other models are already running
 * concurrently and are more likely to succeed first.
 */
export function isTransientRecognitionError(error: unknown): boolean {
  if (error instanceof RecognitionError && error.status != null) {
    return error.status === 408 || error.status >= 500;
  }
  return error instanceof TypeError;
}
