// The text that goes into the 수요예배 template's placeholders: the two date
// spellings the deck uses, the long-form passage reference, the download file
// name, and the substitution itself.
import type { BibleRef, Verse } from '../bible/types';

/** Parse a YYYY-MM-DD input as a local date, so the day never shifts a timezone. */
export function parseServiceDate(date: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date.trim());
  if (!match) return null;
  const [, year, month, day] = match;
  const parsed = new Date(Number(year), Number(month) - 1, Number(day));
  if (
    parsed.getFullYear() !== Number(year) ||
    parsed.getMonth() !== Number(month) - 1 ||
    parsed.getDate() !== Number(day)
  ) {
    return null;
  }
  return parsed;
}

/** 표지 spelling: "2026년 9월 16일". */
export function formatDateKo(date: string): string {
  const parsed = parseServiceDate(date);
  if (!parsed) return '';
  return `${parsed.getFullYear()}년 ${parsed.getMonth() + 1}월 ${parsed.getDate()}일`;
}

/** 인트로 spelling: "2026. 9. 16". */
export function formatDateDot(date: string): string {
  const parsed = parseServiceDate(date);
  if (!parsed) return '';
  return `${parsed.getFullYear()}. ${parsed.getMonth() + 1}. ${parsed.getDate()}`;
}

/** The Wednesday on or after `date` — mirrors pptxBuilder's sundayOnOrAfter. */
export function wednesdayOnOrAfter(date: Date): Date {
  const wednesday = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  wednesday.setDate(wednesday.getDate() + ((3 - wednesday.getDay() + 7) % 7));
  return wednesday;
}

/**
 * Download name: that week's Wednesday as MMDD.pptx — the convention the
 * church's own files use (`0916.pptx` for 2026-09-16). A date that is already
 * a Wednesday is kept; anything else snaps forward to the coming Wednesday,
 * and no date at all means the next one from today.
 */
export function suggestWednesdayFileName(date?: string, today = new Date()): string {
  const source = (date ? parseServiceDate(date) : null) ?? today;
  const wednesday = wednesdayOnOrAfter(source);
  const month = String(wednesday.getMonth() + 1).padStart(2, '0');
  const day = String(wednesday.getDate()).padStart(2, '0');
  return `${month}${day}.pptx`;
}

/** 시편 counts its chapters in 편; every other book in 장. */
export function chapterUnit(bookId: number): '편' | '장' {
  return bookId === 19 ? '편' : '장';
}

/**
 * The reference as the deck spells it: "시편 18편 1-12절", not the
 * "시편 18:1-12" form the Sunday slides use (see versePlanner.formatRange).
 */
export function formatRangeKoLong(ref: BibleRef, first: Verse, last: Verse): string {
  const unit = chapterUnit(ref.bookId);
  if (first.chapter !== last.chapter) {
    return `${ref.ko} ${first.chapter}${unit} ${first.verse}절-${last.chapter}${unit} ${last.verse}절`;
  }
  if (first.verse === last.verse) {
    return `${ref.ko} ${first.chapter}${unit} ${first.verse}절`;
  }
  return `${ref.ko} ${first.chapter}${unit} ${first.verse}-${last.verse}절`;
}

/** The whole passage's reference, across however many refs were entered. */
export function formatRangeFromVerses(refs: BibleRef[], verses: Verse[]): string {
  if (refs.length === 0 || verses.length === 0) return '';
  return formatRangeKoLong(refs[0], verses[0], verses[verses.length - 1]);
}

export function xmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Replace {{TOKEN}} placeholders in a slide's XML.
 *
 * The values are user-typed, so they go in through a replacer function: a
 * string replacement would let `$&` or `$'` in a sermon title splice parts of
 * the XML back into itself. Tokens with no value are cleared rather than left
 * showing their braces on the projector.
 */
export function substituteTokens(xml: string, values: Record<string, string | undefined>): string {
  return xml.replace(/\{\{([A-Z_]+)\}\}/g, (whole, name: string) => {
    if (!(name in values)) return whole;
    return xmlEscape(values[name] ?? '');
  });
}

/** Clear any placeholder no one filled in, so none reaches the screen. */
export function clearRemainingTokens(xml: string): string {
  return xml.replace(/\{\{[A-Z_]+\}\}/g, '');
}
