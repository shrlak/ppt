// A small text model, trained by hand from the exported corpus, that fixes the
// mistakes consensus keeps making.
//
// Consensus can only choose between what the vision models said. When all of
// them misread the same syllable — which is exactly what happens on the hard
// pages — there is nothing to choose from. A model trained on this
// deployment's own verified corrections has seen those pages and can propose
// the fix, so it runs after consensus and before the web lookup.
//
// It is optional in every direction. There is no model until an administrator
// trains and uploads one; a page is only corrected when the output survives
// every guard below; and with no artifact the runtime is never even
// downloaded. The failure mode this guards against is a model that quietly
// rewrites lyrics nobody checked, so each guard fails closed.
import { lineSimilarity } from '../lyrics/textSimilarity';
import { normalizeText } from '../ai/recognitionScoring';
import { parseScoreText, type ParsedScore } from '../ai/scoreParser';
import type { RecognitionObservation } from '../ai/recognitionObservation';

/** Overall improvement an artifact must show before it may be used at all. */
export const MIN_OVERALL_GAIN = 0.01;

/** A corrected line must still read as the same line. */
export const MIN_LINE_SIMILARITY = 0.6;

/** How much longer the corrected lyrics may get before it looks like invention. */
export const MAX_LENGTH_GROWTH = 0.2;

/** Title confidence above which a different title is a rejection, not a fix. */
export const TITLE_CONFIDENCE_FLOOR = 0.9;

/** How long the browser waits for one correction before giving up on it. */
export const CORRECTION_TIMEOUT_MS = 8000;

/** Base models an artifact is allowed to have been trained from. */
export const ALLOWED_BASE_MODELS = ['google/mt5-small', 'google/mt5-base'];

export interface CorrectionModelFile {
  path: string;
  size: number;
  sha256: string;
}

export interface CorrectionModelManifest {
  version: string;
  baseModel: string;
  /** Hash of the corpus it was trained from, so a run is traceable. */
  datasetHash: string;
  samples: number;
  meanOverall: number;
  baselineOverall: number;
  lyricsScore: number;
  baselineLyricsScore: number;
  files: CorrectionModelFile[];
}

/**
 * Is this artifact worth using at all?
 *
 * Two separate gates, because they fail differently. A model that is barely
 * better than doing nothing is not worth an 8-second inference on every page,
 * and a model whose overall score improved while its LYRIC score fell has
 * learned to fix titles by damaging words — the one thing that must never
 * regress, since the words are what end up on the slide.
 */
export function acceptCorrectionManifest(manifest: CorrectionModelManifest): boolean {
  if (!ALLOWED_BASE_MODELS.includes(manifest.baseModel)) return false;
  if (!Number.isFinite(manifest.meanOverall) || !Number.isFinite(manifest.baselineOverall)) return false;
  if (manifest.meanOverall - manifest.baselineOverall < MIN_OVERALL_GAIN) return false;
  if (manifest.lyricsScore < manifest.baselineLyricsScore) return false;
  return manifest.samples > 0 && manifest.files.length > 0;
}

/**
 * The exact text the model is trained on and asked with.
 *
 * Shared between here and the notebook on purpose: a model fine-tuned on one
 * serialization and prompted with another produces confident nonsense, and
 * that is a failure no guard downstream can catch cleanly.
 */
export function serializeCorrectionInput(
  consensus: ParsedScore,
  observations: RecognitionObservation[],
): string {
  const readings = observations
    .filter((observation) => observation.score)
    .map((observation) => ({
      model: `${observation.attempt.engine}:${observation.attempt.model}`,
      title: observation.score?.title ?? '',
      order: observation.score?.order ?? [],
      sections: (observation.score?.sections ?? []).map((section) => ({
        label: section.label,
        lines: section.lines,
      })),
    }));
  return JSON.stringify({
    task: 'correct-korean-worship-lyrics',
    consensus: {
      title: consensus.title ?? '',
      artist: consensus.artist ?? '',
      key: consensus.key ?? '',
      order: consensus.order,
      sections: consensus.sections.map((section) => ({ label: section.label, lines: section.lines })),
    },
    readings,
  });
}

/** Total lyric characters in a reading, for the growth check. */
function lyricLength(score: ParsedScore): number {
  return score.sections.reduce(
    (sum, section) => sum + section.lines.reduce((lines, line) => lines + normalizeText(line).length, 0),
    0,
  );
}

export interface CorrectionContext {
  /** Consensus confidence in the title, so a retitle can be judged. */
  titleConfidence?: number;
}

