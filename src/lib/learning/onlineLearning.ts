// Reusing what the user already corrected, immediately.
//
// A fine-tuned model is weeks away and needs hundreds of examples. Meanwhile
// the same corrections repeat every week: the same title misread the same way,
// the same syllable swapped in the same phrase. This module turns verified
// corrections into three small, bounded things the pipeline can use today —
// title ALIASES, so a page whose title is always misread still finds its saved
// lyrics instead of being recognized from scratch; safe CORRECTIONS, applied
// after consensus to fix a repeat misreading; and short EXAMPLES, shown to the
// models so they make the fix themselves.
//
// Everything here is deliberately conservative. A wrong alias sends a song to
// the wrong lyrics and a wrong correction rewrites a line nobody checked, so
// each of the three has an activation bar that a one-off cannot clear.
import { lineSimilarity } from '../lyrics/textSimilarity';
import { normalizeText } from '../ai/recognitionScoring';
import type { ParsedScore } from '../ai/scoreParser';
import type { FeedbackExample } from './feedbackDiff';

/** Identical corrections needed before a title alias is trusted. */
export const ALIAS_SUPPORT = 2;

/** Examples needed before a text correction is applied automatically. */
export const CORRECTION_SUPPORT = 3;

/** How often the correction must have been the outcome when its text appeared. */
export const CORRECTION_PRECISION = 0.8;

/** A corrected line must still read as the same line. */
export const CORRECTION_SIMILARITY = 0.6;

/** Longest example text shown to a model; a prompt is not a lyric store. */
export const MAX_EXAMPLE_CHARS = 120;

export interface TitleAlias {
  /** Normalized misreading, as it comes off the page. */
  from: string;
  /** The title the user saved. */
  to: string;
  support: number;
}

export interface TextCorrection {
  before: string;
  after: string;
  /** Neighbouring words the misreading sat between, so it is not applied blind. */
  contextBefore: string;
  contextAfter: string;
  /** Times this exact correction was confirmed. */
  support: number;
  /** Times the `before` text appeared at all: the denominator of precision. */
  seen: number;
}

export interface CorrectionExample {
  before: string;
  after: string;
  /** Title the example came from, used to prefer relevant ones. */
  title?: string;
  /** Part label the example came from, used the same way. */
  label?: string;
}

export interface LearningMemory {
  titleAliases: TitleAlias[];
  corrections: TextCorrection[];
  examples: CorrectionExample[];
}

export const EMPTY_MEMORY: LearningMemory = { titleAliases: [], corrections: [], examples: [] };

/** Split a line into words, keeping the words only. */
function words(line: string): string[] {
  return line.trim().split(/\s+/).filter(Boolean);
}

/**
 * The smallest edit that turns one line into the other, with a word of
 * context on each side.
 *
 * Word-level rather than character-level because a Korean misreading is a
 * syllable inside a word, and the word around it is what makes the correction
 * safe to reapply: a fix is only right where the same neighbours appear.
 */
export function extractCorrection(before: string, after: string): TextCorrection | null {
  const left = words(before);
  const right = words(after);
  if (left.length === 0 || right.length === 0) return null;

  let start = 0;
  while (start < left.length && start < right.length && left[start] === right[start]) start += 1;
  let end = 0;
  while (
    end < left.length - start &&
    end < right.length - start &&
    left[left.length - 1 - end] === right[right.length - 1 - end]
  ) {
    end += 1;
  }

  const beforeChunk = left.slice(start, left.length - end).join(' ');
  const afterChunk = right.slice(start, right.length - end).join(' ');
  // Identical lines, or a change so total that there is no shared anchor.
  if (!beforeChunk || !afterChunk || beforeChunk === afterChunk) return null;
  if (beforeChunk.length > MAX_EXAMPLE_CHARS || afterChunk.length > MAX_EXAMPLE_CHARS) return null;

  return {
    before: beforeChunk,
    after: afterChunk,
    contextBefore: start > 0 ? left[start - 1] : '',
    contextAfter: end > 0 ? left[left.length - end] : '',
    support: 1,
    seen: 1,
  };
}

function correctionKey(
  correction: Pick<TextCorrection, 'before' | 'after' | 'contextBefore' | 'contextAfter'>,
): string {
  return [correction.contextBefore, correction.before, correction.after, correction.contextAfter].join(' ');
}

/**
 * Build the memory a set of verified corrections supports.
 *
 * Only 'verified' and 'edited' records reach here. A draft is a machine's
 * guess, and learning from it would let one bad reading teach itself.
 */
