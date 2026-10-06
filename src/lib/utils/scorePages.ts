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
  const neighbour = (page: number, step: -1 | 1) => {
    const at = musicPages.indexOf(page);
    return at < 0 ? undefined : musicPages[at + step];
  };
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

/**
 * Cards made one per 악보 page (a conti with no cover to list its songs) that
 * are the same song: a card whose page prints the same title as the page just
 * before it is folded into that card. `titles[i]` is card `i`'s title, the
 * cards in PDF page order. Returns, for each card, the index of the card it
 * belongs to — its own index when it stands alone.
 */
export function foldRepeatedTitles(titles: (string | undefined)[]): number[] {
  const heads: number[] = [];
  titles.forEach((title, index) => {
    const previous = index - 1;
    const head = previous >= 0 ? heads[previous] : -1;
    const same =
      head >= 0 &&
      !isPlaceholderTitle(title) &&
      (titleSimilarity(titles[previous], title) >= SAME_TITLE_THRESHOLD ||
        titleSimilarity(titles[head], title) >= SAME_TITLE_THRESHOLD);
    heads.push(same ? head : index);
  });
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
  return {
    pageType: readings.some((reading) => reading.pageType === 'score') ? 'score' : readings[0]?.pageType,
    sermonTitle: first('sermonTitle'),
    scripture: first('scripture'),
    title: first('title'),
    artist: first('artist'),
    key: first('key'),
    order: readings.find((reading) => reading.order.length > 0)?.order ?? [],
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
  if (readings.length === 1) return { score: readings[0], english: null };
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
  return { score, english: english.length > 0 ? mergeReadings(english) : null };
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
