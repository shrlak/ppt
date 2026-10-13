// A song whose 악보 runs over more than one page of the conti.
//
// The cover (or the 카톡 공지) lists the songs, and each takes one 악보 page.
// A score printed over two pages — or, on a 찬양집회 conti, a song sung in two
// languages and printed once in each — leaves the conti with more pages than
// the list has songs, and those pages used to be set aside unread. Once the
// models have read every page's title, each such page goes to the song it
// belongs to and is read along with it:
//  - a page printing a listed song's title (its Korean title, or the English
//    one the conti gives beside it) is that song's;
//  - a page with no title, right after a song's page, carries on its score;
//  - on a 찬양집회 conti, a page titled in English only, next to a Korean
//    song's page, is that song in English.
// A page with a title of its own that no listed song carries is another
// song — a Plan B song, a score the order leaves out — and stays out.
import type { ParsedScore } from '../ai/scoreParser';
import type { Section } from './types';
import { SAME_TITLE_THRESHOLD, isPlaceholderTitle, titleSimilarity } from './contiAlignment';
import { findSection } from './slidePlanner';

const HANGUL = /[가-힣]/;

export interface PageGroupingSong {
  /** The title the conti gives the song (Korean when it prints both). */
  title: string;
  /** The English title the conti prints beside it, when it does. */
  englishTitle?: string;
  /** The 악보 page the song holds. */
  page: number;
}

export interface PageGroupingInput {
  songs: PageGroupingSong[];
  /** 악보 pages no song holds. */
  spares: number[];
  /** Every 악보 page of the conti, in PDF order. */
  musicPages: number[];
  /** The title read off a page; undefined when none was. */
  titleOf: (page: number) => string | undefined;
  /** A page the title pass found to be no 악보 at all. */
  isNonScore?: (page: number) => boolean;
  /** 찬양집회: a song's 악보 in its other language is that song's too. */
  bilingual: boolean;
}

export interface PageGrouping {
  /** Each song's pages, the one carrying its (Korean) title first, then the rest in PDF order. */
  pages: number[][];
  /** Spare pages no song took. */
  unclaimed: number[];
}

/** A title printed in English only. */
function isEnglishTitle(title: string | undefined): boolean {
  return !!title?.trim() && /[A-Za-z]/.test(title) && !HANGUL.test(title);
}

/**
 * Give each spare page to the song it belongs to (see the file comment).
 *
 * A page with no title is only taken as the one before it carrying on when
 * the title pass read most of the songs' own pages: with no titles at all,
 * every leftover page would look like a continuation of the last song.
 */
export function groupContiPages(input: PageGroupingInput): PageGrouping {
  const { songs, spares, musicPages, titleOf, bilingual } = input;
  const isNonScore = input.isNonScore ?? (() => false);
  const pages: number[][] = songs.map((song) => [song.page]);
  const holder = new Map<number, number>();
  songs.forEach((song, index) => holder.set(song.page, index));

  const similarity = (song: PageGroupingSong, title: string | undefined) =>
    Math.max(titleSimilarity(song.title, title), titleSimilarity(song.englishTitle, title));
  const take = (song: number, page: number) => {
    pages[song].push(page);
    holder.set(page, song);
  };

  const pool = spares.filter((page) => !holder.has(page) && !isNonScore(page));

  // Its title printed again: the page is that song's, wherever it sits.
  const left: number[] = [];
  for (const page of pool) {
    const title = titleOf(page);
    let best = -1;
    let bestScore = 0;
    let bestDistance = Infinity;
    songs.forEach((song, index) => {
      if (isPlaceholderTitle(song.title)) return;
      const score = similarity(song, title);
      if (score < SAME_TITLE_THRESHOLD) return;
      // A song listed twice: the copy whose page comes closest before it.
      const distance = page > song.page ? page - song.page : songs.length * 1000 + song.page - page;
      if (score > bestScore || (score === bestScore && distance < bestDistance)) {
        best = index;
        bestScore = score;
        bestDistance = distance;
      }
    });
    if (best >= 0) take(best, page);
    else left.push(page);
  }

  const titled = songs.filter((song) => titleOf(song.page)?.trim()).length;
  const titlesRead = songs.length > 0 && titled * 2 >= songs.length;
  const hasEnglishPage = (song: number) => pages[song].some((page) => isEnglishTitle(titleOf(page)));
  // The page right beside it in the PDF: a 기도 page or a typed page between
  // two 악보 keeps them apart.
  const neighbour = (page: number, step: -1 | 1) => (musicPages.includes(page + step) ? page + step : undefined);
  /** The song holding `page`, when it is a Korean song with no English page yet. */
  const awaitingEnglish = (page: number | undefined) => {
    const song = page === undefined ? undefined : holder.get(page);
    if (song === undefined || !HANGUL.test(songs[song].title) || hasEnglishPage(song)) return undefined;
    return song;
  };

  // Carrying on from the page before it, in PDF order — so a score over three
  // pages chains on, each page taking the song of the one before.
  const unclaimed: number[] = [];
  const ordered = [...left].sort((a, b) => musicPages.indexOf(a) - musicPages.indexOf(b));
  for (const page of ordered) {
    const title = titleOf(page)?.trim();
    const before = neighbour(page, -1);
    if (!title) {
      const song = before === undefined ? undefined : holder.get(before);
      if (titlesRead && song !== undefined) {
        take(song, page);
        continue;
      }
    } else if (bilingual && isEnglishTitle(title)) {
      // The same song in English, printed after its Korean (or just before it).
      const song = awaitingEnglish(before) ?? awaitingEnglish(neighbour(page, 1));
      if (song !== undefined) {
        take(song, page);
        continue;
      }
    }
    unclaimed.push(page);
  }

  return {
    pages: pages.map((held, index) => {
      const song = songs[index];
      // The page printing the song's own title goes first: it is the one the
      // card shows, and the one a Korean reading is expected from.
      let main = held[0];
      let mainScore = titleSimilarity(song.title, titleOf(main));
      for (const page of held.slice(1)) {
        const score = titleSimilarity(song.title, titleOf(page));
        if (score >= SAME_TITLE_THRESHOLD && score > mainScore) {
          main = page;
          mainScore = score;
        }
      }
      const rest = held.filter((page) => page !== main).sort((a, b) => musicPages.indexOf(a) - musicPages.indexOf(b));
      return [main, ...rest];
    }),
    unclaimed: unclaimed.sort((a, b) => a - b),
  };
}

