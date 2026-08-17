import { describe, expect, it } from 'vitest';
import {
  planAdaptiveAttempts,
  recognizeAdaptiveBatch,
  type BatchProvider,
} from '../../src/lib/ai/adaptiveRecognition';
import {
  DEFAULT_AI_SETTINGS,
  RECOGNITION_MODEL_CATALOG,
  type AiSettings,
  type RecognitionAttempt,
} from '../../src/lib/ai/aiSettings';
import { emptyReliability, modelKeyFor, rankModels, type ModelReliability } from '../../src/lib/ai/modelReliability';
import { RecognitionError } from '../../src/lib/ai/recognitionError';
import type { BatchAttemptResult } from '../../src/lib/ai/scoreRecognition';
import type { ParsedScore } from '../../src/lib/ai/scoreParser';

const NOW = new Date('2026-08-14T00:00:00.000Z');

const settings: AiSettings = { ...DEFAULT_AI_SETTINGS, geminiApiKey: 'test-key', openrouterApiKey: 'test-key' };

const CHAMPIONS = RECOGNITION_MODEL_CATALOG.filter((entry) => entry.role === 'champion');
const CHALLENGERS = RECOGNITION_MODEL_CATALOG.filter((entry) => entry.role === 'challenger');

const roleOf = (attempt: RecognitionAttempt) =>
  RECOGNITION_MODEL_CATALOG.find((entry) => entry.model === attempt.model)?.role ?? 'challenger';

interface ProviderCall {
  attempt: RecognitionAttempt;
  role: string;
  images: string[];
}

/** A stand-in provider that answers from a per-model script. */
function fakeProviderFor(answers: (attempt: RecognitionAttempt, image: string) => ParsedScore | Error) {
  const calls: ProviderCall[] = [];
  const provider: BatchProvider = async (attempt, dataUrls) => {
    calls.push({ attempt, role: roleOf(attempt), images: [...dataUrls] });
    const scores: ParsedScore[] = [];
    for (const image of dataUrls) {
      const answer = answers(attempt, image);
      if (answer instanceof Error) {
        return {
          attempt,
          error: answer instanceof RecognitionError && answer.status === 429 ? 'quota' : 'unknown',
          latencyMs: 10,
        } satisfies BatchAttemptResult;
      }
      scores.push(answer);
    }
    return { attempt, scores, latencyMs: 10 } satisfies BatchAttemptResult;
  };
  return {
    provider,
    calls,
    get challengerPageIndexes(): number[][] {
      return calls
        .filter((call) => call.role === 'challenger')
        .map((call) => call.images.map((image) => Number(image.replace('page-', ''))));
    },
  };
}

const verse = (lines: string[]): ParsedScore => ({
  title: '은혜의 노래',
  order: ['I', 'V'],
  sections: [{ label: 'V', lines }],
});

const AGREED = verse(['빛으로 인도하시네', '영원히 노래하리']);
/** A different sentence altogether: never votes, so the page never settles. */
const DISAGREED = verse(['전혀 다른 문장이 적혀 있네', '영원히 노래하리']);
/** One syllable out — close enough to vote, so one more reading settles it. */
const CORRECT_ONE_LINE = verse(['빛으로 인도하시네']);
const MISREAD_ONE_LINE = verse(['빛으로 인도하시내']);

