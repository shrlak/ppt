// Combine several models' readings of one page into a single answer, weighting
// each model by how accurate it has actually been on that field.
//
// The old rule was catalog priority: the highest-listed model that answered
// won the page outright, and the others only filled gaps. That throws away the
// most useful signal available — when two independent models read a line the
// same way and a third reads it differently, the agreement is far more likely
// to be what is printed. Weighting by measured per-field accuracy makes that
// vote reflect which models have earned a say.
//
// The safety rule throughout is that agreement may CORRECT a line but never
// SUBSTITUTE one. A candidate reading only votes when it is recognizably the
// same line; a model reading a different sentence is evidence of a problem to
// review, not a replacement.
import type { Section } from '../utils/types';
import { bagSimilarity, lineKey, lineSimilarity, wordCounts } from '../lyrics/textSimilarity';
import { findSection } from '../utils/slidePlanner';
import { compositeAccuracy, modelKeyFor, type ModelReliability } from './modelReliability';
import type { RecognitionObservation } from './recognitionObservation';
import { partFamily, type ParsedScore } from './scoreParser';

/** Two readings must look like the same line before one replaces the other. */
export const SAME_LINE_THRESHOLD = 0.6;

/** Two readings must be the same lyrics before a structural correction is safe. */
export const SAME_LYRICS_THRESHOLD = 0.75;

/**
 * Below this two readings are not the same page at all.
 *
 * Looser than SAME_LYRICS_THRESHOLD on purpose: a model that read only part of
 * the page should still get a vote on its title and 진행 순서, while a model
 * that answered about a different song entirely gets none.
 */
export const SAME_PAGE_THRESHOLD = 0.5;

/** Accuracy assumed for a model with no verified evaluations behind it yet. */
export const NEUTRAL_WEIGHT = 0.5;

/** Below this the title is not settled enough to save without a look. */
export const TITLE_REVIEW_THRESHOLD = 0.9;

/** Below this the wording is not settled enough to save without a look. */
export const LYRICS_REVIEW_THRESHOLD = 0.75;

/** Below this the models are not reading the same shape of song. */
export const STRUCTURE_REVIEW_THRESHOLD = 0.6;

export interface FieldConfidence {
  title: number;
  artist: number;
  order: number;
  lyrics: number;
  /** How much of the weight agreed on the part labels and their line counts. */
  structure: number;
}

export interface ConsensusResult {
  score: ParsedScore;
  /** Overall 0–1 confidence, weighted the same way model accuracy is. */
  confidence: number;
  fieldConfidence: FieldConfidence;
  /** Per-part lyric confidence, so the editor can highlight only what is unsure. */
  sectionConfidence: Record<string, number>;
  /** Model keys whose answer contributed. */
  usedModels: string[];
  needsReview: boolean;
}

type FieldName = 'title' | 'artist' | 'order' | 'lyrics';

/** How much this model's opinion counts on this field. */
function weightFor(
  observation: RecognitionObservation,
  field: FieldName,
  reliabilities: Map<string, ModelReliability>,
): number {
  const reliability = reliabilities.get(modelKeyFor(observation.attempt));
  if (!reliability || reliability.samples <= 0) return NEUTRAL_WEIGHT;
  if (field === 'artist' && reliability.artistSamples <= 0) return NEUTRAL_WEIGHT;
  const value = reliability[field];
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : NEUTRAL_WEIGHT;
}

interface Cluster<T> {
  value: T;
  weight: number;
  supporters: number;
}

/** Group values that mean the same thing and return the heaviest group. */
function vote<T>(
  entries: { value: T; key: string; weight: number }[],
): { winner: Cluster<T> | undefined; confidence: number } {
  const clusters = new Map<string, Cluster<T>>();
  let total = 0;
  for (const entry of entries) {
    total += entry.weight;
    const existing = clusters.get(entry.key);
    if (existing) {
      existing.weight += entry.weight;
      existing.supporters += 1;
    } else {
      clusters.set(entry.key, { value: entry.value, weight: entry.weight, supporters: 1 });
    }
  }
  const winner = [...clusters.values()].sort((a, b) => b.weight - a.weight)[0];
  return { winner, confidence: winner && total > 0 ? winner.weight / total : 0 };
}