/** One card of a conti with no song list: one 악보 page, and what the title pass read off it. */
export interface UnlistedCard {
  page: number;
  /** The title read off the page (or the card's own name); undefined or a placeholder when none. */
  title?: string;
  /** The writers printed on the page, when they were read. */
  artist?: string;
  /** The English title printed beside a Korean one. */
  englishTitle?: string;
  /** The title pass found no 악보 on the page. */
  nonScore?: boolean;
}

export interface UnlistedFoldOptions {
  /** 찬양집회: a song's 악보 in its other language is that song's too. */
  bilingual: boolean;
  /** The English title a Korean song was saved with, when one was. */
  englishTitleOf?: (title: string) => string | undefined;
}

/** What a credit line says besides the names: `Words & Music by`, `천관웅 역`. */
const CREDIT_WORDS = /\b(?:words|music|lyrics|by|arr|arranged|translated|feat|featuring)\b|작사|작곡|편곡|번역|\s역\s*$/gi;

/** The names a page prints for its writers: `Paul Baloche/Lenny LeBlanc`, `Brandon Lake | Chris Brown`. */
function writerNames(artist: string | undefined): string[] {
  return (artist ?? '')
    .split(/[|,/&;·\n]|\band\b/i)
    .map((part) => part.toLowerCase().replace(CREDIT_WORDS, ' ').replace(/[^a-z가-힣]+/g, ''))
    .filter((name) => name.length >= 3);
}

/** Two pages that print a writer in common. */
export function sameWriters(a: string | undefined, b: string | undefined): boolean {
  const left = writerNames(a);
  const right = writerNames(b);
  // A longer credit line still names the writer: `Eugene Greco` in `Eugene Greco (Integrity)`.
  const within = (short: string, long: string) => short.length >= 6 && long.includes(short);
  return left.some((name) => right.some((other) => name === other || within(name, other) || within(other, name)));
}

/**
 * Cards made one per 악보 page — a conti with no cover or 카톡 공지 to list
 * its songs — that are one song. `cards` are in PDF page order; returns, for
 * each, the index of the card it belongs to (its own when it stands alone).
 *
 *  - the same title as the card just before it → that card's song;
 *  - no title, just after a card → the rest of that card's score (only when
 *    the title pass read most pages' titles: with none read, every page would
 *    look like one long song);
 *  - on a 찬양집회, a title in English only, just after (or before) a Korean
 *    card that has no English page yet → that song in English — but only
 *    when the two are shown to be one song: the same writers printed on both
 *    (`Eugene Greco` over 하늘 위에 주님밖에 and over God Is The Strength Of
 *    My Heart), or the English title the Korean page prints under its own or
 *    the Korean song was saved with. An
 *    English song that merely follows a Korean one (Hosanna after 예수
 *    우리들의 밝은 빛) stays a song of its own.
 *
 * "Just after" is the very next PDF page: a 기도 page, a typed page or a page
 * the models found no 악보 on keeps two cards apart.
 */
