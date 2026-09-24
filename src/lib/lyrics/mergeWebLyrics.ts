// Reconcile what the models read off the 악보 with what the song's published
// lyrics say.
//
// The lookup is title-first: once a title is read off the conti, its published
// lyrics are fetched and — when the proxy is sure the page is this song, or the
// user picked it — they become the song's lyrics, split into parts. The two
// sources still each do what they are good at:
//
//   · The score decides the SHAPE — which label each part carries and the
//     진행 순서 that repeats them. Only the conti knows that, and a published
//     lyric page never does.
//   · The web decides the WORDS — a page of type beats OCR of small lyric
//     type under a staff, and it comes already spelled correctly. A published
//     part therefore replaces the recognized part it matches wholesale, exactly
//     as the page printed it; only recognized parts the page has no
//     counterpart for keep the models' (normalized) reading.
//
// Parts the page prints that the score never read are added to the editor too,
// so the whole song is there to work with. They only become slides when the
// 진행 순서 calls for them (see planSlides), because a page printing extra
// verses is not a reason to sing them.
import type { ParsedScore } from '../ai/scoreParser';
import type { Section } from '../utils/types';
import { normalizeRecognizedLyricLines } from './koreanSpelling';
import { lineKey } from './textSimilarity';
import type { LyricsSourceLink, ScoredLyricsCandidate } from './webLyrics';

/**
 * How alike a recognized part and a published part must read to be the same
 * part, as character-pair overlap. Pairs rather than single characters or
 * words: a score's spacing follows its noteheads, so its words never line up
 * with the page's, and single syllables are shared by every part of a song.
 */
const SAME_PART_THRESHOLD = 0.3;

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
   *  'corrected' — the score's parts kept their labels, with published wording.
   *  'unused' — no candidate was applied; the score's reading stands. */
  outcome: 'filled' | 'corrected' | 'unused';
  /** Parts whose text came from the published version. */
  correctedParts: number;
}

function pairCounts(section: Section): Map<string, number> {
  const text = section.lines.map(lineKey).join('');
  const counts = new Map<string, number>();
  for (let index = 0; index < text.length - 1; index += 1) {
    const pair = text.slice(index, index + 2);
    counts.set(pair, (counts.get(pair) ?? 0) + 1);
  }
  return counts;
}

/** Character-pair overlap (Dice, 0–1) of two parts. */
export function partSimilarity(a: Section, b: Section): number {
  const left = pairCounts(a);
  const right = pairCounts(b);
  let shared = 0;
  for (const [pair, count] of left) shared += Math.min(count, right.get(pair) ?? 0);
  const total = [...left.values(), ...right.values()].reduce((sum, n) => sum + n, 0);
  return total === 0 ? 0 : (2 * shared) / total;
}

/** "V1" and "V" name the same part. */
function canonicalLabel(label: string): string {
  return label.trim().toUpperCase().replace(/^([A-Z]+)1$/, '$1');
}

/**
 * Pair each recognized part with the published part that reads like it.
 *
 * Best match first, and a published part is claimed at most once, so two
 * similar verses can't both collapse onto the same one. A part whose OCR was
 * too poor to match by text then falls back to the published part carrying
 * the same label — the page and the score both number verses in order.
 */
function pairParts(recognized: Section[], published: Section[]): Map<number, number> {
  const pairs: { score: number; recognizedIndex: number; publishedIndex: number }[] = [];
  recognized.forEach((part, recognizedIndex) => {
    published.forEach((candidate, publishedIndex) => {
      const score = partSimilarity(part, candidate);
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

  recognized.forEach((part, recognizedIndex) => {
    if (chosen.has(recognizedIndex)) return;
    const publishedIndex = published.findIndex(
      (candidate, index) =>
        !takenPublished.has(index) && canonicalLabel(candidate.label) === canonicalLabel(part.label),
    );
    if (publishedIndex === -1) return;
    chosen.set(recognizedIndex, publishedIndex);
    takenPublished.add(publishedIndex);
  });
  return chosen;
}

/** A label of the same family that no section uses yet (C taken → C2). */
function freeLabel(label: string, used: Set<string>): string {
  if (!used.has(canonicalLabel(label))) return label;
  const family = canonicalLabel(label).replace(/\d+$/, '');
  let n = 2;
  while (used.has(`${family}${n}`)) n += 1;
  return `${family}${n}`;
}

/**
 * Merge a web lookup into a recognized score.
 *
 * Never mutates its inputs. Always safe to call: with no lookup result the
 * score comes back unchanged apart from having its own reading normalized to
 * 한국어 띄어쓰기·맞춤법.
 */
export function mergeWebLyrics(score: ParsedScore, web: ScoredLyricsCandidate | null): WebLyricsMerge {
  // The recognized reading gets its 띄어쓰기·맞춤법 pass either way, web hit or
  // not — a score's spacing follows its noteheads, so it always needs one.
  // This whole path only runs for songs that are new to the library.
  const normalized: Section[] = score.sections
    .map((section) => ({ label: section.label, lines: normalizeRecognizedLyricLines(section.lines) }))
    .filter((section) => section.lines.length > 0);

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
    correctedParts += 1;
    // The score's label and position are kept; the words are the page's.
    return { label: section.label, lines: [...web.sections[publishedIndex].lines] };
  });

  // Everything else the page prints goes into the editor as well, under a
  // label no recognized part already uses.
  const used = new Set(sections.map((section) => canonicalLabel(section.label)));
  const claimed = new Set(pairs.values());
  web.sections.forEach((section, index) => {
    if (claimed.has(index)) return;
    const label = freeLabel(section.label, used);
    used.add(canonicalLabel(label));
    sections.push({ label, lines: [...section.lines] });
    correctedParts += 1;
  });

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
