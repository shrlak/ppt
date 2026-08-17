// What changed between what recognition produced and what the user saved.
//
// This diff is the whole basis of the learning loop. It answers two questions
// at once: whether the user actually confirmed the machine's answer (nothing
// changed → 'verified') or corrected it ('edited'), and exactly which fields
// were wrong, so each model can be scored on the fields it got wrong rather
// than on a single pass/fail.
//
// Only STRUCTURE is reported — which fields changed, which line indexes
// changed. The lyric values themselves never appear in a diff, so a diff is
// safe to log, count, and show in the admin dashboard.
import { normalizeText } from '../ai/recognitionScoring';
import type { ParsedScore } from '../ai/scoreParser';
import type { VerificationState } from '../utils/types';
import type { RecognitionObservation } from '../ai/recognitionObservation';
import type { ModelEvaluation } from '../ai/modelReliability';
import type { ScoredLyricsCandidate } from '../lyrics/webLyrics';

export interface SectionChange {
  label: string;
  labelChanged: boolean;
  changedLineIndexes: number[];
}

export interface FeedbackDiff {
  titleChanged: boolean;
  artistChanged: boolean;
  keyChanged: boolean;
  orderChanged: boolean;
  sectionChanges: SectionChange[];
}

/**
 * One page's complete record: the machine's answer, the user's, and what
 * separates them.
 *
 * `webCandidates` deliberately carries the candidates WITHOUT their lyric
 * lines. What matters for learning is which page was offered and how well it
 * scored; copying a third party's lyric text into our own store adds nothing
 * and is not ours to keep.
 */
export interface FeedbackWebCandidate {
  id: string;
  title: string;
  artist?: string;
  url: string;
  host: string;
  source: string;
  score: number;
  titleScore: number;
  artistScore: number;
  lyricsScore: number;
  decision: ScoredLyricsCandidate['decision'];
}

export interface FeedbackExample {
  id: string;
  pageHash: string;
  /** Hash of the canonical final score, so a repeated save is recognizable. */
  finalHash: string;
  createdAt: string;
  observations: RecognitionObservation[];
  baseline: ParsedScore;
  final: ParsedScore;
  webCandidates: FeedbackWebCandidate[];
  selectedWebCandidateId?: string;
  diff: FeedbackDiff;
  verification: Extract<VerificationState, 'verified' | 'edited'>;
  /**
   * Each model's accuracy on this page, measured client-side against the
   * saved answer.
   *
   * Travelling with the record rather than in a second request is what makes
   * scoring exactly-once: the proxy applies them only when it stores the
   * record, so a re-sent duplicate cannot count a model twice.
   */
  evaluations: ModelEvaluation[];
  /**
   * The alias / correction / example contributions this one record supports.
   *
   * Derived here rather than on the proxy because deciding what counts as a
   * correction needs both readings and the language rules; the proxy only
   * counts, exactly as it does for model accuracy.
   */
  memory?: {
    aliases: { from: string; to: string }[];
    corrections: { before: string; after: string; contextBefore: string; contextAfter: string }[];
    examples: { before: string; after: string; title?: string; label?: string }[];
  };
}

function same(a: string | undefined, b: string | undefined): boolean {
  return normalizeText(a ?? '') === normalizeText(b ?? '');
}

/**
 * Compare the machine's reading with the saved one, field by field.
 *
 * Comparison is normalized — spacing and punctuation differences are not
 * corrections, and counting them as such would mark almost every save as
 * 'edited' and destroy the signal the whole loop depends on.
 */
export function diffFeedback(baseline: ParsedScore, final: ParsedScore): FeedbackDiff {
  const sectionChanges: SectionChange[] = [];
  const length = Math.max(baseline.sections.length, final.sections.length);
  for (let index = 0; index < length; index += 1) {
    const before = baseline.sections[index];
    const after = final.sections[index];
    if (!after) {
      // A part the user deleted: every line it had is a change.
      sectionChanges.push({
        label: before.label,
        labelChanged: true,
        changedLineIndexes: before.lines.map((_line, line) => line),
      });
      continue;
    }
    if (!before) {
      sectionChanges.push({
        label: after.label,
        labelChanged: true,
        changedLineIndexes: after.lines.map((_line, line) => line),
      });
      continue;
    }
    const lineCount = Math.max(before.lines.length, after.lines.length);
    const changedLineIndexes: number[] = [];
    for (let line = 0; line < lineCount; line += 1) {
      if (!same(before.lines[line], after.lines[line])) changedLineIndexes.push(line);
    }
    const labelChanged = before.label.trim().toUpperCase() !== after.label.trim().toUpperCase();
    if (labelChanged || changedLineIndexes.length > 0) {
      sectionChanges.push({ label: after.label, labelChanged, changedLineIndexes });
    }
  }

  return {
    titleChanged: !same(baseline.title, final.title),
    artistChanged: !same(baseline.artist, final.artist),
    keyChanged: !same(baseline.key, final.key),
    orderChanged:
      baseline.order.map((token) => token.toUpperCase()).join('-') !==
      final.order.map((token) => token.toUpperCase()).join('-'),
    sectionChanges,
  };
}

/** True when the user changed nothing at all. */
export function isUnchanged(diff: FeedbackDiff): boolean {
  return (
    !diff.titleChanged &&
    !diff.artistChanged &&
    !diff.keyChanged &&
    !diff.orderChanged &&
    diff.sectionChanges.length === 0
  );
}

/**
 * What an explicit save means.
 *
 * Confirming the machine's answer unchanged is every bit as informative as
 * correcting it — it is the only evidence a model got a page RIGHT — so both
 * outcomes are ground truth, distinguished only by which one happened.
 */
export function verificationFor(diff: FeedbackDiff): Extract<VerificationState, 'verified' | 'edited'> {
  return isUnchanged(diff) ? 'verified' : 'edited';
}

/** A stable serialization of a reading, so the same answer hashes the same. */
export function canonicalScore(score: ParsedScore): string {
  return JSON.stringify({
    title: score.title ?? '',
    artist: score.artist ?? '',
    key: score.key ?? '',
    order: score.order.map((token) => token.toUpperCase()),
    sections: score.sections.map((section) => ({
      label: section.label.trim().toUpperCase(),
      lines: section.lines.map((line) => line.trim()),
    })),
  });
}

/** Strip a web candidate down to its provenance, leaving the lyric text behind. */
export function feedbackCandidate(candidate: ScoredLyricsCandidate): FeedbackWebCandidate {
  return {
    id: candidate.id,
    title: candidate.title,
    artist: candidate.artist,
    url: candidate.sourceUrl,
    host: candidate.sourceHost,
    source: candidate.source,
    score: candidate.score,
    titleScore: candidate.titleScore,
    artistScore: candidate.artistScore,
    lyricsScore: candidate.lyricsScore,
    decision: candidate.decision,
  };
}
