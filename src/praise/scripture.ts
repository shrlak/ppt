// 말씀 slides for a 기도: the typed passage read in 개역개정 and NASB, one
// verse a slide, spelled the way last year's 말씀 slides print it —
// "사도행전 1장 3-5, 8절" over "Acts 1:3-5, 8" in the corner, and each verse
// as "사도행전 1장 3절" over "Acts 1:3".
//
// A passage can be typed the Korean way ("사도행전 1장 3-5, 8절", "행1:3-5,8")
// or the English way ("Acts 1:3-5, 8"); a bare verse after a comma stays in
// the book and chapter before it.
import { getVerseRange, getVerseUnits, lastVerseOf } from '../bible/bibleData';
import { BIBLE_BOOKS } from '../bible/books';
import { normalizeContiScripture, parseVerseInput } from '../bible/refParser';
import type { BibleRef, BookChapters, Verse } from '../bible/types';
import type { PraisePassage, PraiseVerse } from './types';

export const PRAISE_TRANSLATIONS = { ko: 'nkrv', en: 'nasb' } as const;
/** One slide a verse: a passage longer than this is almost certainly a typo ("시119"). */
export const MAX_PASSAGE_VERSES = 50;

type Bible = Map<number, BookChapters>;
export type BibleLoader = (translation: string) => Promise<Bible>;

/** English names the deck's books go by, besides BIBLE_BOOKS' own. */
const ENGLISH_ALIASES: Record<string, number> = { psalm: 19, 'song of songs': 22 };

const ENGLISH_NAMES = [
  ...BIBLE_BOOKS.map((book) => ({ name: book.nameEn.toLowerCase(), id: book.id })),
  ...Object.entries(ENGLISH_ALIASES).map(([name, id]) => ({ name, id })),
].sort((a, b) => b.name.length - a.name.length);

