import { describe, expect, it } from 'vitest';
import {
  CORRECTOR_WAIT_MS,
  MIN_RESCUE_ATTEMPT_MS,
  RECOGNITION_BUDGET_MS,
  STAGE_DEADLINES_MS,
  createRecognitionDeadline,
  rescueAttemptMs,
} from '../../src/lib/ai/recognitionBudget';

describe('createRecognitionDeadline', () => {
  it('keeps the whole job under three minutes', () => {
    expect(RECOGNITION_BUDGET_MS).toBeLessThan(180_000);
    for (const stageEnd of Object.values(STAGE_DEADLINES_MS)) {
      expect(stageEnd).toBeLessThanOrEqual(RECOGNITION_BUDGET_MS);
    }
  });

  it('orders the stages titles → lyrics → crosscheck → rescue', () => {
    expect(STAGE_DEADLINES_MS.titles).toBeLessThan(STAGE_DEADLINES_MS.lyrics);
    expect(STAGE_DEADLINES_MS.lyrics).toBeLessThan(STAGE_DEADLINES_MS.crosscheck);
    expect(STAGE_DEADLINES_MS.crosscheck).toBeLessThan(STAGE_DEADLINES_MS.rescue);
  });

  it('leaves the rescue a full window for one page after everything before it', () => {
    // The rescue once had what the lyrics pass left over — fifteen seconds at
    // best — and every page it retried came back as a timeout.
    expect(STAGE_DEADLINES_MS.rescue - STAGE_DEADLINES_MS.crosscheck).toBeGreaterThanOrEqual(MIN_RESCUE_ATTEMPT_MS);
    expect(RECOGNITION_BUDGET_MS - STAGE_DEADLINES_MS.crosscheck).toBeGreaterThanOrEqual(MIN_RESCUE_ATTEMPT_MS);
    // Waiting on the corrector can never use up the crosscheck slice.
    expect(CORRECTOR_WAIT_MS).toBeLessThan(STAGE_DEADLINES_MS.crosscheck - STAGE_DEADLINES_MS.lyrics);
  });

  it('counts down from the job start and never goes negative', () => {
    let now = 1_000;
    const deadline = createRecognitionDeadline(1_000, () => now);
    expect(deadline.stageEndsAt('titles')).toBe(1_000 + STAGE_DEADLINES_MS.titles);
    expect(deadline.remaining('titles')).toBe(STAGE_DEADLINES_MS.titles);

    now += 10_000;
    expect(deadline.remaining('titles')).toBe(STAGE_DEADLINES_MS.titles - 10_000);
    expect(deadline.remainingTotal()).toBe(RECOGNITION_BUDGET_MS - 10_000);

    now += 10 * 60_000;
    expect(deadline.remaining('rescue')).toBe(0);
    expect(deadline.remainingTotal()).toBe(0);
  });
});

describe('rescueAttemptMs', () => {
  it('gives a rescue the rest of its stage', () => {
    let now = 0;
    const deadline = createRecognitionDeadline(0, () => now);
    now = STAGE_DEADLINES_MS.lyrics;
    expect(rescueAttemptMs(deadline)).toBe(STAGE_DEADLINES_MS.rescue - STAGE_DEADLINES_MS.lyrics);
  });

  it('never cuts a rescue shorter than one page needs', () => {
    let now = 0;
    const deadline = createRecognitionDeadline(0, () => now);
    now = STAGE_DEADLINES_MS.rescue - 5_000;
    expect(rescueAttemptMs(deadline)).toBe(MIN_RESCUE_ATTEMPT_MS);
    now = STAGE_DEADLINES_MS.rescue + 60_000;
    expect(rescueAttemptMs(deadline)).toBe(MIN_RESCUE_ATTEMPT_MS);
  });
});
