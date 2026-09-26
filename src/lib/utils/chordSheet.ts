// Reads a chord-sheet 콘티 — the CCLI SongSelect / ChordPro "Chord Sheets"
// PDF a praise team exports, one song after another — straight from its text
// layer, so the lyrics need no 악보 recognition at all.
//
// Such a PDF is laid out for musicians, not for reading top to bottom:
//
//   - every song opens with a header (title, credits, `Key - D | Time - 4/4`)
//     and closes with a CCLI footer, and a long song runs onto the next page
//     with neither;
//   - the page has two columns, each a run of sections (VERSE 1, CHORUS,
//     VERSE 1 (KOREAN), BRIDGE …);
//   - every lyric line sits under a row of chords, and each syllable a chord
//     lands on is written as its own piece of text — in the text stream those
//     pieces come after everything else on the page, so reading the stream in
//     order scrambles every line.
//
// So the lines are rebuilt from where each piece of text sits on the page:
// grouped into rows by baseline, a column at a time, chord rows dropped, and
// the pieces of a lyric row joined left to right. Bilingual sheets write the
// Korean and the English of a part either in one section (Korean lines, then
// English lines) or in two ("VERSE 1" and "VERSE 1 (KOREAN)"); both come out
// as one part carrying both languages.
//
// One thing the page cannot say is Korean word spacing where a chord is
// wider than the syllable under it: the renderer pads that syllable out to
// the chord, and the padding looks exactly like a space whether the lyric has
// one there ("모든 것") or not ("높고"). Those gaps are settled by a spacing
// model learned from lyrics this church already has — see createSpacingModel.

import type { Section, Song } from './types';

/** One piece of text on a PDF page, in PDF user space (y grows upward). */
export interface PositionedText {
  str: string;
  x: number;
  y: number;
  width: number;
  /** Font size — the glyph height. */
  size: number;
}

export interface PositionedPage {
  width: number;
  height: number;
  items: PositionedText[];
}

/** One part of a song as the sheet writes it, both languages side by side. */
export interface ChordSheetPart {
  /** Part label the lyric editor uses: V, V2, PC, C, B, T, O… */
  label: string;
  /** The heading as printed, without its language tag ("VERSE 1"). */
  heading: string;
  /** Korean lines. */
  ko: string[];
  /** English lines (or the lines of a part written only in English). */
  en: string[];
}

export interface ChordSheetSong {
  /** Title as printed, without the alternate title in parentheses. */
  title: string;
  /** "춤추는 세대 (주 자비 춤추게 하네)" → "주 자비 춤추게 하네". */
  altTitle?: string;
  key?: string;
  /** 1-based pages the song covers, in order. */
  pages: number[];
  parts: ChordSheetPart[];
}

/** Decides a Korean gap the page leaves open: true puts a space there. */
export type SpacingModel = (left: string, right: string) => boolean;

export interface ChordSheetOptions {
  /**
   * Korean lyric lines with trusted spacing (the 찬양 라이브러리, last year's
   * slides), to learn word breaks from. The sheet's own unambiguous text is
   * always added to it.
   */
  corpus?: string[];
}

const HANGUL = /[가-힣ㄱ-ㆎ]/;
const HANGUL_SYLLABLE = /[가-힣]/;

