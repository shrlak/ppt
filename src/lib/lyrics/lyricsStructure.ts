// Turn the flat lyric text the proxy scraped off the web into the labeled
// parts the slide planner works with.
//
// A published lyric page is written for a reader, not for a slide deck: parts
// are announced with headings ("1절", "후렴", "Bridge") or separated by blank
// lines, and the same chorus is usually printed once even though it is sung
// several times. This module recovers that structure and nothing more — the
// score still decides how many times each part is actually sung, because only
// the conti knows that.
//
// The words themselves are left exactly as the page printed them — its
// 띄어쓰기, punctuation and spelling all come through untouched.
import type { Section } from '../utils/types';
import { cleanScrapedLyricLines } from './koreanSpelling';

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

/** A song as a page published it: its parts, and the order it sings them. */
export interface ScrapedSong {
  sections: Section[];
  /** Title slide first, then each part every time it is sung. */
  order: string[];
}

/**
 * Split scraped lyric text into labeled sections.
 *
 * Layouts are handled in priority order:
 *  1. Explicit headings — every "1절"/"후렴"/"Bridge" line opens a new part.
 *  2. Blank-line stanzas, one of which is printed again — that one is the
 *     chorus, the others verses.
 *  3. Lines that repeat — a page with no headings and no blank lines (Bugs
 *     flattens a song this way) still prints its chorus every time it is
 *     sung, so the longest run of lines printed again is the chorus, the run
 *     every verse ends with is the pre-chorus, and what lies between are the
 *     verses or the bridge.
 *  4. Otherwise blank-line stanzas, verse and chorus taken in turn; and a
 *     long block with nothing to go by is cut into four-line verses rather
 *     than left as one part holding the whole song.
 *
 * A part printed more than once is one section — the order names it again.
 * Intro/interlude headings are dropped: they carry no lyrics, and the slide
 * planner already renders "I" as a title slide.
 */
export function structureScrapedSong(rawLines: string[]): ScrapedSong {
  const lines = rawLines.map((line) => line.trim());
  const hasHeadings = lines.some((line) => parsePartHeading(line) !== null);
  const groups = hasHeadings ? groupByHeadings(lines) : groupWithoutHeadings(lines);

  const counts = new Map<string, number>();
  const used = new Set<string>();
  const labelOf = new Map<string, string>();
  const sections: Section[] = [];
  const order = ['I'];
  for (const group of groups) {
    // Verbatim: a published page is the authority on the words, so the only
    // thing removed here is transport noise (see cleanScrapedLyricLines).
    const body = cleanScrapedLyricLines(group.lines);
    if (body.length === 0) continue;
    if (group.family === 'I') continue; // 간주 has no lyrics to show

    // The same part printed again is sung again, not a new part.
    const key = `${group.family}:${stanzaKey(body)}`;
    const known = labelOf.get(key);
    if (known) {
      order.push(known);
      continue;
    }
    const occurrence = (counts.get(group.family) ?? 0) + 1;
    counts.set(group.family, occurrence);
    const label = uniqueLabel(labelFor(group.family, group.index ?? occurrence), used);
    labelOf.set(key, label);
    sections.push({ label, lines: body });
    order.push(label);
  }
  return { sections, order };
}

