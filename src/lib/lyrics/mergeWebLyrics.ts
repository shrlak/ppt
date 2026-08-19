// Reconcile what the models read off the 악보 with what the song's published
// lyrics say.
//
// The two sources know different things, and the merge keeps each one doing
// what it is good at:
//
//   · The score decides the SHAPE — which parts are sung, what they are
//     labeled, and the 진행 순서 that repeats them. Only the conti knows that,
//     and a published lyric page never does.
//   · The web decides the WORDS — a page of type beats OCR of small lyric
//     type under a staff, and it comes already spelled correctly. A published
//     line therefore goes in exactly as the page printed it; only the
//     recognized lines that the page has no counterpart for are normalized.
//
// So a recognized part keeps its label and its place in the order, and gets
// the published wording when the two are clearly the same part. A part the
// score never read is only added when 진행 순서 asks for it, because a page
// printing extra verses is not a reason to sing them.
import type { ParsedScore } from '../ai/scoreParser';
import type { Section } from '../utils/types';
import { normalizeRecognizedLyricLines } from './koreanSpelling';
import { lineSimilarity, sectionSimilarity } from './textSimilarity';
import type { LyricsSourceLink, ScoredLyricsCandidate } from './webLyrics';

/**
 * How alike a recognized part and a published part must read before the
 * published wording replaces the recognized wording. Deliberately lower than
 * the model-vs-model threshold: OCR of a whole verse drifts further from the
 * truth than two models drift from each other, and the title match already
 * established that this is the right song.
 */
const SAME_PART_THRESHOLD = 0.45;

/** Two lines must look like the same line before the published one wins. */
const SAME_LINE_THRESHOLD = 0.6;

/**
 * How far ahead in the published part to look for a recognized line's match.
 * A small window keeps the alignment monotonic: a line the page also prints
 * later (a repeated hook) must not drag the cursor past everything between.
 */
const ALIGN_LOOKAHEAD = 3;

/**
 * What the editor is showing the user about the web lookup for one song.
 *
 * 'auto'   — a candidate was strong and clearly ahead; it has been applied.
 * 'review' — several plausible pages; the user picks, or picks none.
 * 'none'   — nothing on the web was usable; the score's reading stands.
 */
export type WebReviewDecision = 'auto' | 'review' | 'none';

export interface WebReviewState {
  candidates: ScoredLyricsCandidate[];
  /** The candidate the user chose, if any. */
  selectedId?: string;
  decision: WebReviewDecision;
  /** Search hits this deployment may not read, offered as plain links. */
  links?: LyricsSourceLink[];
}

export interface WebLyricsMerge {
  score: ParsedScore;
  /** 'filled' — the web supplied lyrics the score had none of.
   *  'corrected' — the score's parts kept their shape, with published wording.
   *  'unused' — nothing on the page matched; the score's reading stands. */
  outcome: 'filled' | 'corrected' | 'unused';
  /** Parts whose text the published version replaced. */
  correctedParts: number;
}

/**
 * Cross-reference one recognized part against the published one, line by line.
 *
 * Swapping the whole part for the published text is too blunt: a page can
 * print an arrangement this score does not use, and the score is what is
 * actually being sung. So each recognized line is matched against the
 * published lines in order, and a published line only replaces a recognized
 * one when the two read as the same line — a spelling correction, not a
 * substitution. A recognized line the page has no counterpart for is kept
 * exactly as the models read it.
 *
 * Published lines left over after the last match are appended, but only once
 * enough of the part has matched to be sure it is the same part: dropping the
 * final line or two is a routine OCR failure, and that tail is the single
 * most common thing missing from a recognized part.
 */
export function crossReferenceLines(
  recognized: string[],
  published: string[],
): { lines: string[]; corrected: number } {
  const lines: string[] = [];
  let cursor = 0;
  let matched = 0;
  let corrected = 0;

  for (const line of recognized) {
    let bestIndex = -1;
    let bestScore = 0;
    for (let index = cursor; index < Math.min(published.length, cursor + ALIGN_LOOKAHEAD); index += 1) {
      const score = lineSimilarity(line, published[index]);
      if (score > bestScore) {
        bestScore = score;
        bestIndex = index;
      }
    }
    if (bestIndex === -1 || bestScore < SAME_LINE_THRESHOLD) {
      // Nothing on the page reads like this line — the score keeps its own.
      lines.push(line);
      continue;
    }
    matched += 1;
    if (published[bestIndex] !== line) corrected += 1;
    lines.push(published[bestIndex]);
    cursor = bestIndex + 1;
  }

  // Only a part that genuinely lined up may contribute a tail, so an
  // incidental single-line match can't append a stranger's verse.
  const tail = published.slice(cursor);
  if (tail.length > 0 && matched >= 2 && matched >= recognized.length / 2) {
    lines.push(...tail);
    corrected += tail.length;
  }

  return { lines, corrected };
}

