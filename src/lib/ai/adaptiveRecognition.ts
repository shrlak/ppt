// Decide WHICH models read a page, not just how their answers are combined.
//
// Running every model on every page was simple but wasteful in the one
// currency that actually constrains this app: free daily quota. Most pages are
// read the same way by every model, and on those pages the extra calls buy
// nothing. So three champions read every page, and only a page they disagreed
// on is escalated — one challenger at a time, and only that page's image.
//
// The saved quota is what makes cross-checking affordable on the pages that
// need it.
import type { AiSettings, RecognitionAttempt, RecognitionEngine, RecognitionModelInfo } from './aiSettings';
import { RECOGNITION_MODEL_CATALOG, findModelInfo } from './aiSettings';
import {
  CHAMPION_SLOTS,
  MIN_CHAMPION_SAMPLES,
  modelKeyFor,
  rankModels,
  type ModelReliability,
  type RankedModel,
} from './modelReliability';
import { isExhaustedForToday, type RecognitionObservation } from './recognitionObservation';
import type { PromptExample } from './scoreNvidia';
import type { BatchRecognitionMode, ParsedScore } from './scoreParser';
import {
  runBatchAttempt,
  type BatchAttemptResult,
  type BatchRecognitionResult,
} from './scoreRecognition';
import { buildWeightedConsensus } from './weightedConsensus';

/** Runs one model over one set of images. Injectable so tests can spy on it. */
export type BatchProvider = (
  attempt: RecognitionAttempt,
  dataUrls: string[],
  settings: AiSettings,
  mode: BatchRecognitionMode,
  hints?: (string | undefined)[],
  examples?: PromptExample[],
) => Promise<BatchAttemptResult>;

export interface AdaptivePlan {
  /** Read every page. */
  champions: RecognitionAttempt[];
  /** Escalated to, highest-ranked first, only for pages still in doubt. */
  challengers: RecognitionAttempt[];
}

/**
 * Split the configured pool into champions and challengers.
 *
 * Measured accuracy decides once a model has enough verified evaluations
 * behind it; below that the catalog's declared role stands, because a handful
 * of pages cannot tell a strong model from a lucky one. Paused models and ones
 * whose free daily allowance is gone are left out of both lists — calling them
 * again this run cannot succeed.
 */
export function planAdaptiveAttempts(
  catalog: RecognitionModelInfo[],
  rankings: RankedModel[],
  unavailable: ReadonlySet<string> = new Set(),
  pageConfidence: boolean[] = [],
): AdaptivePlan {
  const available = rankings.filter(
    (entry) => !entry.paused && !unavailable.has(entry.modelKey) && catalog.some((c) => c.model === entry.model),
  );

  const measured = available.filter((entry) => entry.samples >= MIN_CHAMPION_SAMPLES);
  // Enough of the pool has been measured to rank it; otherwise fall back to
  // the catalog's own champion/challenger split.
  const champions =
    measured.length >= CHAMPION_SLOTS
      ? measured.slice(0, CHAMPION_SLOTS)
      : available.filter((entry) => entry.catalogRole === 'champion').slice(0, CHAMPION_SLOTS);

  const championKeys = new Set(champions.map((entry) => entry.modelKey));
  const challengers = available.filter((entry) => !championKeys.has(entry.modelKey));

  const attempt = (entry: RankedModel): RecognitionAttempt => ({ engine: entry.engine, model: entry.model });
  return {
    champions: champions.map(attempt),
    // Nothing left in doubt means nothing to escalate.
    challengers:
      pageConfidence.length > 0 && pageConfidence.every((needsReview) => !needsReview)
        ? []
        : challengers.map(attempt),
  };
}

/** The pool the administrator configured, in catalog form. */
function configuredCatalog(settings: AiSettings): RecognitionModelInfo[] {
  return settings.attempts
    .map((attempt) => findModelInfo(attempt))
    .filter((entry): entry is RecognitionModelInfo => !!entry);
}

/** Turn one model's batch answers into per-page observations. */
function observationsFrom(result: BatchAttemptResult, pageIndexes: number[]): Map<number, RecognitionObservation> {
  const byPage = new Map<number, RecognitionObservation>();
  pageIndexes.forEach((page, position) => {
    const score = result.scores?.[position];
    byPage.set(page, {
      attempt: result.attempt,
      score: score && hasContent(score) ? score : undefined,
      error: result.scores ? (score && hasContent(score) ? undefined : 'format') : result.error,
      latencyMs: result.latencyMs,
    });
  });
  return byPage;
}

