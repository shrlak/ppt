import type { ContiInfo, ContiSongEntry } from './types';
import { normalizeTitle } from './library';

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
 * The final song on a KCCP conti is the 공동체 고백송. It is supplied by the
 * fixed back-slides deck, so only the preceding entries need generated lyric
 * slides.
 */
export function splitLyricsAndConfessionSongs(songs: ContiSongEntry[]): {
  lyricsSongs: ContiSongEntry[];
  confessionSong?: ContiSongEntry;
} {
  if (songs.length === 0) return { lyricsSongs: [] };
  return {
    lyricsSongs: songs.slice(0, -1),
    confessionSong: songs[songs.length - 1],
  };
}