const normalizeKey = (value: string | undefined): string =>
  (value ?? '').toLowerCase().replace(/[^0-9a-zㄱ-ㆎ가-힣]+/g, '');

/** The shape of a reading: which parts, in what size, in what printed order. */
function structureSignature(score: ParsedScore): string {
  const parts = score.sections.map((section) => `${section.label.toUpperCase()}:${section.lines.length}`);
  return `${parts.join('|')}#${score.order.map((token) => token.toUpperCase()).join('-')}`;
}

/**
 * Put back lines the leading model stopped short of.
 *
 * Several songs lose their last line or two rather than misreading them. The
 * asymmetry that makes this safe is the same one behind verse splitting: a
 * model that stops early is common, a model that invents an extra printed line
 * is not. Only a candidate whose reading STARTS WITH the leader's may extend
 * it, and only the extra tail is taken, so a fuller but sloppier reading
 * contributes its missing lines without importing its misreadings.
 */
export function adoptTruncatedTails(score: ParsedScore, candidates: ParsedScore[]): ParsedScore {
  if (candidates.length === 0) return score;
  let touched = false;
  const sections = score.sections.map((section) => {
    let best: string[] | undefined;
    for (const candidate of candidates) {
      const other = findSection(candidate.sections, section.label);
      if (!other || other.lines.length <= section.lines.length) continue;
      const continues = section.lines.every(
        (line, index) => lineSimilarity(line, other.lines[index] ?? '') >= SAME_LINE_THRESHOLD,
      );
      if (!continues) continue;
      if (!best || other.lines.length > best.length) best = other.lines;
    }
    if (!best) return section;
    touched = true;
    return { label: section.label, lines: [...section.lines, ...best.slice(section.lines.length)] };
  });
  return touched ? { ...score, sections } : score;
}

/**
 * Put stacked verses back when the leading model merged them.
 *
 * A page that prints 1절 above 2절 under shared staves is the one structure
 * models reliably get wrong: the merged reading is a single V holding both
 * verses. It is never wrong in the other direction — no model invents a 2절
 * that isn't printed — so when another model split the same part family into
 * numbered sections covering the same words, that split is the true reading.
 * Adopting it also has to teach 진행 순서 about the new labels, otherwise the
 * slide planner would never reach the recovered verse.
 */
export function adoptSplitVerses(winner: ParsedScore, candidates: ParsedScore[]): ParsedScore {
  const families = new Map<string, Section[]>();
  for (const section of winner.sections) {
    const family = partFamily(section.label);
    families.set(family, [...(families.get(family) ?? []), section]);
  }

  let result = winner;
  for (const [family, own] of families) {
    if (own.length !== 1) continue; // already split, or absent
    const better = candidates
      .map((candidate) => candidate.sections.filter((section) => partFamily(section.label) === family))
      .filter((split) => split.length > own.length)
      .filter((split) => bagSimilarity(wordCounts(split), wordCounts(own)) >= SAME_LYRICS_THRESHOLD)
      // Prefer the finest split that still reads as the same lyrics.
      .sort((a, b) => b.length - a.length)[0];
    if (!better) continue;
    result = replaceFamily(result, family, better);
  }
  return result;
}

/** Swap a family's single merged section for the split one, in place, and make
 * sure every recovered label is reachable from 진행 순서. */