function abbrOf(bookId: number): string {
  return BIBLE_BOOKS.find((book) => book.id === bookId)!.abbrKo[0];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** "Acts 1:3" → "행 1:3": English book names as the Korean parser's abbreviations. */
function koreanBookNames(input: string): string {
  let value = input;
  for (const { name, id } of ENGLISH_NAMES) {
    value = value.replace(new RegExp(`(^|[^A-Za-z0-9])${escapeRegExp(name)}(?![A-Za-z])`, 'gi'), `$1${abbrOf(id)} `);
  }
  return value;
}

/**
 * Parse a typed passage. A token with no book ("8", "2:1-4") continues the
 * reference before it: "행1:3-5 8" is 행1:3-5 and 행1:8.
 */
export function parsePraisePassage(input: string): { refs: BibleRef[]; invalidTokens: string[] } {
  const text = input.trim();
  if (!text) return { refs: [], invalidTokens: [] };
  // Split at commas first: the conti normalizer would run "3-5, 8절" together.
  const tokens = koreanBookNames(text)
    .split(/[,，;；]/)
    .flatMap((part) => normalizeContiScripture(part).split(/\s+/))
    .filter(Boolean);
  const refs: BibleRef[] = [];
  const invalidTokens: string[] = [];
  for (const token of tokens) {
    let candidate = token;
    const previous = refs[refs.length - 1];
    if (previous && /^\d/.test(token)) {
      const abbr = abbrOf(previous.bookId);
      // A verse (or verse range) alone stays in the chapter before it.
      candidate = /^\d+(-\d+)?$/.test(token) && previous.endVerse !== undefined
        ? `${abbr}${previous.endChapter}:${token}`
        : `${abbr}${token}`;
    }
    // A book alone ("사도행전") would be all of it; a passage names a chapter.
    const [ref] = /\d/.test(candidate) ? parseVerseInput(candidate).refs : [];
    if (ref && Number.isFinite(ref.startChapter)) refs.push(ref);
    else invalidTokens.push(token);
  }
  return { refs, invalidTokens };
}

/** 시편 counts its chapters in 편; every other book in 장. */
function chapterUnit(bookId: number): string {
  return bookId === 19 ? '편' : '장';
}

function verseNumbers(verse: Verse): string {
  const last = lastVerseOf(verse);
  return last === verse.verse ? `${verse.verse}` : `${verse.verse}-${last}`;
}

/** One verse's own reference: "사도행전 1장 3절" / "Acts 1:3". */
export function verseRefs(ref: BibleRef, verse: Verse): { ko: string; en: string } {
  const numbers = verseNumbers(verse);
  return {
    ko: `${ref.ko} ${verse.chapter}${chapterUnit(ref.bookId)} ${numbers}절`,
    en: `${ref.en} ${verse.chapter}:${numbers}`,
  };
}

interface Span {
  ref: BibleRef;
  first: Verse;
  last: Verse;
}

/**
 * The whole passage in one line each: "사도행전 1장 3-5, 8절" and
 * "Acts 1:3-5, 8". Spans in one chapter share it; a span over two chapters
 * reads "1장 3절-2장 4절" / "1:3-2:4"; another book starts its own part.
 */
export function passageRanges(spans: Span[]): { ko: string; en: string } {
  const books: { ref: BibleRef; chapters: { chapter: number; ko: string[]; en: string[] }[] }[] = [];
  for (const { ref, first, last } of spans) {
    const lastVerse = lastVerseOf(last);
    let book = books[books.length - 1];
    if (!book || book.ref.bookId !== ref.bookId) {
      book = { ref, chapters: [] };
      books.push(book);
    }
    const unit = chapterUnit(ref.bookId);
    if (first.chapter !== last.chapter) {
      book.chapters.push({
        chapter: -1,
        ko: [`${first.chapter}${unit} ${first.verse}절-${last.chapter}${unit} ${lastVerse}절`],
        en: [`${first.chapter}:${first.verse}-${last.chapter}:${lastVerse}`],
      });
      continue;
    }
    const verses = first.verse === lastVerse ? `${first.verse}` : `${first.verse}-${lastVerse}`;
    const chapter = book.chapters[book.chapters.length - 1];
    if (chapter && chapter.chapter === first.chapter) {
      chapter.ko.push(verses);
      chapter.en.push(verses);
    } else {
      book.chapters.push({ chapter: first.chapter, ko: [verses], en: [verses] });
    }
  }
  const ko = books
    .map(({ ref, chapters }) =>
      `${ref.ko} ${chapters
        .map((part) => (part.chapter < 0 ? part.ko[0] : `${part.chapter}${chapterUnit(ref.bookId)} ${part.ko.join(', ')}절`))
        .join(', ')}`,
    )
    .join(', ');
  const en = books
    .map(({ ref, chapters }) =>
      `${ref.en} ${chapters.map((part) => (part.chapter < 0 ? part.en[0] : `${part.chapter}:${part.en.join(', ')}`)).join('; ')}`,
    )
    .join('; ');
  return { ko, en };
}

/** Verse texts joined into one; a verse the translation leaves out adds nothing. */
function joinTexts(verses: Verse[]): string {
  return verses
    .map((verse) => verse.text)
    .filter(Boolean)
    .join(' ');
}

/**
 * Read a typed passage in 개역개정 and NASB: one entry per verse 개역개정
 * prints (a joined "18-19" is one, with the English of both verses). Null
 * when nothing in the input is a passage; throws in Korean when it names
 * verses the Bible does not have.
 */
export async function resolvePraisePassage(input: string, load: BibleLoader): Promise<PraisePassage | null> {
  const { refs } = parsePraisePassage(input);
  if (refs.length === 0) return null;
  const [ko, en] = await Promise.all([load(PRAISE_TRANSLATIONS.ko), load(PRAISE_TRANSLATIONS.en)]);
  const verses: PraiseVerse[] = [];
  const spans: Span[] = [];
  for (const ref of refs) {
    const units = getVerseUnits(ko, ref.bookId, ref.startChapter, ref.startVerse, ref.endChapter, ref.endVerse);
    if (units.length === 0) continue;
    spans.push({ ref, first: units[0], last: units[units.length - 1] });
    for (const unit of units) {
      const english = getVerseRange(en, ref.bookId, unit.chapter, unit.verse, unit.chapter, lastVerseOf(unit));
      const names = verseRefs(ref, unit);
      verses.push({ refKo: names.ko, refEn: names.en, ko: unit.text, en: joinTexts(english) });
    }
  }
  if (verses.length === 0) throw new Error('해당 구절을 찾을 수 없습니다.');
  if (verses.length > MAX_PASSAGE_VERSES) {
    throw new Error(`${verses.length}절은 너무 깁니다. 한 번에 ${MAX_PASSAGE_VERSES}절까지 넣을 수 있습니다.`);
  }
  const ranges = passageRanges(spans);
  return { rangeKo: ranges.ko, rangeEn: ranges.en, verses };
}
