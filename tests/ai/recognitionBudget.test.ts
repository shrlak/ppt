import { describe, expect, it } from 'vitest';
import {
  RECOGNITION_BUDGET_MS,
  STAGE_DEADLINES_MS,
  createRecognitionDeadline,
} from '../../src/lib/ai/recognitionBudget';

describe('createRecognitionDeadline', () => {
  it('keeps the whole job under two minutes', () => {
    expect(RECOGNITION_BUDGET_MS).toBeLessThan(120_000);
    for (const stageEnd of Object.values(STAGE_DEADLINES_MS)) {
      expect(stageEnd).toBeLessThanOrEqual(RECOGNITION_BUDGET_MS);
    }
  });

  it('orders the stages titles → lyrics → rescue', () => {
    expect(STAGE_DEADLINES_MS.titles).toBeLessThan(STAGE_DEADLINES_MS.lyrics);
    expect(STAGE_DEADLINES_MS.lyrics).toBeLessThan(STAGE_DEADLINES_MS.rescue);
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
