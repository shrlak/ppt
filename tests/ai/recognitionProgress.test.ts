import { describe, expect, it } from 'vitest';
import {
  RECOGNITION_PHASES,
  easedPhaseFraction,
  progressPercent,
  recognitionProgress,
  type RecognitionPhase,
} from '../../src/lib/ai/recognitionProgress';

describe('recognition phase spans', () => {
  it('covers 0% to ~100% across the pipeline in stage order', () => {
    expect(RECOGNITION_PHASES.render.start).toBe(0);
    expect(RECOGNITION_PHASES.render.end).toBeCloseTo(RECOGNITION_PHASES.titles.start);
    expect(RECOGNITION_PHASES.titles.end).toBeCloseTo(RECOGNITION_PHASES.lyrics.start);
    expect(RECOGNITION_PHASES.lyrics.end).toBeLessThan(1);
    expect(RECOGNITION_PHASES.rescue.end).toBeLessThan(1);
  });
});

describe('easedPhaseFraction', () => {
  it('starts at zero and increases with time', () => {
    expect(easedPhaseFraction(0, 10000)).toBe(0);
    const early = easedPhaseFraction(1000, 10000);
    const late = easedPhaseFraction(8000, 10000);
    expect(early).toBeGreaterThan(0);
    expect(late).toBeGreaterThan(early);
  });

  it('approaches but does not reach 1 while a slow request overruns its expected duration', () => {
    const value = easedPhaseFraction(30000, 10000);
    expect(value).toBeGreaterThan(0.99);
    expect(value).toBeLessThan(1);
  });

  it('reaches ~95% of the stage at its expected duration', () => {
    expect(easedPhaseFraction(10000, 10000)).toBeCloseTo(0.95, 1);
  });
});

describe('recognitionProgress', () => {
  it('never leaves a stage’s own span while that stage runs', () => {
    for (const phase of Object.keys(RECOGNITION_PHASES) as RecognitionPhase[]) {
      const span = RECOGNITION_PHASES[phase];
      expect(recognitionProgress(phase, 0)).toBeCloseTo(span.start);
      expect(recognitionProgress(phase, 60 * 60_000)).toBeLessThan(span.end + 1e-9);
    }
  });

  it('uses real fractional progress when it is ahead of the time-based easing', () => {
    // All pages rendered instantly: the render stage should report complete.
    expect(recognitionProgress('render', 0, 1)).toBeCloseTo(RECOGNITION_PHASES.render.end);
    // Real progress can only speed the bar up, never slow it down.
    const timeOnly = recognitionProgress('lyrics', 15000);
    expect(recognitionProgress('lyrics', 15000, 0.01)).toBeCloseTo(timeOnly);
  });

  it('is monotonic across consecutive stage transitions', () => {
    // The handoff from one stage's asymptote to the next stage's floor must
    // never move the percentage backwards.
    const endOfRender = recognitionProgress('render', 60_000, 1);
    const startOfTitles = recognitionProgress('titles', 0);
    expect(startOfTitles).toBeGreaterThanOrEqual(endOfRender - 1e-9);

    const endOfTitles = recognitionProgress('titles', 60 * 60_000);
    const startOfLyrics = recognitionProgress('lyrics', 0);
    expect(startOfLyrics).toBeGreaterThanOrEqual(endOfTitles - 0.01);
  });
});

describe('progressPercent', () => {
  it('renders a 0–1 progress value as a clamped integer percentage', () => {
    expect(progressPercent(undefined)).toBe(0);
    expect(progressPercent(0.454)).toBe(45);
    expect(progressPercent(1.2)).toBe(100);
    expect(progressPercent(-1)).toBe(0);
  });
});
