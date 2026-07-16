// Error type shared by the recognition engines so the orchestrator can tell
// transient failures (worth one quick retry) from permanent ones (move on to
// the next engine immediately).

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
 * True for failures that often succeed on an immediate retry: rate limiting
 * (429), request timeout (408), server-side errors (5xx), and network-level
 * fetch failures (which surface as TypeError in browsers).
 */
export function isTransientRecognitionError(error: unknown): boolean {
  if (error instanceof RecognitionError && error.status != null) {
    return error.status === 408 || error.status === 429 || error.status >= 500;
  }
  return error instanceof TypeError;
}
