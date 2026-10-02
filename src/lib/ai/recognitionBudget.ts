// Wall-clock budget for one recognition job.
//
// Each stage used to wait as long as its slowest model wanted (up to two
// minutes per model call), and the stages ran one after another: title pass,
// escalations one challenger at a time, lyrics pass, more escalations, the
// per-page rescue, then the web lookup. A conti could easily take five minutes
// or more. The whole job now runs against one deadline, and every stage is
// handed a fixed point on it to be done by. A model that has not answered by
// then is recorded as a timeout and the models that did answer decide the page.
//
// The clock starts once the pages are drawn and the settings are in: drawing
// is the browser's work, and counting it against the models only shortened
// the time they had to read.

/** The whole job — first model call to last web lookup — finishes inside this. */
export const RECOGNITION_BUDGET_MS = 155_000;

/**
 * Where each stage must be finished, measured from the start of the job.
 *
 * Title pass is small (a few tokens per page) but still gates the library
 * shortcut, so it gets a short slice. The lyrics pass is the real work and gets
 * most of the budget. The corrector gets a short slice of its own, so it can
 * never eat into the rescue. Rescue reads one page per call, which takes a
 * model as long as a batch takes it — so it is left a full window rather than
 * whatever the lyrics pass did not use (it once had fifteen seconds, and every
 * rescued page came back as a timeout). The web lookup carries its own short
 * per-request timeout after that.
 */
export const STAGE_DEADLINES_MS = {
  titles: 30_000,
  lyrics: 90_000,
  crosscheck: 100_000,
  rescue: 140_000,
} as const;

export type BudgetedStage = keyof typeof STAGE_DEADLINES_MS;

/** Below this, a model call cannot realistically come back — don't start one. */
export const MIN_ATTEMPT_MS = 4_000;

/**
 * An escalation to a challenger is only worth starting with at least this much
 * left: a challenger that is cut off mid-answer spends quota for nothing.
 */
export const MIN_ESCALATION_MS = 12_000;

/**
 * The least a rescue call is given, wherever the clock stands. A page reaches
 * rescue because the batch could not read it; cutting its one retry short
 * turns a slow answer into a failed card.
 */
export const MIN_RESCUE_ATTEMPT_MS = 40_000;

/**
 * How long the lyrics pass waits for the correction model to finish loading.
 * It loads while the models read; still loading after that is a slow
 * download, and waiting on it would hold every page that needs a rescue.
 */
export const CORRECTOR_WAIT_MS = 3_000;

export interface RecognitionDeadline {
  /** Epoch ms by which the given stage must be done (never past the whole job). */
  stageEndsAt(stage: BudgetedStage): number;
  /** Milliseconds left before the given stage's deadline (0 once passed). */
  remaining(stage: BudgetedStage): number;
  /** Milliseconds left in the whole job. */
  remainingTotal(): number;
}

export function createRecognitionDeadline(
  startedAt: number = Date.now(),
  now: () => number = Date.now,
): RecognitionDeadline {
  const jobEndsAt = startedAt + RECOGNITION_BUDGET_MS;
  const stageEndsAt = (stage: BudgetedStage) => Math.min(jobEndsAt, startedAt + STAGE_DEADLINES_MS[stage]);
  return {
    stageEndsAt,
    remaining: (stage) => Math.max(0, stageEndsAt(stage) - now()),
    remainingTotal: () => Math.max(0, jobEndsAt - now()),
  };
}

/** How long one rescue call may run: the rescue stage's time, never less than a page needs. */
export function rescueAttemptMs(deadline: RecognitionDeadline): number {
  return Math.max(deadline.remaining('rescue'), MIN_RESCUE_ATTEMPT_MS);
}

/** Milliseconds from now until an epoch-ms deadline, never negative. */
export function msUntil(deadlineAt: number, now: number = Date.now()): number {
  return Math.max(0, deadlineAt - now);
}