export function buildLearningMemory(feedback: FeedbackExample[]): LearningMemory {
  const aliases = new Map<string, { to: string; support: number }>();
  const corrections = new Map<string, TextCorrection>();
  const examples: CorrectionExample[] = [];

  for (const record of feedback) {
    if (record.verification !== 'verified' && record.verification !== 'edited') continue;

    const from = normalizeText(record.baseline.title ?? '');
    const to = record.final.title?.trim();
    if (from && to && from !== normalizeText(to)) {
      const existing = aliases.get(from);
      if (existing && existing.to === to) existing.support += 1;
      else if (!existing) aliases.set(from, { to, support: 1 });
    }

    for (const change of record.diff.sectionChanges) {
      const baselineSection = record.baseline.sections.find((section) => section.label === change.label);
      const finalSection = record.final.sections.find((section) => section.label === change.label);
      if (!baselineSection || !finalSection) continue;
      for (const index of change.changedLineIndexes) {
        const before = baselineSection.lines[index];
        const after = finalSection.lines[index];
        if (!before || !after) continue;
        const correction = extractCorrection(before, after);
        if (!correction) continue;
        const key = correctionKey(correction);
        const existing = corrections.get(key);
        if (existing) {
          existing.support += 1;
          existing.seen += 1;
        } else {
          corrections.set(key, correction);
        }
        examples.push({
          before: before.slice(0, MAX_EXAMPLE_CHARS),
          after: after.slice(0, MAX_EXAMPLE_CHARS),
          title: record.final.title,
          label: change.label,
        });
      }
    }
  }

  return {
    titleAliases: [...aliases.entries()].map(([from, value]) => ({ from, to: value.to, support: value.support })),
    corrections: [...corrections.values()],
    examples,
  };
}

/**
 * Replace a title the models are known to misread with the one the user saved.
 *
 * Whole-title match only. A substring rule would rewrite every title that
 * happens to contain the misreading, which is how a lookup ends up on a
 * different song entirely.
 */
export function resolveTitleAlias(title: string, memory: LearningMemory): string {
  const wanted = normalizeText(title);
  if (!wanted) return title;
  const alias = memory.titleAliases.find(
    (candidate) => candidate.from === wanted && candidate.support >= ALIAS_SUPPORT,
  );
  return alias ? alias.to : title;
}

/** Corrections with enough evidence behind them to apply without asking. */
export function safeCorrections(memory: LearningMemory): TextCorrection[] {
  return memory.corrections.filter(
    (correction) =>
      correction.support >= CORRECTION_SUPPORT &&
      correction.seen > 0 &&
      correction.support / correction.seen >= CORRECTION_PRECISION,
  );
}

/** Apply one correction to a line, only where its context matches. */
function correctLine(line: string, correction: TextCorrection): string {
  const pattern = [correction.contextBefore, correction.before, correction.contextAfter]
    .filter(Boolean)
    .join(' ');
  if (!pattern || !line.includes(pattern)) return line;
  const replacement = [correction.contextBefore, correction.after, correction.contextAfter]
    .filter(Boolean)
    .join(' ');
  return line.replace(pattern, replacement);
}

/**
 * Apply the corrections the evidence supports, and nothing else.
 *
 * A corrected line still has to read as the same line: a rule that turns a
 * line into something else was learned from a mis-aligned diff, and applying
 * it would rewrite lyrics nobody checked. Lines the web already settled with
 * high confidence are left alone, since that evidence is fresher than a rule
 * learned weeks ago.
 */
export function applySafeCorrections(
  score: ParsedScore,
  memory: LearningMemory,
  protectedLines: ReadonlySet<string> = new Set(),
): ParsedScore {
  const active = safeCorrections(memory);
  if (active.length === 0) return score;

  let touched = false;
  const sections = score.sections.map((section) => {
    const lines = section.lines.map((line) => {
      if (protectedLines.has(line)) return line;
      let next = line;
      for (const correction of active) next = correctLine(next, correction);
      if (next === line) return line;
      if (lineSimilarity(next, line) < CORRECTION_SIMILARITY) return line;
      touched = true;
      return next;
    });
    return { label: section.label, lines };
  });

  return touched ? { ...score, sections } : score;
}

export interface PageHint {
  title?: string;
  partLabels?: string[];
}

/**
 * A few past corrections to show the models, most relevant first.
 *
 * Relevance is same song, then same part, then anything: a model shown how
 * this song was corrected last week is far more likely to read it right than
 * one shown three unrelated fixes. Capped hard, because the prompt is a nudge
 * and not a place to keep a lyric library.
 */
export function promptExamplesFor(hint: PageHint, memory: LearningMemory, limit = 3): CorrectionExample[] {
  const title = normalizeText(hint.title ?? '');
  const labels = new Set((hint.partLabels ?? []).map((label) => label.trim().toUpperCase()));
  const rank = (example: CorrectionExample): number => {
    if (title && normalizeText(example.title ?? '') === title) return 0;
    if (example.label && labels.has(example.label.trim().toUpperCase())) return 1;
    return 2;
  };
  const seen = new Set<string>();
  return memory.examples
    .filter((example) => {
      const key = `${example.before} ${example.after}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return example.before.length <= MAX_EXAMPLE_CHARS && example.after.length <= MAX_EXAMPLE_CHARS;
    })
    .map((example, index) => ({ example, rank: rank(example), index }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .slice(0, limit)
    .map((entry) => entry.example);
}
