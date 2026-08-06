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
//     type under a staff, and it comes already spelled correctly.
//
// So a recognized part keeps its label and its place in the order, and gets
// the published wording when the two are clearly the same part. A part the
// score never read is only added when 진행 순서 asks for it, because a page
// printing extra verses is not a reason to sing them.
import type { ParsedScore } from '../ai/scoreParser';
import type { Section } from '../utils/types';
import { normalizeKoreanLyricLines } from './koreanSpelling';
import { sectionSimilarity } from './textSimilarity';
import type { WebLyrics } from './webLyrics';

/**
 * How alike a recognized part and a published part must read before the
 * published wording replaces the recognized wording. Deliberately lower than
 * the model-vs-model threshold: OCR of a whole verse drifts further from the
 * truth than two models drift from each other, and the title match already
 * established that this is the right song.
 */
const SAME_PART_THRESHOLD = 0.45;

export interface WebLyricsMerge {
  score: ParsedScore;
  /** 'filled' — the web supplied lyrics the score had none of.
   *  'corrected' — the score's parts kept their shape, with published wording.
   *  'unused' — nothing on the page matched; the score's reading stands. */
  outcome: 'filled' | 'corrected' | 'unused';
  /** Parts whose text the published version replaced. */
  correctedParts: number;
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
 * its lyrics normalized to 한국어 맞춤법.
 */
export function mergeWebLyrics(score: ParsedScore, web: WebLyrics | null): WebLyricsMerge {
  // The recognized reading is normalized either way — this whole path only
  // runs for songs that are new to the library.
  const normalized: Section[] = score.sections.map((section) => ({
    label: section.label,
    lines: normalizeKoreanLyricLines(section.lines),
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
    if (published.lines.join('\n') === section.lines.join('\n')) return section;
    correctedParts += 1;
    // The score's label and position are kept; only the words change.
    return { label: section.label, lines: [...published.lines] };
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