function replaceFamily(score: ParsedScore, family: string, split: Section[]): ParsedScore {
  const sections: Section[] = [];
  for (const section of score.sections) {
    if (partFamily(section.label) !== family) {
      sections.push(section);
      continue;
    }
    sections.push(...split.map((s) => ({ label: s.label, lines: [...s.lines] })));
  }

  // Only add an order token for a label the printed 진행 순서 cannot already
  // reach. Resolution goes through the slide planner's own V↔V1 aliasing, so a
  // page that printed "V1" already reaches a bare "V" — re-inserting it would
  // put a token in 진행 순서 that the score never had.
  const order = [...score.order];
  const reached = new Set(
    order.map((token) => findSection(sections, token)?.label).filter((label): label is string => !!label),
  );
  const missing = split.map((s) => s.label).filter((label) => !reached.has(label));
  if (missing.length > 0) {
    const anchor = order.findIndex((token) => partFamily(token) === family);
    if (anchor === -1) order.push(...missing);
    else order.splice(anchor + 1, 0, ...missing);
  }
  return { ...score, sections, order };
}

const EMPTY_SCORE: ParsedScore = { order: [], sections: [] };

/** Did both models classify the page as the same kind of page? */
function samePageType(
  leader: RecognitionObservation & { score: ParsedScore },
  candidate: RecognitionObservation & { score: ParsedScore },
): boolean {
  return (
    !leader.score.pageType || !candidate.score.pageType || candidate.score.pageType === leader.score.pageType
  );
}

/** Every lyric character of a reading, as a multiset. */
function characterCounts(sections: Section[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const section of sections) {
    for (const character of lineKey(section.lines.join(''))) {
      counts.set(character, (counts.get(character) ?? 0) + 1);
    }
  }
  return counts;
}

/**
 * Are both models reading the same song, or two different ones?
 *
 * Measured as how much of the SHORTER reading appears in the longer, over
 * characters rather than words. Normalizing by the shorter side is what makes
 * a partial reading — a model that stopped after one line — still count as the
 * same page, which matters because dropping the tail is the single most common
 * recognition failure. Characters rather than words because a one-syllable
 * misread costs a whole word but almost none of the characters.
 */
function readsSamePage(
  leader: RecognitionObservation & { score: ParsedScore },
  candidate: RecognitionObservation & { score: ParsedScore },
): boolean {
  if (leader.score.sections.length === 0 || candidate.score.sections.length === 0) return true;
  const own = characterCounts(leader.score.sections);
  const other = characterCounts(candidate.score.sections);
  let shared = 0;
  for (const [character, count] of own) shared += Math.min(count, other.get(character) ?? 0);
  const total = (counts: Map<string, number>) => [...counts.values()].reduce((sum, n) => sum + n, 0);
  const smaller = Math.min(total(own), total(other));
  return smaller === 0 ? true : shared / smaller >= SAME_PAGE_THRESHOLD;
}

/** First value any candidate supplied, for fields nobody votes on. */
function firstDefined<T>(
  candidates: (RecognitionObservation & { score: ParsedScore })[],
  select: (score: ParsedScore) => T | undefined,
): T | undefined {
  for (const candidate of candidates) {
    const value = select(candidate.score);
    if (value !== undefined && value !== '') return value;
  }
  return undefined;
}

/**
 * Reconcile every model's reading of one page into one answer plus a measure
 * of how settled that answer is.
 *
 * Fields are decided independently, each weighted by that model's accuracy on
 * that field, because the models are not uniformly good: one reads titles well
 * and lyrics poorly, another the reverse. Lyrics are decided line by line
 * inside the structure the weight agreed on.
 */