describe('planAdaptiveAttempts', () => {
  const rankings = rankModels(RECOGNITION_MODEL_CATALOG, [], NOW);

  it('starts from the catalog roles while the pool is still unmeasured', () => {
    const plan = planAdaptiveAttempts(RECOGNITION_MODEL_CATALOG, rankings);
    expect(plan.champions).toHaveLength(3);
    expect(plan.champions.map((attempt) => attempt.model)).toEqual(CHAMPIONS.map((entry) => entry.model));
    expect(plan.challengers.map((attempt) => attempt.model).sort()).toEqual(
      CHALLENGERS.map((entry) => entry.model).sort(),
    );
  });

  it('lets measured accuracy take over once enough models clear the sample bar', () => {
    const measured: ModelReliability[] = RECOGNITION_MODEL_CATALOG.map((entry, index) => ({
      ...emptyReliability(modelKeyFor(entry), NOW),
      samples: 40,
      // Reverse the catalog order: the last entries are now the best.
      title: 0.6 + index * 0.05,
      order: 0.6 + index * 0.05,
      lyrics: 0.6 + index * 0.05,
      successRate: 1,
    }));
    const plan = planAdaptiveAttempts(
      RECOGNITION_MODEL_CATALOG,
      rankModels(RECOGNITION_MODEL_CATALOG, measured, NOW),
      new Set(),
    );
    expect(plan.champions.map((attempt) => attempt.model)).toEqual(
      RECOGNITION_MODEL_CATALOG.slice(-3).reverse().map((entry) => entry.model),
    );
  });

  it('leaves out paused models and ones whose free allowance is gone', () => {
    const paused: ModelReliability[] = [
      { ...emptyReliability(modelKeyFor(CHAMPIONS[0]), NOW), samples: 40, paused: true },
    ];
    const spent = new Set([modelKeyFor(CHAMPIONS[1])]);
    const plan = planAdaptiveAttempts(
      RECOGNITION_MODEL_CATALOG,
      rankModels(RECOGNITION_MODEL_CATALOG, paused, NOW),
      spent,
    );
    const chosen = [...plan.champions, ...plan.challengers].map((attempt) => attempt.model);
    expect(chosen).not.toContain(CHAMPIONS[0].model);
    expect(chosen).not.toContain(CHAMPIONS[1].model);
  });

  it('lets an administrator pin a role over what was measured', () => {
    const measured: ModelReliability[] = [
      { ...emptyReliability(modelKeyFor(CHALLENGERS[0]), NOW), samples: 40, paused: true },
    ];
    const plan = planAdaptiveAttempts(
      RECOGNITION_MODEL_CATALOG,
      rankModels(RECOGNITION_MODEL_CATALOG, measured, NOW),
      new Set(),
      [],
      // Turning a paused model back on is something an administrator can see
      // and the pause rules cannot.
      { [modelKeyFor(CHALLENGERS[0])]: 'champion', [modelKeyFor(CHAMPIONS[0])]: 'paused' },
    );
    expect(plan.champions.map((attempt) => attempt.model)).toContain(CHALLENGERS[0].model);
    expect([...plan.champions, ...plan.challengers].map((attempt) => attempt.model)).not.toContain(
      CHAMPIONS[0].model,
    );
  });

  it('has nothing to escalate when every page is already settled', () => {
    expect(planAdaptiveAttempts(RECOGNITION_MODEL_CATALOG, rankings, new Set(), [false, false]).challengers).toEqual(
      [],
    );
    expect(
      planAdaptiveAttempts(RECOGNITION_MODEL_CATALOG, rankings, new Set(), [false, true]).challengers.length,
    ).toBeGreaterThan(0);
  });
});