/** Just the parts of structureScrapedSong. */
export function structureScrapedLyrics(rawLines: string[]): Section[] {
  return structureScrapedSong(rawLines).sections;
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

function splitStanzas(lines: string[]): string[][] {
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
  return stanzas;
}

/** Lines per part when a block gives nothing else to divide it by. */
const CHUNK_LINES = 4;
/** A block up to this long is one part as it stands. */
const SHORT_BLOCK_LINES = 8;

function groupWithoutHeadings(lines: string[]): Group[] {
  const stanzas = splitStanzas(lines);
  const seen = new Map<string, number>();
  for (const stanza of stanzas) seen.set(stanzaKey(stanza), (seen.get(stanzaKey(stanza)) ?? 0) + 1);
  // A stanza printed more than once is the chorus.
  if ([...seen.values()].some((count) => count > 1)) {
    return stanzas.map((stanza) => ({ family: (seen.get(stanzaKey(stanza)) ?? 0) > 1 ? 'C' : 'V', lines: stanza }));
  }
  const byRepeats = groupByRepeatedLines(stanzas.flat());
  if (byRepeats) return byRepeats;
  // Nothing repeats to give it away: the conventional verse/chorus turns.
  if (stanzas.length >= 2) {
    return stanzas.map((stanza, index) => ({ family: index % 2 === 0 ? 'V' : 'C', lines: stanza }));
  }
  const flat = stanzas.flat();
  if (flat.length <= SHORT_BLOCK_LINES) return flat.length > 0 ? [{ family: 'V', lines: flat }] : [];
  const chunks: Group[] = [];
  for (let at = 0; at < flat.length; at += CHUNK_LINES) chunks.push({ family: 'V', lines: flat.slice(at, at + CHUNK_LINES) });
  return chunks;
}

/** Comparison key for one line. */
function lineMatchKey(line: string): string {
  return line.toLowerCase().replace(/[^0-9a-z가-힣]+/g, '');
}

/**
 * Find the chorus in lines printed without headings or breaks: the run of
 * two or more lines printed again most, weighted by its length. Its
 * printings divide the song; a run every verse ends with just before it is
 * the pre-chorus; and a stretch between choruses is a verse when it is as
 * long as the first verse, the bridge when it is not. Null when no run of
 * lines is printed twice.
 */
function groupByRepeatedLines(lines: string[]): Group[] | null {
  const keys = lines.map(lineMatchKey);
  const n = lines.length;
  let best: { length: number; starts: number[]; score: number } | null = null;
  for (let length = Math.floor(n / 2); length >= 2; length -= 1) {
    const at = new Map<string, number[]>();
    for (let start = 0; start + length <= n; start += 1) {
      const run = keys.slice(start, start + length);
      if (run.some((key) => !key)) continue;
      const joined = run.join('\n');
      const list = at.get(joined);
      if (list) list.push(start);
      else at.set(joined, [start]);
    }
    for (const starts of at.values()) {
      // Printings that overlap are one printing.
      const apart: number[] = [];
      for (const start of starts) if (apart.length === 0 || start >= apart[apart.length - 1] + length) apart.push(start);
      if (apart.length < 2) continue;
      const score = length * (apart.length - 1);
      if (!best || score > best.score || (score === best.score && apart[0] < best.starts[0])) {
        best = { length, starts: apart, score };
      }
    }
  }
  if (!best) return null;

  // The song, cut at the chorus: stretches between, choruses in place.
  const pieces: { chorus: boolean; lines: string[] }[] = [];
  let cursor = 0;
  for (const start of best.starts) {
    if (start > cursor) pieces.push({ chorus: false, lines: lines.slice(cursor, start) });
    pieces.push({ chorus: true, lines: lines.slice(start, start + best.length) });
    cursor = start + best.length;
  }
  if (cursor < n) pieces.push({ chorus: false, lines: lines.slice(cursor) });

  // A pre-chorus: the same lines ending the first two stretches that lead
  // into a chorus (the verses). A bridge leading into one later need not
  // end with it, so it is split off only where it is printed.
  const leading = pieces.filter((piece, index) => !piece.chorus && pieces[index + 1]?.chorus);
  let preChorus: string[] = [];
  if (leading.length >= 2) {
    const [first, second] = leading;
    let shared = 0;
    while (
      shared < Math.min(first.lines.length, second.lines.length) - 1 &&
      lineMatchKey(first.lines[first.lines.length - 1 - shared]) ===
        lineMatchKey(second.lines[second.lines.length - 1 - shared])
    ) {
      shared += 1;
    }
    preChorus = first.lines.slice(first.lines.length - shared).map(lineMatchKey);
  }
  const endsWithPreChorus = (piece: { lines: string[] }) =>
    preChorus.length > 0 &&
    piece.lines.length > preChorus.length &&
    piece.lines.slice(piece.lines.length - preChorus.length).every((line, at) => lineMatchKey(line) === preChorus[at]);

  const groups: Group[] = [];
  let verseLength = 0;
  pieces.forEach((piece, index) => {
    if (piece.chorus) {
      groups.push({ family: 'C', lines: piece.lines });
      return;
    }
    const splitsOff = !!pieces[index + 1]?.chorus && endsWithPreChorus(piece);
    const body = splitsOff ? piece.lines.slice(0, piece.lines.length - preChorus.length) : piece.lines;
    // Verses share a length; a stretch of another length is the bridge.
    const verse = verseLength === 0 || body.length === verseLength;
    if (verseLength === 0) verseLength = body.length;
    if (body.length > 0) groups.push({ family: verse ? 'V' : 'B', lines: body });
    if (splitsOff) groups.push({ family: 'PC', lines: piece.lines.slice(piece.lines.length - preChorus.length) });
  });
  return groups;
}

/**
 * A label no part uses yet. An explicitly numbered heading can collide with
 * the running count (a page that labels "1절" then "절"), and two sections
 * with the same label would make 진행 순서 ambiguous.
 */
function uniqueLabel(label: string, used: Set<string>): string {
  let chosen = label;
  if (used.has(chosen)) {
    const family = label.replace(/\d+$/, '');
    let n = 2;
    while (used.has(`${family}${n}`)) n += 1;
    chosen = `${family}${n}`;
  }
  used.add(chosen);
  return chosen;
}

/**
 * A play order covering every scraped part once, opening with the title
 * slide. Only used when neither the score nor the conti printed one — the
 * printed 진행 순서 always wins, since it is the one that knows the repeats.
 */
export function orderForSections(sections: Section[]): string[] {
  return ['I', ...sections.map((section) => section.label)];
}
