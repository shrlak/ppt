// How closely one reading of a score matches another.
//
// These were written for the offline benchmark, where a model's answer is
// compared against a hand-checked truth file. The adaptive pipeline needs the
// exact same measurements at runtime — a verified user correction is truth in
// precisely the same sense — so they live here and bench/scoring.ts re-exports
// them. Keeping one implementation is what makes a benchmark number and a
// production reliability number comparable at all.
import type { Section } from '../utils/types';

/** Case/space/punctuation-insensitive form for comparing Korean text. */
export function normalizeText(text: string): string {
  return text.toLowerCase().replace(/[^0-9a-zㄱ-ㆎ가-힣]+/g, '');
}

/** Levenshtein distance, iterative two-row DP. */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const curr = [i];
    for (let j = 1; j <= b.length; j++) {
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = curr;
  }
  return prev[b.length];
}

/** 0–1 similarity between two texts after normalization (1 - CER). */
export function textSimilarity(a: string, b: string): number {
  const na = normalizeText(a);
  const nb = normalizeText(b);
  if (!na && !nb) return 1;
  const max = Math.max(na.length, nb.length);
  return max === 0 ? 1 : 1 - levenshtein(na, nb) / max;
}

/** Longest-common-subsequence length, for order-token comparison. */
function lcsLength(a: string[], b: string[]): number {
  const dp = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }
  return dp[a.length][b.length];
}

export function orderSimilarity(parsed: string[], truth: string[]): number {
  if (truth.length === 0) return parsed.length === 0 ? 1 : 0;
  const lcs = lcsLength(
    parsed.map((token) => token.toUpperCase()),
    truth.map((token) => token.toUpperCase()),
  );
  return lcs / Math.max(parsed.length, truth.length);
}

/**
 * Match a truth label to the parsed sections the same way the app's slide
 * planner resolves order tokens (findSection): exact match first, then V→V1
 * for digitless labels, then V2→V when the exact suffixed label is absent.
 */
function aliasedLookup(parsedByLabel: Map<string, string>, label: string): string {
  const want = label.trim().toUpperCase();
  const exact = parsedByLabel.get(want);
  if (exact !== undefined) return exact;
  if (!/\d/.test(want)) return parsedByLabel.get(`${want}1`) ?? '';
  return parsedByLabel.get(want.replace(/\d+$/, '')) ?? '';
}

/** Anything with labeled lyric sections: a ParsedScore, a truth song, a Song. */
export interface SectionedLyrics {
  sections: Section[];
}

/**
 * Lyrics accuracy: for every truth section, find the parsed section with the
 * same label (aliased like the app: V↔V1, C2→C) and compare full text;
 * sections the model mislabeled still earn credit through a whole-song text
 * comparison, so the score reflects "how much of the printed lyrics came back
 * correctly, attached to the right part".
 */
export function lyricsSimilarity(parsed: SectionedLyrics, truth: SectionedLyrics): number {
  const parsedByLabel = new Map<string, string>();
  for (const section of parsed.sections) {
    const key = section.label.trim().toUpperCase();
    parsedByLabel.set(key, [parsedByLabel.get(key) ?? '', section.lines.join(' ')].join(' ').trim());
  }
  let labelled = 0;
  let weight = 0;
  for (const section of truth.sections) {
    const truthText = section.lines.join(' ');
    const w = normalizeText(truthText).length || 1;
    const candidate = aliasedLookup(parsedByLabel, section.label);
    labelled += textSimilarity(candidate, truthText) * w;
    weight += w;
  }
  const bySection = weight === 0 ? 1 : labelled / weight;

  const allTruth = truth.sections.map((section) => section.lines.join(' ')).join(' ');
  const allParsed = parsed.sections.map((section) => section.lines.join(' ')).join(' ');
  const wholeSong = textSimilarity(allParsed, allTruth);

  // Right words in the right part matters most, but a good transcription with
  // shuffled labels is still worth a lot.
  return 0.7 * bySection + 0.3 * wholeSong;
}
