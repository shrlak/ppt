import type { ContiInfo, ContiSongEntry, LibraryEntry } from './types';
import { normalizeTitle } from '../storage/library';

/** `주님의 사랑 (E): 설명...` — title, musical key, description. */
const SONG_LINE = /^(.{1,40}?)\s*[(（]\s*([A-Ga-g][#♯bB♭]?m?)\s*[)）]\s*[:：]\s*(.*)$/;
const DATE_RE = /\b(\d{1,2})\s*[/.]\s*(\d{1,2})\s*[/.]\s*(\d{2,4})\b/;
const QUOTED_RE = /[“"]([^“”"]{2,60})[”"]/;
const SCRIPTURE_RE = /^본문\s*[:：]\s*(.+)$/;
const NOTES_RE = /[세셰]션\s*노트/;

function normalizeKey(raw: string): string {
  let key = raw[0].toUpperCase();
  const rest = raw.slice(1).replace('♯', '#').replace('♭', 'b').replace('B', 'b');
  return key + rest;
}

/**
 * Parse the typed cover page of a 찬양 콘티: date, sermon title, scripture (본문)
 * and the song list with keys. Returns null when the text doesn't look like a cover.
 */
export function parseCoverText(text: string): ContiInfo | null {
  // The session-notes page repeats the song list; never treat it as a cover.
  if (NOTES_RE.test(text)) return null;
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  const songs: ContiSongEntry[] = [];
  let date: string | undefined;
  let sermonTitle: string | undefined;
  let scripture: string | undefined;

  for (const line of lines) {
    if (!line) continue;
    const scriptureMatch = line.match(SCRIPTURE_RE);
    if (scriptureMatch) {
      scripture ??= scriptureMatch[1].trim();
      continue;
    }
    const songMatch = line.match(SONG_LINE);
    if (songMatch && !songMatch[1].trim().startsWith('본문')) {
      songs.push({
        title: songMatch[1].trim(),
        key: normalizeKey(songMatch[2]),
        description: songMatch[3].trim() || undefined,
      });
      continue;
    }
    if (!date) {
      const dateMatch = line.match(DATE_RE);
      if (dateMatch) date = `${dateMatch[1]}/${dateMatch[2]}/${dateMatch[3]}`;
    }
    if (!sermonTitle) {
      const quoted = line.match(QUOTED_RE);
      if (quoted) sermonTitle = quoted[1].trim();
    }
  }

  // A real cover has service context beyond the bare song list.
  if (songs.length === 0 || (!date && !sermonTitle && !scripture)) return null;
  return { date, sermonTitle, scripture, songs };
}

/** Classify PDF pages (1-based): cover, session-notes, and sheet-music pages. */
export function classifyPages(pageTexts: string[]): {
  coverIndex: number | null;
  notesIndex: number | null;
  musicPages: number[];
} {
  let coverIndex: number | null = null;
  let notesIndex: number | null = null;

  for (let i = 0; i < pageTexts.length; i++) {
    const page = i + 1;
    if (coverIndex === null && parseCoverText(pageTexts[i])) {
      coverIndex = page;
    } else if (notesIndex === null && NOTES_RE.test(pageTexts[i])) {
      notesIndex = page;
    }
  }

  const musicPages: number[] = [];
  for (let page = 1; page <= pageTexts.length; page++) {
    if (page !== coverIndex && page !== notesIndex) musicPages.push(page);
  }
  return { coverIndex, notesIndex, musicPages };
}

/**
 * Assign each cover-page song a sheet-music page: first by finding the song title
 * in a page's (OCR) text, then sequentially for whatever is left. Mutates info.songs.
 */
export function matchSongsToPages(
  info: ContiInfo,
  pageTexts: string[],
  musicPages: number[],
): void {
  const taken = new Set<number>();

  for (const song of info.songs) {
    const want = normalizeTitle(song.title);
    if (!want) continue;
    const hit = musicPages.find(
      (p) => !taken.has(p) && normalizeTitle(pageTexts[p - 1] ?? '').includes(want),
    );
    if (hit) {
      song.pageIndex = hit;
      taken.add(hit);
    }
  }

  const free = musicPages.filter((p) => !taken.has(p));
  let next = 0;
  for (const song of info.songs) {
    if (song.pageIndex == null && next < free.length) {
      song.pageIndex = free[next++];
    }
  }
}

/**
 * Build an ordered song list straight from the sheet-music pages, for a conti
 * whose typed cover page is missing (or wasn't recognized). Each music page
 * becomes one song, in page order: matched to a library entry when its title
 * appears in the page's (OCR) text, otherwise a page-numbered stub the user
 * can fill in while looking at the score. The 공동체 고백송 may be among the
 * matched entries — callers should split it off exactly like the cover path.
 */
export function deriveSongsFromMusicPages(
  pageTexts: string[],
  musicPages: number[],
  library: LibraryEntry[],
): ContiSongEntry[] {
  return musicPages.map((page) => {
    const pageText = normalizeTitle(pageTexts[page - 1] ?? '');
    const hit = library.find((e) => {
      const t = normalizeTitle(e.title);
      return t.length >= 2 && pageText.includes(t);
    });
    return hit
      ? { title: hit.title, key: hit.key, pageIndex: page }
      : { title: `새 찬양 (p.${page})`, pageIndex: page };
  });
}

// The KCCP 공동체 고백송 — its lyric slides live in the fixed back-slides deck,
// so it never needs generated lyric slides. Matched by normalized title so
// spacing/case/punctuation differences on the cover page don't matter.
const CONFESSION_SONG_TITLE = normalizeTitle('Celebrate the Light');

/** True when a conti entry is the 공동체 고백송 supplied by the back slides. */
export function isConfessionSong(title: string): boolean {
  return normalizeTitle(title) === CONFESSION_SONG_TITLE;
}

/**
 * The 공동체 고백송 (Celebrate the Light) is supplied by the fixed back-slides
 * deck, so it is split off from the entries that need generated lyric slides.
 * Every other song — including the 입례 song, wherever it appears in the
 * order — stays in the lyrics list.
 */
export function splitLyricsAndConfessionSongs(songs: ContiSongEntry[]): {
  lyricsSongs: ContiSongEntry[];
  confessionSong?: ContiSongEntry;
} {
  const confessionSong = songs.find((song) => isConfessionSong(song.title));
  return {
    lyricsSongs: songs.filter((song) => song !== confessionSong),
    confessionSong,
  };
}
