// Progress model for the score-recognition pipeline. Recognition is a handful
// of opaque awaits (render pages → batch title pass → batch lyric pass →
// per-page rescue), so overall progress maps each stage onto a fixed slice of
// 0–100%. Rendering reports real per-page completion; the network stages have
// no byte-level progress, so within a stage the percentage eases toward the
// stage's upper bound based on elapsed time vs. how long that stage usually
// takes. The bar therefore always moves, never jumps backwards, and never
// claims 100% before the work is actually done.

/** Pipeline stages, in execution order. */
export type RecognitionPhase = 'render' | 'titles' | 'lyrics' | 'rescue';

export interface PhaseSpan {
  /** Overall fraction where this stage begins. */
  start: number;
  /** Overall fraction this stage approaches (never exceeded while running). */
  end: number;
  /** Typical wall time of the stage, used to pace the easing. */
  expectedMs: number;
}

export const RECOGNITION_PHASES: Record<RecognitionPhase, PhaseSpan> = {
  render: { start: 0, end: 0.12, expectedMs: 4000 },
  titles: { start: 0.12, end: 0.45, expectedMs: 9000 },
  lyrics: { start: 0.45, end: 0.97, expectedMs: 22000 },
  // Rescue re-runs only the pages the batch pass missed; it overlaps the tail
  // of the lyrics span so the bar keeps creeping instead of jumping back.
  rescue: { start: 0.9, end: 0.99, expectedMs: 15000 },
};

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/**
 * Fraction of a stage completed after `elapsedMs`. `1 - e^(-3t/expected)`
 * reaches ~95% of the stage at its expected duration and keeps crawling
 * asymptotically afterwards, so a slow request still shows visible motion.
 */
export function easedPhaseFraction(elapsedMs: number, expectedMs: number): number {
  if (expectedMs <= 0) return 1;
  return 1 - Math.exp((-3 * Math.max(0, elapsedMs)) / expectedMs);
}

/**
 * Overall 0–1 progress while `phase` is running. `realFraction` (0–1) is used
 * for stages with measurable progress (page rendering); time-based easing
 * fills in for the opaque network stages. When both are available the larger
 * wins, so real progress can only speed the bar up, never stall it.
 */
export function recognitionProgress(
  phase: RecognitionPhase,
  elapsedMs: number,
  realFraction?: number,
): number {
  const span = RECOGNITION_PHASES[phase];
  const eased = easedPhaseFraction(elapsedMs, span.expectedMs);
  const fraction = Math.max(eased, clamp01(realFraction ?? 0));
  return span.start + (span.end - span.start) * clamp01(fraction);
}

/** Render a 0–1 progress value as the integer percentage the UI shows. */
export function progressPercent(progress: number | undefined): number {
  return Math.round(clamp01(progress ?? 0) * 100);
}