/** `Key - D | Time - 4/4`, or the Korean sheet's `조(키:Key) - E | 시간 - 4/4`. */
const KEY_LINE = /^(?:Key|조\s*\(\s*키\s*:\s*Key\s*\))\s*-\s*([A-G](?:#|b|♯|♭)?m?)(?![a-z])/i;
const FOOTER_START = /^CCLI\s+Song\s*#/i;

/**
 * A section heading: VERSE 1, PRE-CHORUS, BRIDGE 1A, VERSE 1 (KOREAN)…
 * Upper case only — a lyric line never is, and that keeps "Chorus of angels"
 * a lyric.
 */
const HEADING =
  /^(INTRO|VERSE|PRE-?CHORUS|CHORUS|POST-?CHORUS|BRIDGE|TAG|INSTRUMENTAL|INTERLUDE|TURNAROUND|ENDING|OUTRO|REFRAIN|VAMP|CODA|BREAKDOWN|MISC(?:ELLANEOUS)?)(?:\s+(\d+[A-Z]?))?(?:\s*\(\s*(KOREAN|ENGLISH|KOR|ENG|한글|한국어|영어)\s*\))?$/;

/** Part family for each heading word. Intro-like parts get a label other than
 * "I", which the lyric editor reserves for the 간주 title slide. */
const FAMILY: Record<string, string> = {
  INTRO: 'IN',
  VERSE: 'V',
  PRECHORUS: 'PC',
  CHORUS: 'C',
  POSTCHORUS: 'PO',
  BRIDGE: 'B',
  TAG: 'T',
  INSTRUMENTAL: 'IN',
  INTERLUDE: 'IN',
  TURNAROUND: 'IN',
  ENDING: 'O',
  OUTRO: 'O',
  REFRAIN: 'C',
  VAMP: 'T',
  CODA: 'O',
  BREAKDOWN: 'T',
  MISC: 'T',
  MISCELLANEOUS: 'T',
};

/** A chord symbol: D, Bm7, G2, Dm/F, Bbmaj7, E°, Eb(4), (Eb(4)), F#m7… */
const CHORD =
  /^\(?[A-G](?:#|b|♯|♭)?(?:maj|mj|min|dim|aug|sus|add|m|M|°|ø|\+|\d|\((?:[#b]?\d+|sus\d*|add\d+)\))*(?:\/[A-G](?:#|b|♯|♭)?)?\)?$/;
/**
 * The rest of a chord where the sheet sets it apart: a superscript extension
 * ("7", "sus", "maj7", "9(b5)", "j7") or the bass of a slash chord ("/F").
 */
const CHORD_PIECE = /^(?:(?:\d|sus|maj|mj|min|add|dim|aug|m|j|b|#|°|ø|\+|\(|\))+|\/[A-G](?:#|b|♯|♭)?)$/;
/** Bar lines, repeats and the like on an instrumental row. */
const CHART_MARK = /^(?:\|{1,2}:?|:?\|{1,2}|N\.C\.|[xX×]\d+|%|\/|-|\.|\(|\))$/;

/**
 * A playing direction: (To Ch.), (to Turnaround), (Last x to Ch.),
 * (2nd x to Pre-Ch.), (To Ch. / Last time). A direction can wrap onto the
 * next row, so the closing parenthesis is optional here.
 */
const DIRECTION = /\(\s*(?:\d+(?:st|nd|rd|th)\s*x\s*|last\s*(?:x|time)\s*)?to\b[^)]*\)?/gi;
/** "(1.)", "(2).", "(3)." — the numbered endings of a repeated part. */
const ENDING_MARK = /^\(\s*\d\s*\.?\s*\)\s*\.?\s*/;

/** Two pieces are in one row when their baselines are this close (× size). */
const ROW_TOLERANCE = 0.3;
/** A gap this wide (× size) between two pieces of text is a word break. */
const WORD_GAP = 0.2;
/**
 * A gap that ends within this distance (× size) of the chord above it was
 * set by the chord, not by the lyric: the renderer pads a syllable out to a
 * wider chord whether or not a space follows it.
 */
const CHORD_REACH = 1.0;
/** A word no lyric line ends on: the line was wrapped right after it. */
const DANGLING_WORD = /(?:^|\s)(?:['’]cause|because|the|a|an|and|of|my|your|our|his|their|with)$/i;
/** Stands in a rebuilt line for a Korean gap only the spacing model can settle. */
const OPEN_GAP = '\u0000';

interface Row {
  y: number;
  size: number;
  /** Pieces left to right. */
  pieces: PositionedText[];
  /** Text with every gap closed as a space, for classifying the row. */
  text: string;
  left: number;
  right: number;
}

function clean(text: string): string {
  return text.replace(/[ \t\r\n]+/g, ' ').trim();
}

/** Group pieces of text into rows by baseline, top to bottom. */
function rowsOf(items: PositionedText[]): Row[] {
  const sorted = [...items].sort((a, b) => b.y - a.y || a.x - b.x);
  const groups: PositionedText[][] = [];
  for (const item of sorted) {
    const last = groups[groups.length - 1];
    const anchor = last?.[0];
    if (anchor && Math.abs(anchor.y - item.y) <= ROW_TOLERANCE * Math.max(anchor.size, item.size)) {
      last.push(item);
    } else {
      groups.push([item]);
    }
  }
  return groups.map((group) => {
    const pieces = [...group].sort((a, b) => a.x - b.x);
    return {
      y: group[0].y,
      size: Math.max(...group.map((piece) => piece.size)),
      pieces,
      text: joinPieces(pieces, () => ' '),
      left: pieces[0].x,
      right: Math.max(...pieces.map((piece) => piece.x + piece.width)),
    };
  });
}

/**
 * Join a row's pieces left to right. `openGap` decides a gap wide enough to
 * be a word break that may have been set by a chord instead.
 */
function joinPieces(pieces: PositionedText[], openGap: (left: PositionedText, right: PositionedText) => string): string {
  let text = '';
  let previous: PositionedText | null = null;
  let end = -Infinity;
  for (const piece of pieces) {
    if (previous && text) {
      const gap = piece.x - end;
      if (/\s$/.test(text) || /^\s/.test(piece.str)) text += ' ';
      else if (gap > WORD_GAP * piece.size) text += openGap(previous, piece);
    }
    text += piece.str;
    previous = piece;
    end = Math.max(end, piece.x + piece.width);
  }
  return clean(text);
}

/** True when every token of a row is a chord, part of one, or a bar line. */
export function isChordRow(text: string): boolean {
  if (HANGUL.test(text)) return false;
  const tokens = text.split(/\s+/).filter(Boolean);
  return (
    tokens.length > 0 &&
    tokens.every((token) => CHORD.test(token) || CHORD_PIECE.test(token) || CHART_MARK.test(token))
  );
}

interface Heading {
  /** Heading without its language tag, e.g. "VERSE 1". */
  base: string;
  family: string;
  language?: 'ko' | 'en';
}

export function parseSheetHeading(text: string): Heading | null {
  const match = HEADING.exec(text.trim());
  if (!match) return null;
  const word = match[1].replace(/-/g, '');
  const family = FAMILY[word] ?? 'T';
  const tag = match[3];
  const language = !tag ? undefined : /KOR|한/.test(tag) ? 'ko' : 'en';
  return { base: match[2] ? `${match[1]} ${match[2]}` : match[1], family, language };
}

/**
 * Join the syllables a score splits a word into — "exal - tation", "Ho - ly",
 * "wor - thy" — leaving a real dash at the end of a line alone. Korean held
 * syllables ("부활의 - 주", "같-은") are not joined here: whether a word
 * break sits under the dash is the spacing model's call.
 */
export function joinSplitWords(text: string): string {
  return text.replace(/([A-Za-z'’])\s*-\s+(?=[A-Za-z])/g, '$1').replace(/([A-Za-z'’])\s+-\s*(?=[A-Za-z])/g, '$1');
}

// ---- Korean spacing -------------------------------------------------------

/**
 * Syllables that almost always close a word rather than open one — particles
 * and verb endings. Used only when the corpus has never seen the two
 * syllables side by side.
 */
const BOUND_SYLLABLES = new Set(
  '은는을를이가의에께로으과와도고며면네요죠서니리라랑셨신심소해게어여야지기던든된워줘였었았겠까며처듯뿐만'.split(''),
);

function syllables(text: string): string[] {
  return [...text].filter((char) => HANGUL_SYLLABLE.test(char));
}

/**
 * Learn Korean word breaks from lines whose spacing is trusted: how often two
 * syllables sit together inside a word, and how often the first ends a word
 * the second opens. An open gap gets a space when the corpus has seen that
 * pair apart more often than together; a pair it has never seen is joined
 * only when the second syllable is a particle or an ending.
 */
export function createSpacingModel(corpus: string[]): SpacingModel {
  const together = new Map<string, number>();
  const apart = new Map<string, number>();
  const add = (map: Map<string, number>, key: string) => map.set(key, (map.get(key) ?? 0) + 1);
  for (const line of corpus) {
    const words = line.split(/\s+/).map(syllables).filter((word) => word.length > 0);
    words.forEach((word, index) => {
      for (let k = 0; k + 1 < word.length; k++) add(together, word[k] + word[k + 1]);
      const next = words[index + 1];
      if (next) add(apart, word[word.length - 1] + next[0]);
    });
  }
  return (left, right) => {
    const a = syllables(left).pop();
    const b = syllables(right)[0];
    if (!a || !b) return true;
    const joined = together.get(a + b) ?? 0;
    const spaced = apart.get(a + b) ?? 0;
    if (joined + spaced > 0) return spaced > joined;
    return !BOUND_SYLLABLES.has(b);
  };
}

/** Close every open gap of a line with the model, left to right. */
function settleGaps(line: string, spacing: SpacingModel): string {
  if (!line.includes(OPEN_GAP)) return line;
  const parts = line.split(OPEN_GAP);
  let text = parts[0];
  for (let index = 1; index < parts.length; index++) {
    text += (spacing(text, parts[index]) ? ' ' : '') + parts[index];
  }
  return clean(text);
}

// ---- lines ---------------------------------------------------------------

function normalizedLine(line: string): string {
  return line.toLowerCase().replace(/\(x\d+\)/g, '').replace(/[^0-9a-z가-힣]+/g, '');
}

/**
 * Write a block the sheet repeats three or more times in a row once, marked
 * with how often it is sung — "좌정하사 다스리소서 (x4)", as last year's slides
 * did. Twice is left as written: a chorus sung "A B A B" reads better whole.
 */
export function collapseRepeats(lines: string[]): string[] {
  const out: string[] = [];
  let index = 0;
  while (index < lines.length) {
    let best: { size: number; times: number } | null = null;
    for (let size = 1; size <= 4 && index + size * 3 <= lines.length; size++) {
      const block = lines.slice(index, index + size).map(normalizedLine);
      if (block.some((line) => !line)) continue;
      let times = 1;
      while (
        index + (times + 1) * size <= lines.length &&
        lines
          .slice(index + times * size, index + (times + 1) * size)
          .every((line, offset) => normalizedLine(line) === block[offset])
      ) {
        times += 1;
      }
      if (times >= 3 && (!best || times * size > best.times * best.size)) best = { size, times };
    }
    if (best) {
      const block = lines.slice(index, index + best.size);
      out.push(...block.slice(0, -1), `${block[block.length - 1]} (x${best.times})`);
      index += best.size * best.times;
    } else {
      out.push(lines[index]);
      index += 1;
    }
  }
  return out;
}

/** Korean lines this short (in syllables) are a phrase, not a slide line. */
const SHORT_KOREAN_LINE = 4;

/**
 * A Korean translation is often written in short phrases, one under each
 * English phrase ("사랑해요" / "신실하신 나의 주님"). A phrase that short is
 * joined to the line after it — or, at the end of a part, the line before —
 * so a slide carries whole sentences rather than a column of fragments.
 */
export function joinShortKoreanLines(lines: string[]): string[] {
  const out: string[] = [];
  let carry = '';
  for (const line of lines) {
    const text = carry ? `${carry} ${line}` : line;
    carry = '';
    if (syllables(text).length <= SHORT_KOREAN_LINE && !/\(x\d+\)$/.test(text)) carry = text;
    else out.push(text);
  }
  if (carry) {
    if (out.length > 0) out[out.length - 1] = `${out[out.length - 1]} ${carry}`;
    else out.push(carry);
  }
  return out;
}

interface RawLine {
  text: string;
  /** Right edge of the row it was read from, to tell a wrapped line. */
  right: number;
}

interface RawSection {
  heading: Heading;
  lines: RawLine[];
  /** Normalized lines that opened with a numbered-ending mark, to drop a repeat. */
  endings: Set<string>;
}

interface SongDraft {
  title: string;
  altTitle?: string;
  key?: string;
  pages: number[];
  sections: RawSection[];
}

/** Header rows (title … Key line) at the top of a page that opens a song. */
function readHeader(rows: Row[]): { title: string; altTitle?: string; key?: string; bottom: number } | null {
  // Only the top of the page can hold a header.
  const top = rows.slice(0, 8);
  const keyIndex = top.findIndex((row) => KEY_LINE.test(row.text));
  if (keyIndex <= 0) return null;
  const header = top.slice(0, keyIndex + 1);
  const biggest = Math.max(...header.map((row) => row.size));
  const titleRows = header.filter((row) => row.size >= biggest - 0.5);
  const rawTitle = clean(titleRows.map((row) => row.text).join(' '));
  const alt = /^(.*?\S)\s*[(（]([^()（）]+)[)）]\s*$/.exec(rawTitle);
  return {
    title: alt ? alt[1].trim() : rawTitle,
    ...(alt ? { altTitle: alt[2].trim() } : {}),
    key: KEY_LINE.exec(top[keyIndex].text)?.[1].replace('♯', '#').replace('♭', 'b'),
    bottom: top[keyIndex].y,
  };
}

/**
 * Rebuild one lyric row. A gap between two Korean syllables that the chord
 * above could have set — or a held-syllable dash between them — is left open
 * for the spacing model; every other gap is a space.
 */
function lyricText(row: Row, chords: PositionedText[]): string {
  const pieces: PositionedText[] = [];
  const dashes = new Set<PositionedText>();
  row.pieces.forEach((piece, index) => {
    const before = row.pieces[index - 1]?.str ?? '';
    const after = row.pieces[index + 1]?.str ?? '';
    // "부활의 - 주": a dash that only holds a Korean syllable is not text.
    if (/^\s*[-–]\s*$/.test(piece.str) && HANGUL_SYLLABLE.test(before.slice(-1)) && HANGUL_SYLLABLE.test(after[0] ?? '')) {
      dashes.add(row.pieces[index + 1]);
      return;
    }
    pieces.push(piece);
  });
  return joinPieces(pieces, (left, right) => {
    const korean = HANGUL_SYLLABLE.test(left.str.slice(-1)) && HANGUL_SYLLABLE.test(right.str[0] ?? '');
    if (!korean) return ' ';
    if (dashes.has(right)) return OPEN_GAP;
    // A syllable a chord is written over was placed for the chord.
    if (chords.some((chord) => Math.abs(chord.x - right.x) < 0.5)) return OPEN_GAP;
    const reach = chords
      .filter((chord) => chord.x < right.x - 0.5)
      .reduce((end, chord) => Math.max(end, chord.x + chord.width), -Infinity);
    return right.x - reach < CHORD_REACH * right.size ? OPEN_GAP : ' ';
  });
}

/**
 * Rebuild the songs of a chord-sheet PDF from its pages' positioned text.
 * Returns null when the PDF is not a chord sheet (no page opens with a song
 * header, or nothing reads as lyrics), so an ordinary 콘티 is left to the
 * cover and 악보 readers.
 */
export function parseChordSheet(pages: PositionedPage[], options: ChordSheetOptions = {}): ChordSheetSong[] | null {
  const songs: SongDraft[] = [];
  let current: SongDraft | null = null;
  let section: RawSection | null = null;

  pages.forEach((page, pageIndex) => {
    const items = page.items.filter((item) => item.str.trim() && Number.isFinite(item.x) && Number.isFinite(item.y));
    if (items.length === 0) return;

    // Header and footer are read across the full width.
    const fullRows = rowsOf(items);
    const header = readHeader(fullRows);
    const footer = fullRows.find((row) => FOOTER_START.test(row.text));
    const top = header ? header.bottom - 0.5 : Infinity;
    const bottom = footer ? footer.y + 0.5 : -Infinity;

    if (header) {
      current = { title: header.title, altTitle: header.altTitle, key: header.key, pages: [], sections: [] };
      songs.push(current);
      section = null;
    }
    const song: SongDraft | null = current;
    if (!song) return;
    song.pages.push(pageIndex + 1);

    const body = items.filter((item) => item.y < top && item.y > bottom);
    const middle = page.width / 2;
    for (const column of [body.filter((item) => item.x < middle), body.filter((item) => item.x >= middle)]) {
      const rows = rowsOf(column);
      if (rows.length === 0) continue;
      const chordRows = rows.filter((row) => isChordRow(clean(row.text.replace(DIRECTION, ' '))));
      const columnLeft = Math.min(...rows.map((row) => row.left));
      const columnRight = Math.max(...rows.map((row) => row.right));
      let openDirection = false;
      for (const row of rows) {
        if (chordRows.includes(row)) continue;
        const heading = parseSheetHeading(row.text);
        if (heading) {
          section = { heading, lines: [], endings: new Set() };
          song.sections.push(section);
          openDirection = false;
          continue;
        }
        // The chords printed over this row: the chord rows just above it.
        const chords = chordRows
          .filter((chordRow) => chordRow.y > row.y && chordRow.y - row.y < 2.2 * row.size)
          .flatMap((chordRow) => chordRow.pieces);
        let text = lyricText(row, chords);
        // The tail of a direction that wrapped from the row above: "Pre-Ch.)".
        if (openDirection) {
          openDirection = false;
          const close = /^[^()]{0,24}\)/.exec(text);
          if (close) text = text.slice(close[0].length);
        }
        text = clean(
          text.replace(DIRECTION, (match) => {
            if (!match.endsWith(')')) openDirection = true;
            return ' ';
          }),
        );
        if (!text || isChordRow(text.replaceAll(OPEN_GAP, ' ')) || !/\p{L}/u.test(text)) continue;
        const ending = ENDING_MARK.exec(text);
        const line = clean(joinSplitWords(text.slice(ending ? ending[0].length : 0)));
        if (!/\p{L}/u.test(line)) continue;
        if (!section) {
          // Lyrics before any heading: the song's first part, unnamed.
          section = { heading: { base: 'VERSE', family: 'V' }, lines: [], endings: new Set() };
          song.sections.push(section);
        }
        if (ending) {
          // Endings (1.) and (2.) often sing the same words: keep them once.
          const key = normalizedLine(line.replaceAll(OPEN_GAP, ''));
          if (section.endings.has(key)) continue;
          section.endings.add(key);
        }
        // A column too narrow for a line wraps it: the rest starts in lower
        // case, or the line broke after a word no line ends on ("'cause").
        const previous = section.lines[section.lines.length - 1];
        if (
          previous &&
          (/^[a-z]/.test(line) || DANGLING_WORD.test(previous.text)) &&
          !HANGUL.test(previous.text) &&
          !HANGUL.test(line) &&
          previous.right > columnLeft + 0.7 * (columnRight - columnLeft)
        ) {
          previous.text = `${previous.text} ${line}`;
          previous.right = row.right;
          continue;
        }
        section.lines.push({ text: line, right: row.right });
      }
    }
  });

  // Korean spacing is learned from the corpus and from the sheet itself:
  // every word break it printed unambiguously is evidence too.
  const own = songs.flatMap((song) =>
    song.sections.flatMap((draft) => draft.lines.flatMap((line) => line.text.split(OPEN_GAP))),
  );
  const spacing = createSpacingModel([...(options.corpus ?? []), ...own]);
  const result = songs.map((draft) => toSong(draft, spacing)).filter((song) => song.parts.length > 0);
  return result.length > 0 ? result : null;
}

/**
 * "(부르신 곳에서)" closing a bridge only leads back into the chorus that
 * starts with those words; it is sung as the chorus, not on the bridge's slide.
 */
function dropLeadIn(lines: string[], firstLines: string[], partIndex: number): string[] {
  const last = lines[lines.length - 1];
  const inner = last && /^\((.+)\)$/.exec(last.trim());
  if (!inner) return lines;
  const lead = normalizedLine(inner[1]);
  const leadsIn = lead.length >= 2 && firstLines.some((first, index) => index !== partIndex && first.startsWith(lead));
  return leadsIn ? lines.slice(0, -1) : lines;
}

/** An English line of one word ("Jesus") ends the line before it. */
function joinSingleWords(lines: string[]): string[] {
  const out: string[] = [];
  for (const line of lines) {
    if (out.length > 0 && !/\s/.test(line.trim()) && !/\(x\d+\)$/.test(out[out.length - 1])) {
      out[out.length - 1] = `${out[out.length - 1]} ${line}`;
    } else {
      out.push(line);
    }
  }
  return out;
}

/** The text a part repeats, or the text itself: "ABAB" → "AB". */
function shortestPeriod(text: string): string {
  for (let size = 1; size < text.length; size++) {
    if (text.length % size === 0 && text === text.slice(0, size).repeat(text.length / size)) return text.slice(0, size);
  }
  return text;
}

function toSong(draft: SongDraft, spacing: SpacingModel): ChordSheetSong {
  // "VERSE 1" and "VERSE 1 (KOREAN)" are one part in two languages.
  const merged: { heading: Heading; ko: string[]; en: string[] }[] = [];
  for (const section of draft.sections) {
    const lines = section.lines.map((line) => settleGaps(line.text, spacing)).filter(Boolean);
    if (lines.length === 0) continue;
    const ko = section.heading.language === 'en' ? [] : lines.filter((line) => HANGUL.test(line));
    const en = section.heading.language === 'ko' ? [] : lines.filter((line) => !HANGUL.test(line));
    const partner = section.heading.language
      ? merged.find((part) => part.heading.base === section.heading.base)
      : undefined;
    if (partner) {
      if (partner.ko.length === 0) partner.ko = ko;
      if (partner.en.length === 0) partner.en = en;
      continue;
    }
    merged.push({ heading: section.heading, ko, en });
  }

  const counts = new Map<string, number>();
  const seen = new Set<string>();
  const parts: ChordSheetPart[] = [];
  const firstLines = merged.map((part) => normalizedLine(part.ko[0] ?? part.en[0] ?? ''));
  for (const [index, part] of merged.entries()) {
    const ko = joinShortKoreanLines(collapseRepeats(dropLeadIn(part.ko, firstLines, index)));
    const en = joinSingleWords(collapseRepeats(dropLeadIn(part.en, firstLines, index)));
    if (ko.length === 0 && en.length === 0) continue;
    // An ending that only repeats the intro (or any earlier part) adds no slide.
    // Compared as text, so a line the column wrapped differently still matches.
    const content = `${shortestPeriod(ko.map(normalizedLine).join(''))}|${shortestPeriod(en.map(normalizedLine).join(''))}`;
    if (seen.has(content)) continue;
    seen.add(content);
    const occurrence = (counts.get(part.heading.family) ?? 0) + 1;
    counts.set(part.heading.family, occurrence);
    parts.push({
      label: occurrence === 1 ? part.heading.family : `${part.heading.family}${occurrence}`,
      heading: part.heading.base,
      ko,
      en,
    });
  }
  return {
    title: draft.title,
    ...(draft.altTitle ? { altTitle: draft.altTitle } : {}),
    ...(draft.key ? { key: draft.key } : {}),
    pages: draft.pages,
    parts,
  };
}

// ---- songs for the lyric editor --------------------------------------------

/** One projected slide of a sheet song: its Korean and the English under it. */
export interface SheetSlide {
  ko: string[];
  en: string[];
}

/** At most this many Korean lines — and English lines — on a bilingual slide. */
const BILINGUAL_KO_LINES = 3;
const BILINGUAL_EN_LINES = 4;
/** A part in one language is split like the Sunday deck splits it. */
const SINGLE_LANGUAGE_LINES = 4;

/** `count` groups as equal in size as possible, the longer ones first. */
function splitInto<T>(items: T[], count: number): T[][] {
  const groups: T[][] = [];
  let start = 0;
  for (let index = 0; index < count; index++) {
    const size = Math.floor(items.length / count) + (index < items.length % count ? 1 : 0);
    groups.push(items.slice(start, start + size));
    start += size;
  }
  return groups.filter((group) => group.length > 0);
}

/** How much of a line there is to read — letters, not spaces or marks. */
function weight(line: string): number {
  return Math.max(1, line.replace(/[^\p{L}\p{N}]/gu, '').length);
}

/**
 * Cut `lines` into as many groups as `fractions` has cut points, each cut at
 * the line boundary nearest that fraction of the text — so the second
 * language follows the first by how far into the part it has read, not by
 * line count (a Korean translation is often written in more, shorter lines).
 */
function cutAtFractions(lines: string[], fractions: number[]): string[][] {
  const total = lines.reduce((sum, line) => sum + weight(line), 0);
  const cumulative: number[] = [];
  lines.reduce((sum, line) => {
    cumulative.push((sum + weight(line)) / total);
    return sum + weight(line);
  }, 0);
  const groups: string[][] = [];
  let start = 0;
  fractions.forEach((fraction, index) => {
    const remaining = fractions.length - index;
    if (start >= lines.length) {
      groups.push([]);
      return;
    }
    let best = start + 1;
    for (let end = start + 1; end <= lines.length - remaining; end++) {
      if (Math.abs(cumulative[end - 1] - fraction) < Math.abs(cumulative[best - 1] - fraction)) best = end;
    }
    groups.push(lines.slice(start, best));
    start = best;
  });
  groups.push(lines.slice(start));
  return groups;
}

/**
 * The slides a part is projected on. A part in both languages keeps each
 * slide's English with its Korean: the English is split evenly and the Korean
 * cut where it has said as much — so 4 Korean lines over 8 English lines
 * become two slides of 2 + 4, as last year's deck set 주 하나님 지으신 모든 세계.
 */
export function slidesOfPart(part: Pick<ChordSheetPart, 'ko' | 'en'>): SheetSlide[] {
  const { ko, en } = part;
  if (ko.length === 0 || en.length === 0) {
    const lines = ko.length > 0 ? ko : en;
    return splitInto(lines, Math.ceil(lines.length / SINGLE_LANGUAGE_LINES)).map((group) =>
      ko.length > 0 ? { ko: group, en: [] } : { ko: [], en: group },
    );
  }
  const count = Math.min(
    ko.length,
    Math.max(Math.ceil(ko.length / BILINGUAL_KO_LINES), Math.ceil(en.length / BILINGUAL_EN_LINES)),
  );
  // The English leads when it can fill every slide; otherwise the Korean does.
  const englishLeads = en.length >= count;
  const lead = splitInto(englishLeads ? en : ko, count);
  const leadTotal = lead.flat().reduce((sum, line) => sum + weight(line), 0);
  const fractions: number[] = [];
  lead.slice(0, -1).reduce((sum, group) => {
    const next = sum + group.reduce((groupSum, line) => groupSum + weight(line), 0);
    fractions.push(next / leadTotal);
    return next;
  }, 0);
  const follow = cutAtFractions(englishLeads ? ko : en, fractions);
  return lead.map((group, index) =>
    englishLeads ? { ko: follow[index] ?? [], en: group } : { ko: group, en: follow[index] ?? [] },
  );
}

/** True when the sheet prints the song in both languages. */
export function isBilingualSheetSong(sheet: ChordSheetSong): boolean {
  return sheet.parts.some((part) => part.ko.length > 0) && sheet.parts.some((part) => part.en.length > 0);
}

export interface SheetSongOptions {
  id: string;
  /** Lines per slide for a song sung in one language. */
  linesPerSlide: number;
  /**
   * Split a bilingual song into slides that keep each part's English with its
   * Korean (the 찬양집회 deck). Otherwise only the Korean is kept — or the
   * English, for a part or a song written only in English.
   */
  bilingual: boolean;
}

/**
 * A sheet song as the lyric editor's Song, plus the slides it will be
 * projected on. For a bilingual deck every slide is its own blank-line block,
 * so the planner splits the Korean exactly where the English was divided.
 */
export function songFromChordSheet(
  sheet: ChordSheetSong,
  options: SheetSongOptions,
): { song: Song; slides: SheetSlide[] } {
  const bilingual = options.bilingual && isBilingualSheetSong(sheet);
  const slides: SheetSlide[] = [];
  const sections: Section[] = [];
  let longest = 0;
  for (const part of sheet.parts) {
    if (bilingual) {
      const partSlides = slidesOfPart(part);
      slides.push(...partSlides);
      const blocks = partSlides.map((slide) => (slide.ko.length > 0 ? slide.ko : slide.en));
      longest = Math.max(longest, ...blocks.map((block) => block.length));
      sections.push({ label: part.label, lines: blocks.flatMap((block, index) => (index > 0 ? ['', ...block] : block)) });
    } else {
      const lines = part.ko.length > 0 ? part.ko : part.en;
      if (lines.length === 0) continue;
      sections.push({ label: part.label, lines: [...lines] });
      slides.push({ ko: part.ko.length > 0 ? [...lines] : [], en: part.ko.length > 0 ? [] : [...lines] });
    }
  }
  return {
    song: {
      id: options.id,
      title: sheet.title,
      ...(sheet.key ? { key: sheet.key } : {}),
      sections,
      order: sections.map((section) => section.label),
      linesPerSlide: bilingual ? Math.max(options.linesPerSlide, longest) : Math.max(options.linesPerSlide, SINGLE_LANGUAGE_LINES),
      ...(sheet.pages.length > 0 ? { pageIndex: sheet.pages[0] } : {}),
      verification: 'draft',
    },
    slides,
  };
}

/** Does a page's text look like a chord sheet's (a `Key - D | Time` line)? */
export function looksLikeChordSheetText(text: string): boolean {
  return text.split(/\r?\n/).some((line) => KEY_LINE.test(line.trim())) && /CCLI|ChordPro|SongSelect/i.test(text);
}