export function foldUnlistedPages(cards: UnlistedCard[], options: UnlistedFoldOptions): number[] {
  const heads = cards.map((_, index) => index);
  const titleOf = (card: UnlistedCard) => (isPlaceholderTitle(card.title) ? undefined : card.title?.trim());
  const scored = cards.filter((card) => !card.nonScore);
  const titlesRead = scored.length > 0 && scored.filter((card) => titleOf(card)).length * 2 >= scored.length;
  const withEnglish = new Set<number>();
  const adjacent = (before: number, after: number) =>
    !cards[before].nonScore && !cards[after].nonScore && cards[after].page === cards[before].page + 1;
  /** The Korean card `korean` and the English card `english` are one song. */
  const inEnglish = (korean: number, english: number) => {
    const ko = titleOf(cards[korean]);
    const en = titleOf(cards[english]);
    if (!options.bilingual || !ko || !en || !HANGUL.test(ko) || !isEnglishTitle(en) || withEnglish.has(korean)) return false;
    const known = [cards[korean].englishTitle, options.englishTitleOf?.(ko)];
    return (
      sameWriters(cards[korean].artist, cards[english].artist) ||
      known.some((title) => titleSimilarity(title, en) >= SAME_TITLE_THRESHOLD)
    );
  };

  for (let index = 1; index < cards.length; index++) {
    if (!adjacent(index - 1, index)) continue;
    const head = heads[index - 1];
    const title = titleOf(cards[index]);
    if (!title) {
      if (titlesRead && titleOf(cards[head])) heads[index] = head;
    } else if (
      titleSimilarity(titleOf(cards[index - 1]), title) >= SAME_TITLE_THRESHOLD ||
      titleSimilarity(titleOf(cards[head]), title) >= SAME_TITLE_THRESHOLD
    ) {
      heads[index] = head;
    } else if (inEnglish(head, index)) {
      heads[index] = head;
      withEnglish.add(head);
    }
  }
  // The English printed first, its Korean on the next page: the English song,
  // with any page carrying it on, joins the Korean one.
  for (let index = 0; index < cards.length; index++) {
    if (heads[index] !== index) continue;
    const last = heads.lastIndexOf(index);
    const next = last + 1;
    if (next >= cards.length || heads[next] !== next || !adjacent(last, next) || !inEnglish(next, index)) continue;
    heads.forEach((head, at) => {
      if (head === index) heads[at] = next;
    });
    withEnglish.add(next);
  }
  return heads;
}

/** What a page's lyrics are written in: Korean, English only, or nothing read. */
export function readingLanguage(score: ParsedScore): 'ko' | 'en' | 'none' {
  const lines = score.sections.flatMap((section) => section.lines).filter((line) => line.trim());
  if (lines.length === 0) return 'none';
  return lines.some((line) => HANGUL.test(line)) ? 'ko' : 'en';
}

function lineKey(line: string): string {
  return line.toLowerCase().replace(/[^0-9a-zㄱ-ㆎ가-힣]+/g, '');
}

/**
 * The readings of one song's pages as one score, its main page's first.
 *
 * A part only on a later page is added; a part a later page prints again
 * (the chorus written out once more) adds nothing; a part a later page
 * carries on (the verse broken over the page) gets those lines after its
 * own. The 진행 순서, title and key are the first page's that has them.
 */
export function mergeReadings(readings: ParsedScore[]): ParsedScore {
  if (readings.length === 1) return readings[0];
  // The first page is taken exactly as read; only later pages are merged in.
  const sections: Section[] = (readings[0]?.sections ?? []).map((section) => ({
    label: section.label,
    lines: [...section.lines],
  }));
  for (const reading of readings.slice(1)) {
    for (const section of reading.sections) {
      const same = sections.find((existing) => existing.label === section.label);
      if (!same) {
        sections.push({ label: section.label, lines: [...section.lines] });
        continue;
      }
      const known = new Set(same.lines.map(lineKey));
      const repeated = section.lines.filter((line) => known.has(lineKey(line))).length;
      if (repeated * 2 >= section.lines.length) continue;
      same.lines.push(...section.lines);
    }
  }
  const first = <K extends keyof ParsedScore>(key: K) => readings.find((reading) => reading[key])?.[key];
  // The 진행 is the first page's — a part only a later page prints (the
  // bridge on page 2 of a SongSelect sheet) is sung all the same, so it is
  // added after the parts the 진행 names rather than left off the slides.
  const order = [...(readings.find((reading) => reading.order.length > 0)?.order ?? [])];
  if (order.length > 0) {
    const named = new Set(order.map((token) => findSection(sections, token)).filter(Boolean));
    const fromLater = new Set(readings.slice(1).flatMap((reading) => reading.sections.map((section) => section.label)));
    for (const section of sections) {
      if (!named.has(section) && fromLater.has(section.label) && !readings[0]?.sections.some((s) => s.label === section.label)) {
        order.push(section.label);
      }
    }
  }
  return {
    pageType: readings.some((reading) => reading.pageType === 'score') ? 'score' : readings[0]?.pageType,
    sermonTitle: first('sermonTitle'),
    scripture: first('scripture'),
    title: first('title'),
    artist: first('artist'),
    key: first('key'),
    order,
    lyricRowCount: readings[0]?.lyricRowCount,
    sections,
  };
}

