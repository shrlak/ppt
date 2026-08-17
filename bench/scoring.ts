// Accuracy scoring for the recognition benchmark: compare a ParsedScore the
// pipeline produced against the ground truth the page was rendered from.
// Pure functions so the math is unit-testable.
import type { ParsedScore } from '../src/lib/ai/scoreParser';
import { lyricsSimilarity, orderSimilarity, textSimilarity } from '../src/lib/ai/recognitionScoring';

export interface TruthSong {
  index: number;
  file: string;
  title: string;
  key: string;
  order: string[];
  sections: { label: string; lines: string[] }[];
}

export interface SongReport {
  index: number;
  title: string;
  titleScore: number;
  orderScore: number;
  lyricsScore: number;
  overall: number;
  error?: string;
}

// The comparison primitives now live in runtime code so the app can score a
// model against a verified user correction with exactly the same math the
// benchmark uses. They are re-exported here so benchmark imports keep working.
export {
  levenshtein,
  lyricsSimilarity,
  normalizeText,
  orderSimilarity,
  textSimilarity,
} from '../src/lib/ai/recognitionScoring';

export function scoreSong(parsed: ParsedScore | undefined, truth: TruthSong, error?: string): SongReport {
  if (!parsed) {
    return {
      index: truth.index,
      title: truth.title,
      titleScore: 0,
      orderScore: 0,
      lyricsScore: 0,
      overall: 0,
      error: error ?? 'no result',
    };
  }
  const titleScore = textSimilarity(parsed.title ?? '', truth.title);
  const orderScore = orderSimilarity(parsed.order, truth.order);
  const lyricsScore = lyricsSimilarity(parsed, truth);
  const overall = 0.2 * titleScore + 0.1 * orderScore + 0.7 * lyricsScore;
  return { index: truth.index, title: truth.title, titleScore, orderScore, lyricsScore, overall, error };
}

export interface BenchSummary {
  /** Songs the models actually answered — the population every mean is over. */
  songs: number;
  /** Songs whose provider call failed outright (quota, retired model, 5xx). */
  failed: number;
  meanOverall: number;
  meanTitle: number;
  meanOrder: number;
  meanLyrics: number;
  perfectTitles: number;
  below90: SongReport[];
}

/**
 * Summarize a trial, counting songs the provider never answered separately
 * from songs it answered badly.
 *
 * Averaging a failed call in as 0% makes an exhausted quota look exactly like
 * a catastrophic quality regression: a run where 46 of 50 songs never reached
 * the model reported 17.6% "accuracy", which reads as a broken pipeline rather
 * than a broken trial. Failures are a fact about the run, not about the code
 * under test, so they are reported and never averaged.
 */
export function summarize(reports: SongReport[]): BenchSummary {
  const scored = reports.filter((report) => !report.error);
  const mean = (select: (r: SongReport) => number) =>
    scored.length === 0 ? 0 : scored.reduce((sum, r) => sum + select(r), 0) / scored.length;
  return {
    songs: scored.length,
    failed: reports.length - scored.length,
    meanOverall: mean((r) => r.overall),
    meanTitle: mean((r) => r.titleScore),
    meanOrder: mean((r) => r.orderScore),
    meanLyrics: mean((r) => r.lyricsScore),
    perfectTitles: scored.filter((r) => r.titleScore >= 0.999).length,
    below90: scored.filter((r) => r.overall < 0.9).sort((a, b) => a.overall - b.overall),
  };
}