/** True when the answer carries something the caller can use. */
function hasContent(score: ParsedScore): boolean {
  if (score.pageType === 'non_score') return true;
  return (
    !!score.sermonTitle ||
    !!score.scripture ||
    !!score.title ||
    !!score.key ||
    score.order.length > 0 ||
    score.sections.length > 0
  );
}

export interface AdaptiveRecognitionResult extends BatchRecognitionResult {
  /** Models whose free daily allowance ran out during this job. */
  exhaustedModels: string[];
}

/**
 * Recognize a batch in stages: champions on every page, then challengers on
 * only the pages still in doubt.
 *
 * Each escalation re-runs consensus for those pages alone and stops as soon as
 * they settle, so a conti where one page is hard costs one extra call rather
 * than a second full pass.
 */
export async function recognizeAdaptiveBatch(
  dataUrls: string[],
  settings: AiSettings,
  mode: BatchRecognitionMode,
  hints?: (string | undefined)[],
  reliabilities: ModelReliability[] = [],
  provider: BatchProvider = runBatchAttempt,
  /** Past corrections shown to every model, so it can avoid repeating them. */
  examples: PromptExample[] = [],
): Promise<AdaptiveRecognitionResult> {
  if (dataUrls.length === 0) {
    return {
      scores: [],
      engine: settings.attempts[0]?.engine ?? 'off',
      observations: [],
      confidence: [],
      needsReview: [],
      exhaustedModels: [],
    };
  }

  const catalog = configuredCatalog(settings);
  if (catalog.length === 0) throw new Error('자동 인식이 꺼져 있습니다.');
  const rankings = rankModels(catalog.length > 0 ? catalog : RECOGNITION_MODEL_CATALOG, reliabilities);

  const unavailable = new Set<string>();
  const allPages = dataUrls.map((_url, index) => index);
  const observations: RecognitionObservation[][] = dataUrls.map(() => []);

  const runRound = async (attempts: RecognitionAttempt[], pages: number[]): Promise<void> => {
    if (attempts.length === 0 || pages.length === 0) return;
    const images = pages.map((page) => dataUrls[page]);
    const pageHints = hints ? pages.map((page) => hints[page]) : undefined;
    const results = await Promise.all(
      attempts.map((attempt) => provider(attempt, images, settings, mode, pageHints, examples)),
    );
    for (const result of results) {
      // A spent daily allowance does not recover within this job, so the model
      // is dropped for the rest of it rather than retried on the next page.
      if (isExhaustedForToday(result.error)) unavailable.add(modelKeyFor(result.attempt));
      for (const [page, observation] of observationsFrom(result, pages)) {
        observations[page].push(observation);
      }
    }
  };

  const plan = planAdaptiveAttempts(catalog, rankings, unavailable);
  if (plan.champions.length === 0) throw new Error('사용할 수 있는 인식 모델이 없습니다.');
  await runRound(plan.champions, allPages);

  let consensus = observations.map((page) => buildWeightedConsensus(page, reliabilities));

  // Escalate one challenger at a time: each is a real free-quota request, and
  // a single extra reading usually settles the page.
  const escalation = planAdaptiveAttempts(
    catalog,
    rankings,
    unavailable,
    consensus.map((result) => result.needsReview),
  );
  for (const challenger of escalation.challengers) {
    const uncertain = consensus
      .map((result, page) => (result.needsReview ? page : -1))
      .filter((page) => page >= 0);
    if (uncertain.length === 0) break;
    if (unavailable.has(modelKeyFor(challenger))) continue;
    await runRound([challenger], uncertain);
    for (const page of uncertain) {
      consensus[page] = buildWeightedConsensus(observations[page], reliabilities);
    }
  }

  const contributions = new Map<string, number>();
  for (const result of consensus) {
    for (const modelKey of result.usedModels) {
      contributions.set(modelKey, (contributions.get(modelKey) ?? 0) + 1);
    }
  }
  const leadKey = [...contributions.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  const engine: RecognitionEngine =
    catalog.find((entry) => modelKeyFor(entry) === leadKey)?.engine ?? catalog[0]?.engine ?? 'off';

  if (observations.every((page) => page.every((observation) => !observation.score))) {
    throw new Error('모든 인식 엔진이 실패했습니다.');
  }

  return {
    scores: consensus.map((result) => result.score),
    engine,
    observations,
    confidence: consensus.map((result) => result.confidence),
    needsReview: consensus.map((result) => result.needsReview),
    exhaustedModels: [...unavailable],
  };
}