export function buildWeightedConsensus(
  observations: RecognitionObservation[],
  reliabilities: ModelReliability[] = [],
): ConsensusResult {
  const stats = new Map(reliabilities.map((value) => [value.modelKey, value]));
  const answered = observations.filter(
    (observation): observation is RecognitionObservation & { score: ParsedScore } => !!observation.score,
  );

  if (answered.length === 0) {
    return {
      score: EMPTY_SCORE,
      confidence: 0,
      fieldConfidence: { title: 0, artist: 0, order: 0, lyrics: 0, structure: 0 },
      sectionConfidence: {},
      usedModels: [],
      needsReview: true,
    };
  }

  const usedModels = answered.map((observation) => modelKeyFor(observation.attempt));

  // The LEADER supplies the reading everything else is measured against: the
  // part labels, their order, and the starting wording. It is the model with
  // the best measured lyric accuracy, ties broken by pool order.
  //
  // Deliberately not decided by a structure vote. Models drop trailing lines
  // far more often than they invent them, so the most-agreed structure is
  // systematically the shortest one, and letting it lead would throw away the
  // lines adoptTruncatedTails exists to recover.
  const leader = [...answered].sort(
    (a, b) => weightFor(b, 'lyrics', stats) - weightFor(a, 'lyrics', stats),
  )[0];

  // Two kinds of answer are not votes about this page and are dropped before
  // anything is counted: one that classified the page differently (a sermon
  // page vs a score page), and one whose lyrics are a different song
  // altogether. Either would otherwise be able to outvote the leader on the
  // title or the 진행 순서 while being about something else.
  const compatible = answered.filter(
    (observation) => samePageType(leader, observation) && readsSamePage(leader, observation),
  );
  const others = compatible.filter((observation) => observation !== leader);

  // The wording comes from the heaviest model that actually read lyrics: a
  // leader that only recognized a title still gets its sections filled in,
  // which is what the old gap-fill did.
  const lyricsLeader =
    (leader.score.sections.length > 0
      ? leader
      : [...compatible]
          .filter((observation) => observation.score.sections.length > 0)
          .sort((a, b) => weightFor(b, 'lyrics', stats) - weightFor(a, 'lyrics', stats))[0]) ?? leader;

  const titleVote = vote(
    compatible
      .filter((observation) => observation.score.title)
      .map((observation) => ({
        value: observation.score.title as string,
        key: normalizeKey(observation.score.title),
        weight: weightFor(observation, 'title', stats),
      })),
  );
  const artistVote = vote(
    compatible
      .filter((observation) => observation.score.artist)
      .map((observation) => ({
        value: observation.score.artist as string,
        key: normalizeKey(observation.score.artist),
        weight: weightFor(observation, 'artist', stats),
      })),
  );
  const keyVote = vote(
    compatible
      .filter((observation) => observation.score.key)
      .map((observation) => ({
        value: observation.score.key as string,
        key: normalizeKey(observation.score.key),
        weight: weightFor(observation, 'order', stats),
      })),
  );
  const orderVote = vote(
    compatible
      .filter((observation) => observation.score.order.length > 0)
      .map((observation) => ({
        value: observation.score.order,
        key: observation.score.order.map((token) => token.toUpperCase()).join('-'),
        weight: weightFor(observation, 'order', stats),
      })),
  );

  // Structure agreement does not choose the answer, but it does say how
  // settled the answer is: models reading different shapes of the same page
  // is exactly the case a human should look at.
  const structureVote = vote(
    compatible
      .filter((observation) => observation.score.sections.length > 0)
      .map((observation) => ({
        value: observation.score,
        key: structureSignature(observation.score),
        weight: weightFor(observation, 'lyrics', stats),
      })),
  );

  const { sections, confidence: lyricsConfidence, sectionConfidence } = voteOnLines(
    lyricsLeader,
    compatible.filter((observation) => observation !== lyricsLeader),
    stats,
  );

  const candidateScores = compatible
    .filter((observation) => observation !== lyricsLeader)
    .map((observation) => observation.score);

  let score: ParsedScore = {
    ...leader.score,
    title: titleVote.winner?.value ?? leader.score.title,
    artist: artistVote.winner?.value ?? leader.score.artist,
    key: keyVote.winner?.value ?? leader.score.key,
    order: orderVote.winner?.value ? [...orderVote.winner.value] : [...leader.score.order],
    lyricRowCount: leader.score.lyricRowCount ?? firstDefined(others, (score) => score.lyricRowCount),
    sermonTitle: leader.score.sermonTitle ?? firstDefined(others, (score) => score.sermonTitle),
    scripture: leader.score.scripture ?? firstDefined(others, (score) => score.scripture),
    sections,
  };
  score = adoptTruncatedTails(adoptSplitVerses(score, candidateScores), candidateScores);

  const fieldConfidence: FieldConfidence = {
    title: titleVote.winner ? titleVote.confidence : 0,
    // Nothing to disagree about when no model saw an artist.
    artist: artistVote.winner ? artistVote.confidence : 1,
    order: orderVote.winner ? orderVote.confidence : 0,
    lyrics: lyricsConfidence,
    structure: structureVote.winner ? structureVote.confidence : 0,
  };

  const supporters = structureVote.winner?.supporters ?? 0;
  const needsReview =
    fieldConfidence.title < TITLE_REVIEW_THRESHOLD ||
    fieldConfidence.lyrics < LYRICS_REVIEW_THRESHOLD ||
    supporters < 2 ||
    fieldConfidence.structure < STRUCTURE_REVIEW_THRESHOLD;

  return {
    score,
    confidence: compositeAccuracy({
      title: fieldConfidence.title,
      artist: artistVote.winner ? fieldConfidence.artist : undefined,
      order: fieldConfidence.order,
      lyrics: fieldConfidence.lyrics,
    }),
    fieldConfidence,
    sectionConfidence,
    usedModels,
    needsReview,
  };
}