/** Pair each recognized part with the published part that reads like it. A
 * published part is claimed at most once, best match first, so two similar
 * verses can't both collapse onto the same one. */
function pairParts(recognized: Section[], published: Section[]): Map<number, number> {
  const pairs: { score: number; recognizedIndex: number; publishedIndex: number }[] = [];
  recognized.forEach((part, recognizedIndex) => {
    published.forEach((candidate, publishedIndex) => {
      const score = sectionSimilarity(part, candidate);
      if (score >= SAME_PART_THRESHOLD) pairs.push({ score, recognizedIndex, publishedIndex });
    });
  });
  pairs.sort((a, b) => b.score - a.score);

  const chosen = new Map<number, number>();
  const takenPublished = new Set<number>();
  for (const pair of pairs) {
    if (chosen.has(pair.recognizedIndex) || takenPublished.has(pair.publishedIndex)) continue;
    chosen.set(pair.recognizedIndex, pair.publishedIndex);
    takenPublished.add(pair.publishedIndex);
  }
  return chosen;
}

/**
 * Merge a web lookup into a recognized score.
 *
 * Never mutates its inputs. Always safe to call: with no lookup result, or
 * one that matches nothing, the score comes back unchanged apart from having
 * its own reading normalized to 한국어 띄어쓰기·맞춤법.
 */
export function mergeWebLyrics(score: ParsedScore, web: ScoredLyricsCandidate | null): WebLyricsMerge {
  // The recognized reading gets its 띄어쓰기·맞춤법 pass either way, web hit or
  // not — a score's spacing follows its noteheads, so it always needs one.
  // This whole path only runs for songs that are new to the library.
  const normalized: Section[] = score.sections.map((section) => ({
    label: section.label,
    lines: normalizeRecognizedLyricLines(section.lines),
  }));

  if (!web || web.sections.length === 0) {
    return { score: { ...score, sections: normalized }, outcome: 'unused', correctedParts: 0 };
  }

  // Nothing was read off the score: the published lyrics are all we have, so
  // they supply both the parts and (failing a printed one) the order.
  if (normalized.length === 0) {
    const sections = web.sections.map((section) => ({ label: section.label, lines: [...section.lines] }));
    return {
      score: {
        ...score,
        sections,
        order: score.order.length > 0 ? [...score.order] : [...web.order],
      },
      outcome: 'filled',
      correctedParts: sections.length,
    };
  }

  const pairs = pairParts(normalized, web.sections);
  let correctedParts = 0;
  const sections = normalized.map((section, index) => {
    const publishedIndex = pairs.get(index);
    if (publishedIndex === undefined) return section;
    const published = web.sections[publishedIndex];
    const { lines, corrected } = crossReferenceLines(section.lines, published.lines);
    if (corrected === 0) return section;
    correctedParts += 1;
    // The score's label and position are kept; only the words change.
    return { label: section.label, lines };
  });

  // A part the 진행 순서 calls for but no model managed to read is a real gap
  // in the deck — fill it from the published lyrics when one is left over.
  const present = new Set(sections.map((section) => section.label.toUpperCase()));
  const leftovers = web.sections.filter((_, index) => ![...pairs.values()].includes(index));
  for (const token of score.order) {
    const label = token.toUpperCase();
    if (label === 'I' || present.has(label)) continue;
    const match = leftovers.find((section) => section.label.toUpperCase() === label);
    if (!match) continue;
    sections.push({ label: match.label, lines: [...match.lines] });
    present.add(label);
    correctedParts += 1;
  }

  return {
    score: { ...score, sections },
    outcome: correctedParts > 0 ? 'corrected' : 'unused',
    correctedParts,
  };
}

/**
 * Apply a candidate only when it has earned the right to be applied.
 *
 * An 'auto' candidate is one the scorer found both strong and clearly ahead of
 * the alternatives, so it fills in on its own. Anything else waits for the
 * user to pick it by ID: a candidate that merely looks plausible must never
 * rewrite a conti's lyrics behind the user's back, because the failure mode is
 * silently substituting a different song with the same title.
 */
export function mergeRankedWebLyrics(
  score: ParsedScore,
  candidate: ScoredLyricsCandidate | null | undefined,
  selectedId?: string,
): WebLyricsMerge {
  if (!candidate) return mergeWebLyrics(score, null);
  const applied = candidate.decision === 'auto' || selectedId === candidate.id;
  return mergeWebLyrics(score, applied ? candidate : null);
}
