// Turn the flat lyric text the proxy scraped off the web into the labeled
// parts the slide planner works with.
//
// A published lyric page is written for a reader, not for a slide deck: parts
// are announced with headings ("1절", "후렴", "Bridge") or separated by blank
// lines, and the same chorus is usually printed once even though it is sung
// several times. This module recovers that structure and nothing more — the
// score still decides how many times each part is actually sung, because only
// the conti knows that.
import type { Section } from '../utils/types';
import { normalizeKoreanLyricLines } from './koreanSpelling';

/** A line that is only a part heading, e.g. "1절", "[후렴]", "Verse 2:". */
const PART_HEADING =
  /^[[(<{]?\s*(?<word>\d\s*절|절|후렴구|후렴|간주|전주|후주|브릿지|브리지|프리\s*코러스|프리코러스|verse|chorus|bridge|pre[- ]?chorus|intro|outro|refrain|tag)\s*(?<index>\d{0,2})\s*[\])>}]?\s*[:.]?\s*$/i;

/** The canonical part family for a heading word. */
const HEADING_FAMILY: Record<string, string> = {
  절: 'V',
  후렴: 'C',
  후렴구: 'C',
  간주: 'I',
  전주: 'I',
  후주: 'O',
  브릿지: 'B',
  브리지: 'B',
  프리코러스: 'PC',
  verse: 'V',
  chorus: 'C',
  bridge: 'B',
  prechorus: 'PC',
  intro: 'I',
  outro: 'O',
  refrain: 'C',
  tag: 'T',
};

interface Heading {
  family: string;
  /** Explicit number from the heading ("2절" → 2), when it had one. */
  index?: number;
}

/** Read a line as a part heading, or return null when it is lyric text. */
export function parsePartHeading(line: string): Heading | null {
  const match = PART_HEADING.exec(line.trim());
  if (!match?.groups) return null;

  const word = match.groups.word.replace(/[\s-]/g, '').toLowerCase();
  // "1절" carries its own number; "verse 2" carries it in the second group.
  const numbered = /^(\d)절$/.exec(word);
  const family = numbered ? 'V' : HEADING_FAMILY[word];
  if (!family) return null;

  const index = numbered
    ? Number(numbered[1])
    : match.groups.index
      ? Number(match.groups.index)
      : undefined;
  return { family, index };
}

/** Label for the n-th part of a family — the first one stays bare, matching
 * the labels recognition produces (V, V2, V3 / C, C2). */
function labelFor(family: string, occurrence: number): string {
  return occurrence <= 1 ? family : `${family}${occurrence}`;
}

/**
 * Split scraped lyric text into labeled sections.
 *
 * Two layouts are handled, in priority order:
 *  1. Explicit headings — every "1절"/"후렴"/"Bridge" line opens a new part.
 *  2. Blank-line groups — with no headings at all, each blank-line-separated
 *     stanza becomes a part, guessed as verse/chorus by repetition: a stanza
 *     whose text repeats later in the song is the chorus.
 *
 * Intro/interlude headings are dropped: they carry no lyrics, and the slide
 * planner already renders "I" as a title slide.
 */
export function structureScrapedLyrics(rawLines: string[]): Section[] {
  const lines = rawLines.map((line) => line.trim());
  const hasHeadings = lines.some((line) => parsePartHeading(line) !== null);
  const groups = hasHeadings ? groupByHeadings(lines) : groupByBlankLines(lines);

  const counts = new Map<string, number>();
  const sections: Section[] = [];
  for (const group of groups) {
    const body = normalizeKoreanLyricLines(group.lines);
    if (body.length === 0) continue;
    if (group.family === 'I') continue; // 간주 has no lyrics to show

    const occurrence = (counts.get(group.family) ?? 0) + 1;
    counts.set(group.family, occurrence);
    sections.push({
      label: labelFor(group.family, group.index ?? occurrence),
      lines: body,
    });
  }
  return dedupeLabels(sections);
}

interface Group {
  family: string;
  index?: number;
  lines: string[];
}

function groupByHeadings(lines: string[]): Group[] {
  const groups: Group[] = [];
  let current: Group | null = null;
  for (const line of lines) {
    const heading = parsePartHeading(line);
    if (heading) {
      current = { family: heading.family, index: heading.index, lines: [] };
      groups.push(current);
      continue;
    }
    if (!line) continue;
    // Text before the first heading is the opening verse.
    if (!current) {
      current = { family: 'V', lines: [] };
      groups.push(current);
    }
    current.lines.push(line);
  }
  return groups;
}

/** Comparison key for "is this the same stanza printed again". */
function stanzaKey(lines: string[]): string {
  return lines.join(' ').toLowerCase().replace(/[^0-9a-z가-힣]+/g, '');
}

function groupByBlankLines(lines: string[]): Group[] {
  const stanzas: string[][] = [];
  let current: string[] = [];
  for (const line of lines) {
    if (line) current.push(line);
    else if (current.length > 0) {
      stanzas.push(current);
      current = [];
    }
  }
  if (current.length > 0) stanzas.push(current);

  // A stanza printed more than once is the chorus; with no repetition at all
  // the conventional verse/chorus alternation is the best available guess.
  const seen = new Map<string, number>();
  for (const stanza of stanzas) {
    const key = stanzaKey(stanza);
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  const repeats = [...seen.values()].some((count) => count > 1);

  return stanzas.map((stanza, index) => ({
    family: repeats
      ? (seen.get(stanzaKey(stanza)) ?? 0) > 1
        ? 'C'
        : 'V'
      : index % 2 === 0
        ? 'V'
        : 'C',
    lines: stanza,
  }));
}

/**
 * Make labels unique. An explicitly numbered heading can collide with the
 * running count (a page that labels "1절" then "절"), and two sections with
 * the same label would make 진행 순서 ambiguous.
 */
function dedupeLabels(sections: Section[]): Section[] {
  const used = new Set<string>();
  return sections.map((section) => {
    if (!used.has(section.label)) {
      used.add(section.label);
      return section;
    }
    const family = section.label.replace(/\d+$/, '');
    let n = 2;
    while (used.has(`${family}${n}`)) n += 1;
    used.add(`${family}${n}`);
    return { label: `${family}${n}`, lines: section.lines };
  });
}

/**
 * A play order covering every scraped part once, opening with the title
 * slide. Only used when neither the score nor the conti printed one — the
 * printed 진행 순서 always wins, since it is the one that knows the repeats.
 */
export function orderForSections(sections: Section[]): string[] {
  return ['I', ...sections.map((section) => section.label)];
}