export interface CombinedReading {
  /** The song's lyrics: its Korean pages — or, for a song printed in English only, its pages. */
  score: ParsedScore;
  /** What its English-only pages read, when it also has Korean ones. */
  english: ParsedScore | null;
}

/**
 * One song read off all of its pages (main page first). The Korean pages are
 * the song; a page in English only, beside them, is the same song in English
 * — the 찬양집회's English lyrics, kept apart from the Korean. A song with no
 * Korean page at all is an English song, and its pages are the song — unless
 * `koreanSong` (the conti names it in Korean) and one of its pages could not
 * be read: that page is the Korean, still to be read (or found on the web by
 * the Korean title), and the English stays the English.
 */
export function combinePageReadings(readings: ParsedScore[], koreanSong = false): CombinedReading {
  if (readings.length === 0) return { score: { order: [], sections: [] }, english: null };
  // One page is read exactly as before: there is nothing to combine.
  if (readings.length === 1) return { score: readings[0], english: printedEnglish(readings) };
  const korean = readings.filter((reading) => readingLanguage(reading) === 'ko');
  const english = readings.filter((reading) => readingLanguage(reading) === 'en');
  const unread = readings.filter((reading) => readingLanguage(reading) === 'none');
  if (korean.length === 0 && !(koreanSong && english.length > 0 && unread.length > 0)) {
    return { score: mergeReadings(readings), english: null };
  }
  const score = { ...mergeReadings([...korean, ...unread]) };
  // The title the song goes by is the Korean one, wherever it was printed.
  score.title = korean.find((reading) => reading.title)?.title ?? score.title ?? english.find((r) => r.title)?.title;
  if (readings.some((reading) => reading.pageType === 'score')) score.pageType = 'score';
  // A Korean song whose Korean page could not be read: its English pages are its English.
  return { score, english: korean.length > 0 ? printedEnglish(readings) : mergeReadings(english) };
}

/**
 * Whether a page gave the song English of its own: it is an English 악보, or
 * a Korean one printing the English beside its lyrics or under its title.
 */
export function givesEnglish(reading: ParsedScore): boolean {
  const language = readingLanguage(reading);
  if (language === 'en') return true;
  return language !== 'none' && (!!reading.englishTitle || (reading.englishSections?.length ?? 0) > 0);
}

/**
 * A song's English, as its pages print it: an English-only page's lyrics,
 * and the English a Korean page prints beside its own (`Above All` under
 * 모든 능력과 모든 권세, the English row under each Korean one). Null when no
 * page gives any. A song printed in English only has no English apart from
 * its lyrics — its pages are the song.
 */
export function printedEnglish(
  readings: ParsedScore[],
  /** The song is sung in Korean (its lyrics already settled), so an English page is its English. */
  koreanSong = readings.some((reading) => readingLanguage(reading) === 'ko'),
): ParsedScore | null {
  if (!koreanSong) return null;
  const parts = readings.flatMap((reading): ParsedScore[] => {
    if (readingLanguage(reading) === 'en') return [reading];
    if (!givesEnglish(reading)) return [];
    return [{ title: reading.englishTitle, order: reading.order, sections: reading.englishSections ?? [] }];
  });
  if (parts.length === 0) return null;
  const english = mergeReadings(parts);
  return english.sections.length > 0 || english.title ? english : null;
}

/** `english` with `title` as its title when it has none — or just that title, when there is no English. */
export function withEnglishTitle(english: ParsedScore | null, title: string | undefined): ParsedScore | null {
  if (!title?.trim() || english?.title?.trim()) return english;
  return english ? { ...english, title } : { title, order: [], sections: [] };
}

/**
 * A song's English as its English-only 악보 page printed it — what a 찬양집회
 * conti that prints each song once in Korean and once in English gives for
 * the English lyrics step.
 */
export interface ScoreEnglish {
  /** The title that page printed (the English title), when one was read. */
  title?: string;
  sections: Section[];
  order: string[];
  /** The conti pages it was read from. */
  pages: number[];
}
