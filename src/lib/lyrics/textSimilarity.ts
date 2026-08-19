// Comparing two readings of the same lyrics.
//
// Recognition already leans on this to let models outvote each other line by
// line; the web lookup needs the same measure to decide whether a published
// part and a recognized part are the same part. Both live here so the two
// paths judge similarity identically.
import type { Section } from '../utils/types';

/** Comparison key for two readings of the same lyric line. */
export function lineKey(line: string): string {
  return line.replace(/[^0-9a-zㄱ-ㆎ가-힣]/gi, '').toLowerCase();
}

/** Multiset overlap (0–1) of two character/word bags. */
export function bagSimilarity(a: Map<string, number>, b: Map<string, number>): number {
  let shared = 0;
  for (const [item, count] of a) shared += Math.min(count, b.get(item) ?? 0);
  const total = Math.max(
    [...a.values()].reduce((sum, n) => sum + n, 0),
    [...b.values()].reduce((sum, n) => sum + n, 0),
  );
  return total === 0 ? 0 : shared / total;
}

/** Character-bag overlap of two lines, used to tell "the same line, misread"
 * apart from "a line from somewhere else entirely". */
export function lineSimilarity(a: string, b: string): number {
  const bag = (line: string): Map<string, number> => {
    const counts = new Map<string, number>();
    for (const char of lineKey(line)) counts.set(char, (counts.get(char) ?? 0) + 1);
    return counts;
  };
  return bagSimilarity(bag(a), bag(b));
}

/**
 * Are two readings of a song the same lyrics?
 *
 * Compared line by line through lineKey, so spacing, punctuation, case and
 * where the lines were split into parts do not matter — those are the things a
 * printed score and a saved copy legitimately differ on. A different word, a
 * missing line or the verses in another order is a different reading.
 *
 * This is what lets a saved entry stand in for a page: the saved wording may
 * only replace what was recognized once the page is shown to say the same
 * thing. Two empty readings confirm nothing, so they are never equal.
 */
export function sameLyrics(a: Section[], b: Section[]): boolean {
  const flatten = (sections: Section[]) =>
    sections.flatMap((section) => section.lines.map(lineKey)).filter((line) => line.length > 0);
  const left = flatten(a);
  const right = flatten(b);
  return left.length > 0 && left.length === right.length && left.every((line, i) => line === right[i]);
}

/** Word bag of a section list, for comparing two readings of the same lyrics. */
export function wordCounts(sections: Section[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const section of sections) {
    for (const line of section.lines) {
      for (const word of line.toLowerCase().split(/[^0-9a-zㄱ-ㆎ가-힣]+/)) {
        if (word) counts.set(word, (counts.get(word) ?? 0) + 1);
      }
    }
  }
  return counts;
}

/** Order-insensitive similarity of two readings of the same part. */
export function sectionSimilarity(a: Section, b: Section): number {
  return bagSimilarity(wordCounts([a]), wordCounts([b]));
}
