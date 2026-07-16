import type { Song, Section, SlidePlan } from './types';

const DEFAULT_LINES_PER_SLIDE = 4;

/**
 * Find the section matching an order token.
 * Exact (case-insensitive) match first, then V→V1 for digitless tokens,
 * then V2→V for suffixed tokens whose exact label is absent.
 */
export function findSection(sections: Section[], token: string): Section | undefined {
  const want = token.trim().toUpperCase();
  const byLabel = (label: string) =>
    sections.find((s) => s.label.trim().toUpperCase() === label);

  const exact = byLabel(want);
  if (exact) return exact;
  if (!/\d/.test(want)) return byLabel(want + '1');
  return byLabel(want.replace(/\d+$/, ''));
}

/**
 * Reorder recognized sections to match the first-appearance sequence of the
 * score's printed 진행 순서 (order tokens), so the editable section list —
 * and anything later saved into the library — reads in the same Verse →
 * Pre-Chorus → Chorus → Bridge sequence printed on the score, not whatever
 * order the recognition engine happened to list them in.
 *
 * Sections with no matching order token (or when order is empty) keep their
 * original relative position, appended after the ones the order placed.
 */
export function sortSectionsByOrder(sections: Section[], order: string[]): Section[] {
  const placed = new Set<Section>();
  const sorted: Section[] = [];
  for (const token of order) {
    if (token === 'I') continue; // intro has no lyrics section to place
    const section = findSection(sections, token);
    if (!section || placed.has(section)) continue;
    placed.add(section);
    sorted.push(section);
  }
  for (const section of sections) {
    if (!placed.has(section)) sorted.push(section);
  }
  return sorted;
}

function usableLines(section: Section | undefined): string[] {
  if (!section) return [];
  return section.lines.map((l) => l.trim()).filter((l) => l.length > 0);
}

/** Order tokens (except "I") that resolve to no section with at least one non-empty line. */
export function unmatchedTokens(song: Song): string[] {
  const missing = new Set<string>();
  for (const token of song.order) {
    if (token === 'I') continue;
    if (usableLines(findSection(song.sections, token)).length === 0) {
      missing.add(token);
    }
  }
  return [...missing];
}

/**
 * Split into ceil(n / size) groups, no group exceeding `size`, and sizes as
 * equal as possible — 6 lines at a limit of 4 becomes two slides of 3 rather
 * than an uneven 4-then-2.
 */
function chunkBalanced<T>(items: T[], size: number): T[][] {
  if (items.length === 0) return [];
  const groups = Math.ceil(items.length / size);
  const base = Math.floor(items.length / groups);
  const remainder = items.length % groups;
  const out: T[][] = [];
  let i = 0;
  for (let g = 0; g < groups; g++) {
    const len = base + (g < remainder ? 1 : 0);
    out.push(items.slice(i, i + len));
    i += len;
  }
  return out;
}

/**
 * Plan the slides for one song: a title slide, then each part exactly ONCE.
 *
 * The 콘티 order (e.g. I-V1-V2-PC-C-간주-V1-V2-PC-C-C) is NOT expanded into
 * repeated slides — repeats are handled live by the operator jumping back.
 * The order determines which parts appear and their first-appearance order;
 * with no order given, every section is included in its listed order.
 */
export function planSlides(song: Song): SlidePlan[] {
  const linesPerSlide =
    song.linesPerSlide && song.linesPerSlide >= 1 ? song.linesPerSlide : DEFAULT_LINES_PER_SLIDE;
  const plans: SlidePlan[] = [{ kind: 'title', title: song.title }];

  const tokens = song.order.length > 0 ? song.order : song.sections.map((s) => s.label);

  const seen = new Set<Section>();
  for (const token of tokens) {
    if (token === 'I') continue; // the leading title slide covers intro/간주
    const section = findSection(song.sections, token);
    if (!section || seen.has(section)) continue;
    seen.add(section);
    const lines = usableLines(section);
    if (lines.length === 0) continue;
    for (const group of chunkBalanced(lines, linesPerSlide)) {
      plans.push({ kind: 'lyrics', title: song.title, lines: group });
    }
  }
  return plans;
}

/** Plan the slides for the whole deck. */
export function planAllSlides(songs: Song[]): SlidePlan[] {
  return songs.flatMap(planSlides);
}
