// The songs a 수련회 conti's 악보 pages hold — the pure half; the models that
// read a scanned page run in scoreReader.ts.
//
// One 악보 PDF carries every 집회's scores, so a page says which song it is
// and nothing about where it is sung: the conti's song table places songs,
// and the 악보 only lends them lyrics. Without a table, the songs read off
// the pages are listed for the songs blocks to take from by hand.
import { normalizeTitle } from '../lib/storage/library';
import { SAME_TITLE_THRESHOLD, titleSimilarity } from '../lib/utils/contiAlignment';
import { classifyPages } from '../lib/utils/contiText';
import type { ParsedScore } from '../lib/ai/scoreParser';
import { parseRetreatConti } from './conti';
import { libraryLyricsText } from './songs';
import type { RetreatState, ScoreSong } from './types';

/**
 * Pages (1-based) of one PDF that may be 악보: every page but its song
 * table and the pages a conti's cover and notes take.
 */
export function retreatScorePages(pageTexts: string[]): number[] {
  return classifyPages(pageTexts).musicPages.filter(
    (page) => !parseRetreatConti(pageTexts[page - 1] ?? '').some((slot) => slot.key),
  );
}

/**
 * The title a page's text layer prints, among the ones given (the longest
 * that appears, so "주님의 임재 앞에서" beats "임재"). Scanned pages have no
 * text layer, and come back undefined. A long list takes a longer
 * `minLength`, since a short title can turn up inside another song's lyrics.
 */
export function titleInPageText(text: string, titles: string[], minLength = 2): string | undefined {
  const page = normalizeTitle(text);
  if (!page) return undefined;
  let best: { title: string; length: number } | undefined;
  for (const title of titles) {
    const key = normalizeTitle(title);
    if (key.length >= minLength && page.includes(key) && (!best || key.length > best.length)) best = { title, length: key.length };
  }
  return best?.title;
}

/**
 * The title a reading stands for. The conti's own table is ground truth for
 * this retreat, so a near reading (a misread syllable) is enough there; a
 * title from last year's songs or the 찬양 라이브러리 must read the same, or
 * one contain the other, since those lists are long enough for a near miss
 * to be another song.
 */
export function matchKnownTitle(read: string | undefined, tableTitles: string[], knownTitles: string[]): string | undefined {
  const best = (titles: string[], threshold: number) => {
    let found: { title: string; score: number } | undefined;
    for (const title of titles) {
      const score = titleSimilarity(read, title);
      if (score >= threshold && (!found || score > found.score)) found = { title, score };
    }
    return found?.title;
  };
  return best(tableTitles, SAME_TITLE_THRESHOLD) ?? best(knownTitles, 0.9);
}

/** A page's reading, laid out the way the retreat decks project lyrics. */
export function scoreLyricsText(score: ParsedScore): string {
  if (score.sections.length === 0) return '';
  return libraryLyricsText({ title: score.title ?? '', sections: score.sections, order: score.order });
}

/** Titles in the songs blocks that no source has lyrics for yet. */
export function titlesWithoutLyrics(state: RetreatState): string[] {
  const titles = new Map<string, string>();
  for (const session of state.sessions) {
    for (const block of session.blocks) {
      if (block.kind !== 'songs') continue;
      for (const song of block.songs) {
        const key = normalizeTitle(song.title);
        if (key && !song.lyrics.trim() && !titles.has(key)) titles.set(key, song.title);
      }
    }
  }
  return [...titles.values()];
}

/**
 * Keep what the 악보 pages were read as, and give every song still without
 * lyrics the ones read for its title. A title read twice keeps its first
 * reading, unless only the later one has lyrics. Lyrics already there — from
 * last year, the library, or typed — are never replaced.
 */
export function applyScoreSongs(state: RetreatState, read: ScoreSong[]): { state: RetreatState; filled: string[] } {
  const byTitle = new Map(state.scoreSongs.map((song) => [normalizeTitle(song.title), song]));
  for (const song of read) {
    const key = normalizeTitle(song.title);
    if (!key) continue;
    const had = byTitle.get(key);
    if (!had || (!had.lyrics.trim() && song.lyrics.trim())) byTitle.set(key, song);
  }
  const scoreSongs = [...byTitle.values()];

  const filled = new Set<string>();
  const sessions = state.sessions.map((session) => ({
    ...session,
    blocks: session.blocks.map((block) => {
      if (block.kind !== 'songs') return block;
      return {
        ...block,
        songs: block.songs.map((song) => {
          if (song.lyrics.trim()) return song;
          const found = byTitle.get(normalizeTitle(song.title));
          if (!found?.lyrics.trim()) return song;
          filled.add(song.title);
          return { ...song, lyrics: found.lyrics, source: 'score' as const };
        }),
      };
    }),
  }));
  return { state: { ...state, sessions, scoreSongs }, filled: [...filled] };
}