/**
 * Would accepting this correction be safe?
 *
 * Every rule here exists because the alternative is silently wrong lyrics on a
 * slide: a dropped part, an invented verse, a different song's title, or a
 * line rewritten past recognition. Anything that trips a rule falls back to
 * consensus, which is at least an answer several models agreed on.
 */
export function validateCorrection(
  corrected: ParsedScore | null | undefined,
  baseline: ParsedScore,
  context: CorrectionContext = {},
): boolean {
  if (!corrected) return false;
  if (corrected.sections.length === 0) return false;
  // Losing a part loses a slide; the model may fix words, not the running order.
  if (corrected.sections.length < baseline.sections.length) return false;

  const retitled =
    !!baseline.title && !!corrected.title && normalizeText(corrected.title) !== normalizeText(baseline.title);
  if (retitled && (context.titleConfidence ?? 0) >= TITLE_CONFIDENCE_FLOOR) return false;

  const baseLength = lyricLength(baseline);
  if (baseLength > 0 && lyricLength(corrected) > baseLength * (1 + MAX_LENGTH_GROWTH)) return false;

  for (const [index, section] of baseline.sections.entries()) {
    const after = corrected.sections[index];
    if (!after) return false;
    if (after.lines.length < section.lines.length) return false;
    for (const [line, text] of section.lines.entries()) {
      const replacement = after.lines[line];
      if (replacement === undefined) return false;
      if (lineSimilarity(text, replacement) < MIN_LINE_SIMILARITY) return false;
    }
  }
  return true;
}

/** Turns one serialized input into the model's raw answer. */
export type CorrectionRunner = (input: string) => Promise<string>;

/**
 * Run the correction model over one page's consensus, or leave it alone.
 *
 * Returns the consensus unchanged for every failure — no model, a timeout,
 * unparseable output, or output that fails validateCorrection. That is the
 * point: this is an optimization on top of an answer that already works, and
 * it must never be able to make things worse.
 */
export async function correctConsensus(
  consensus: ParsedScore,
  observations: RecognitionObservation[],
  runner: CorrectionRunner | null | undefined,
  context: CorrectionContext = {},
): Promise<ParsedScore> {
  if (!runner) return consensus;
  try {
    const answer = await withTimeout(runner(serializeCorrectionInput(consensus, observations)));
    if (!answer) return consensus;
    const corrected = parseScoreText(answer);
    if (!validateCorrection(corrected, consensus, context)) return consensus;
    // Structure and printed order come from the score, never from the model.
    return { ...consensus, title: corrected.title ?? consensus.title, sections: corrected.sections };
  } catch {
    return consensus;
  }
}

function withTimeout(promise: Promise<string>): Promise<string> {
  return Promise.race([
    promise,
    new Promise<string>((_resolve, reject) =>
      setTimeout(() => reject(new Error('correction model timed out')), CORRECTION_TIMEOUT_MS),
    ),
  ]);
}

/**
 * Load the browser runtime, but only when there is something to run.
 *
 * The dynamic import is what keeps this free for everyone who has not trained
 * a model: with no active manifest the transformers runtime is never fetched,
 * so the deployment pays nothing for a feature it is not using.
 */
export async function loadCorrectionModel(
  manifest: CorrectionModelManifest | null,
  modelBaseUrl: string | undefined,
): Promise<CorrectionRunner | null> {
  if (!manifest || !modelBaseUrl || !acceptCorrectionManifest(manifest)) return null;
  try {
    // A plain dynamic import so the bundler splits it into its own chunk:
    // nothing is fetched until this line actually runs, and it only runs when
    // the proxy reports an active artifact.
    const transformers = (await import('@huggingface/transformers')) as unknown as {
      env: { allowLocalModels: boolean; remoteHost: string; remotePathTemplate: string };
      pipeline: (task: string, model: string, options?: Record<string, unknown>) => Promise<
        (input: string, options?: Record<string, unknown>) => Promise<{ generated_text?: string }[]>
      >;
    };
    transformers.env.allowLocalModels = false;
    // Files live at <proxy>/learning/correction-model/<version>/resolve/<file>,
    // the same shape the runtime expects from a model host.
    transformers.env.remoteHost = modelBaseUrl;
    transformers.env.remotePathTemplate = '{model}/resolve/';
    const generate = await transformers.pipeline('text2text-generation', manifest.version, {
      dtype: 'q8',
    });
    return async (input: string) => {
      const output = await generate(input, { max_new_tokens: 768 });
      return output?.[0]?.generated_text ?? '';
    };
  } catch {
    // A runtime that will not load is the same as no model at all.
    return null;
  }
}