/**
 * Decide each lyric line by weighted vote inside the leader's structure.
 *
 * Only a candidate section with the same label AND the same number of lines
 * can be compared line for line — anything else is comparing across a shifted
 * part. Within that, a candidate line only votes when it reads as the same
 * line as the leader's; a model reading a different sentence still counts
 * against the confidence, which is what surfaces the page for review.
 */
function voteOnLines(
  leader: RecognitionObservation & { score: ParsedScore },
  others: RecognitionObservation[],
  stats: Map<string, ModelReliability>,
): { sections: Section[]; confidence: number; sectionConfidence: Record<string, number> } {
  let weightedConfidence = 0;
  let lineCount = 0;
  const sectionConfidence: Record<string, number> = {};

  const sections = leader.score.sections.map((section) => {
    const aligned = others
      .map((observation) => ({
        observation,
        section: observation.score ? findSection(observation.score.sections, section.label) : undefined,
      }))
      .filter(
        (entry): entry is { observation: RecognitionObservation; section: Section } =>
          !!entry.section && entry.section.lines.length === section.lines.length,
      );

    let sectionTotal = 0;
    const lines = section.lines.map((line, index) => {
      const leaderWeight = weightFor(leader, 'lyrics', stats);
      const candidates: { value: string; key: string; weight: number }[] = [
        { value: line, key: lineKey(line), weight: leaderWeight },
      ];
      let contradicting = 0;
      for (const entry of aligned) {
        const other = entry.section.lines[index] ?? '';
        const weight = weightFor(entry.observation, 'lyrics', stats);
        // A reading that is not recognizably this line is a disagreement to
        // surface, never a replacement to adopt.
        if (lineSimilarity(other, line) < SAME_LINE_THRESHOLD) {
          contradicting += weight;
          continue;
        }
        candidates.push({ value: other, key: lineKey(other), weight });
      }
      const { winner } = vote(candidates);
      // Confidence is measured against every model that had an opinion,
      // including the ones whose reading was rejected as a different line.
      const total = candidates.reduce((sum, candidate) => sum + candidate.weight, 0) + contradicting;
      const lineConfidence = total > 0 ? (winner?.weight ?? 0) / total : 0;
      lineCount += 1;
      weightedConfidence += lineConfidence;
      sectionTotal += lineConfidence;
      return winner?.value ?? line;
    });

    sectionConfidence[section.label] = lines.length === 0 ? 0 : sectionTotal / lines.length;
    return { label: section.label, lines };
  });

  return {
    sections,
    confidence: lineCount === 0 ? 0 : weightedConfidence / lineCount,
    sectionConfidence,
  };
}