describe('recognizeAdaptiveBatch', () => {
  it('does not call challengers when three champions agree', async () => {
    const fakeProvider = fakeProviderFor(() => AGREED);

    const result = await recognizeAdaptiveBatch(
      ['page-0'],
      settings,
      'full',
      undefined,
      [],
      fakeProvider.provider,
    );

    expect(fakeProvider.calls.filter((call) => call.role === 'challenger')).toHaveLength(0);
    expect(fakeProvider.calls).toHaveLength(3);
    expect(result.needsReview).toEqual([false]);
    expect(result.scores[0].sections[0].lines).toEqual(AGREED.sections[0].lines);
  });

  it('sends only the uncertain page to one challenger at a time', async () => {
    // Page 0 is read the same way by every champion. On page 1 one champion is
    // a syllable out, which one more reading is enough to settle.
    const fakeProvider = fakeProviderFor((attempt, image) => {
      if (image === 'page-0') return AGREED;
      return attempt.model === CHAMPIONS[2].model ? MISREAD_ONE_LINE : CORRECT_ONE_LINE;
    });

    const result = await recognizeAdaptiveBatch(
      ['page-0', 'page-1'],
      settings,
      'full',
      undefined,
      [],
      fakeProvider.provider,
    );

    expect(fakeProvider.challengerPageIndexes).toEqual([[1]]);
    expect(result.scores).toHaveLength(2);
    expect(result.needsReview[0]).toBe(false);
    expect(result.needsReview[1]).toBe(false);
    expect(result.scores[1].sections[0].lines).toEqual(['빛으로 인도하시네']);
  });

  it('keeps escalating while a page stays in doubt, one challenger per round', async () => {
    // Models reading a genuinely different sentence never vote, so the page
    // cannot settle and every challenger gets its turn before it is handed to
    // the user for review.
    const fakeProvider = fakeProviderFor((attempt) =>
      attempt.model === CHAMPIONS[0].model ? AGREED : DISAGREED,
    );

    await recognizeAdaptiveBatch(['page-0'], settings, 'full', undefined, [], fakeProvider.provider);

    // Every challenger gets a turn, each with only the page in question.
    expect(fakeProvider.challengerPageIndexes).toEqual(CHALLENGERS.map(() => [0]));
  });

  it('stops calling a model whose free daily allowance ran out', async () => {
    const spent = new RecognitionError('free-models-per-day limit reached', 429);
    const fakeProvider = fakeProviderFor((attempt) => {
      if (attempt.model === CHALLENGERS[0].model) return spent;
      // Keep the page unsettled so every challenger would otherwise be tried.
      return attempt.model === CHAMPIONS[0].model ? AGREED : DISAGREED;
    });

    const result = await recognizeAdaptiveBatch(
      ['page-0'],
      settings,
      'full',
      undefined,
      [],
      fakeProvider.provider,
    );

    expect(result.exhaustedModels).toEqual([modelKeyFor(CHALLENGERS[0])]);
    // Called once, then never again this job — a spent daily quota does not
    // recover, so retrying it would only waste a round.
    expect(fakeProvider.calls.filter((call) => call.attempt.model === CHALLENGERS[0].model)).toHaveLength(1);
  });

  it('keeps results aligned to the original page order after an escalation', async () => {
    const pageOne = verse(['첫째 페이지 가사']);
    const pageThree = verse(['셋째 페이지 가사']);
    const fakeProvider = fakeProviderFor((attempt, image) => {
      if (image === 'page-0') return pageOne;
      if (image === 'page-2') return pageThree;
      return attempt.model === CHAMPIONS[0].model ? AGREED : DISAGREED;
    });

    const result = await recognizeAdaptiveBatch(
      ['page-0', 'page-1', 'page-2'],
      settings,
      'full',
      undefined,
      [],
      fakeProvider.provider,
    );

    expect(result.scores[0].sections[0].lines).toEqual(['첫째 페이지 가사']);
    expect(result.scores[2].sections[0].lines).toEqual(['셋째 페이지 가사']);
    expect(fakeProvider.challengerPageIndexes.every((pages) => pages.every((page) => page === 1))).toBe(true);
  });

  it('passes each page its own title hint through an escalation', async () => {
    const hints = ['첫째 곡', '둘째 곡'];
    const seen: (string | undefined)[][] = [];
    const provider: BatchProvider = async (attempt, dataUrls, _settings, _mode, pageHints) => {
      seen.push(pageHints ?? []);
      return {
        attempt,
        scores: dataUrls.map((image) =>
          image === 'page-0' ? AGREED : attempt.model === CHAMPIONS[0].model ? AGREED : DISAGREED,
        ),
        latencyMs: 5,
      };
    };

    await recognizeAdaptiveBatch(['page-0', 'page-1'], settings, 'full', hints, [], provider);

    expect(seen[0]).toEqual(hints);
    // The escalation only carries the uncertain page — and its hint.
    expect(seen[seen.length - 1]).toEqual(['둘째 곡']);
  });

  it('throws when no model read any page, so the caller can fall back', async () => {
    const provider: BatchProvider = async (attempt) => ({ attempt, error: 'server', latencyMs: 5 });
    await expect(
      recognizeAdaptiveBatch(['page-0'], settings, 'full', undefined, [], provider),
    ).rejects.toThrow('모든 인식 엔진이 실패했습니다.');
  });

  it('returns an empty result for an empty batch without calling anything', async () => {
    const fakeProvider = fakeProviderFor(() => AGREED);
    const result = await recognizeAdaptiveBatch([], settings, 'full', undefined, [], fakeProvider.provider);
    expect(result.scores).toEqual([]);
    expect(fakeProvider.calls).toEqual([]);
  });
});
