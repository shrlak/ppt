// The night's 기도: how many there are, what each one projects, and which
// song each one follows.
//
// The operator keeps a list of 기도 (기도 1, 기도 2, …) and checks the songs a
// 기도 comes after. The two are paired in order: 기도 1 goes after the first
// checked song, 기도 2 after the second, and so on. A 기도 with no checked
// song left for it goes at the end of the deck, after the last song.
//
// 기도 waiting for a song take the checked songs in order, so 기도 written
// ahead of time keep their numbers however the songs are checked; with none
// waiting, checking a song brings in a new 기도 / Prayer right there.
// Unchecking a song sets its 기도 aside rather than handing it to the next
// song, so every other pairing stays as it was, and checking that song again
// brings it back — while a 기도 nothing was typed into is simply dropped, so
// checking a song by mistake and unchecking it again leaves nothing behind.
import type { Song } from '../lib/utils/types';
import type { PraisePrayer, PraisePrayerSlide, PraisePrayerSlideKind, PraiseSongExtras } from './types';

/** Titles a 기도 slide is often given, offered as one-tap choices. */
export const PRAYER_TITLE_PRESETS: readonly { ko: string; en: string }[] = [
  { ko: '기도', en: 'Prayer' },
  { ko: '통성기도', en: 'Corporate Prayer' },
  { ko: '합심기도', en: 'United Prayer' },
  { ko: '중보기도', en: 'Intercessory Prayer' },
  { ko: '개인기도', en: 'Personal Prayer' },
  { ko: '묵상기도', en: 'Silent Prayer' },
  { ko: '결단기도', en: 'Prayer of Commitment' },
  { ko: '마무리 기도', en: 'Closing Prayer' },
  { ko: '축도', en: 'Benediction' },
];

export const DEFAULT_TOPICS_HEADING = '기도제목';
export const DEFAULT_TOPICS_HEADING_EN = 'Prayer Prompt';
const DEFAULT_TITLE = PRAYER_TITLE_PRESETS[0];

export function createPrayerSlide(kind: PraisePrayerSlideKind, title = DEFAULT_TITLE): PraisePrayerSlide {
  const id = crypto.randomUUID();
  switch (kind) {
    case 'topics':
      return { id, kind, heading: DEFAULT_TOPICS_HEADING, headingEn: DEFAULT_TOPICS_HEADING_EN, text: '' };
    case 'scripture':
      return { id, kind, reference: '', passage: null };
    default:
      return { id, kind: 'title', ko: title.ko, en: title.en };
  }
}

/**
 * A new 기도: an empty 기도제목 (no slide until a topic is typed) followed by
 * 기도 / Prayer — last year's 기도제목 → 기도 order.
 */
export function createPrayer(): PraisePrayer {
  return { id: crypto.randomUUID(), slides: [createPrayerSlide('topics'), createPrayerSlide('title')] };
}

/** Topics as the slide lists them: one per line, blank lines and typed bullets dropped. */
export function topicLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*[-–—•·∙●○▪■*]+\s*/, '').trim())
    .filter(Boolean);
}

/** True when the slide puts nothing on the screen yet (no topic typed, no passage read). */
export function isEmptyPrayerSlide(slide: PraisePrayerSlide): boolean {
  switch (slide.kind) {
    case 'topics':
      return topicLines(slide.text).length === 0;
    case 'scripture':
      return !slide.passage || slide.passage.verses.length === 0;
    default:
      return !slide.ko.trim() && !slide.en.trim();
  }
}

/**
 * Whether anything was put into the 기도 beyond what a new one starts with:
 * a topic, a passage, another title, or a slide added or taken away.
 */
export function prayerHasContent(prayer: PraisePrayer): boolean {
  const titles = prayer.slides.filter((slide) => slide.kind === 'title');
  if (titles.length !== 1 || prayer.slides.length > 2) return true;
  return prayer.slides.some((slide) => {
    switch (slide.kind) {
      case 'topics':
        return (
          Boolean(slide.text.trim()) ||
          slide.heading.trim() !== DEFAULT_TOPICS_HEADING ||
          slide.headingEn.trim() !== DEFAULT_TOPICS_HEADING_EN
        );
      case 'scripture':
        return Boolean(slide.reference.trim());
      default:
        return slide.ko.trim() !== DEFAULT_TITLE.ko || slide.en.trim() !== DEFAULT_TITLE.en;
    }
  });
}

/** The songs a 기도 comes after, in the night's order. */
export function checkedSongIds(songs: Song[], extras: Record<string, PraiseSongExtras>): string[] {
  return songs.filter((song) => extras[song.id]?.prayerAfter).map((song) => song.id);
}

export interface PlacedPrayer {
  prayer: PraisePrayer;
  /** 1-based: 기도 1, 기도 2… */
  number: number;
  /** The song it follows, or null when no checked song is left for it (it goes at the end). */
  afterSongId: string | null;
}

/**
 * Every 기도 with the song it follows. A checked song with no 기도 of its own
 * (only possible in a night saved before 기도 were kept) gets a plain
 * 기도 / Prayer, as checking a song always did.
 */
export function placePrayers(
  songs: Song[],
  extras: Record<string, PraiseSongExtras>,
  prayers: PraisePrayer[],
): PlacedPrayer[] {
  const checked = checkedSongIds(songs, extras);
  const count = Math.max(prayers.length, checked.length);
  const placed: PlacedPrayer[] = [];
  for (let index = 0; index < count; index++) {
    placed.push({
      prayer: prayers[index] ?? { id: `default-${index}`, slides: [{ id: `default-${index}-title`, kind: 'title', ...DEFAULT_TITLE }] },
      number: index + 1,
      afterSongId: checked[index] ?? null,
    });
  }
  return placed;
}

/** At least one 기도 for every checked song, adding plain ones at the end when there are fewer. */
export function withPrayerPerCheckedSong(
  songs: Song[],
  extras: Record<string, PraiseSongExtras>,
  prayers: PraisePrayer[],
): PraisePrayer[] {
  const checked = checkedSongIds(songs, extras).length;
  if (prayers.length >= checked) return prayers;
  return [...prayers, ...Array.from({ length: checked - prayers.length }, createPrayer)];
}

function withoutRelease(prayer: PraisePrayer): PraisePrayer {
  if (prayer.releasedFrom === undefined) return prayer;
  const { releasedFrom: _dropped, ...rest } = prayer;
  return rest;
}

/**
 * The 기도 at `index` loses its song `songId` (`checkedCount` songs were
 * checked before): it waits first in line, remembering the song, or — with
 * nothing typed into it — goes altogether.
 */
function releaseAt(prayers: PraisePrayer[], index: number, checkedCount: number, songId: string): PraisePrayer[] {
  if (index < 0 || index >= prayers.length) return prayers;
  const next = [...prayers];
  const [released] = next.splice(index, 1);
  if (prayerHasContent(released)) {
    next.splice(Math.min(checkedCount - 1, next.length), 0, { ...released, releasedFrom: songId });
  }
  return next;
}

export interface PrayerState {
  extras: Record<string, PraiseSongExtras>;
  prayers: PraisePrayer[];
}

function withPrayerAfter(
  extras: Record<string, PraiseSongExtras>,
  songId: string,
  on: boolean,
): Record<string, PraiseSongExtras> {
  const current = extras[songId] ?? { english: { title: '', slides: {} } };
  const { prayerAfter: _dropped, ...rest } = current;
  return { ...extras, [songId]: on ? { ...rest, prayerAfter: true } : rest };
}

/** Check or uncheck "기도 after this song", moving 기도 so no other song's changes. */
export function setPrayerAfter(
  songs: Song[],
  state: PrayerState,
  songId: string,
  on: boolean,
): PrayerState {
  const before = checkedSongIds(songs, state.extras);
  if (before.includes(songId) === on) return state;
  const extras = withPrayerAfter(state.extras, songId, on);
  if (on) {
    const index = checkedSongIds(songs, extras).indexOf(songId);
    const prayers = [...state.prayers];
    const own = prayers.findIndex((prayer, at) => at >= before.length && prayer.releasedFrom === songId);
    if (own >= 0) {
      // The song's own 기도, set aside when it was unchecked, comes back to it.
      const [prayer] = prayers.splice(own, 1);
      prayers.splice(index, 0, withoutRelease(prayer));
    } else if (prayers.length > before.length) {
      // 기도 waiting for a song take the checked songs in order: nothing
      // moves, and the first of them now has a song.
      prayers[before.length] = withoutRelease(prayers[before.length]);
    } else {
      prayers.splice(index, 0, createPrayer());
    }
    return { extras, prayers };
  }
  return { extras, prayers: releaseAt(state.prayers, before.indexOf(songId), before.length, songId) };
}

/** A 기도 added by the operator: it waits at the end until a song is checked for it. */
export function addPrayer(state: PrayerState): PrayerState {
  return { ...state, prayers: [...state.prayers, createPrayer()] };
}

/** Take out 기도 `index` — and the check on the song it followed, so the others keep their songs. */
export function removePrayer(songs: Song[], state: PrayerState, index: number): PrayerState {
  if (index < 0 || index >= state.prayers.length) return state;
  const checked = checkedSongIds(songs, state.extras);
  const prayers = state.prayers.filter((_, at) => at !== index);
  const extras = index < checked.length ? withPrayerAfter(state.extras, checked[index], false) : state.extras;
  return { extras, prayers };
}

/**
 * Songs taken off the list let go of their 기도 the way unchecking them
 * would, so a song removed from the middle never hands its 기도 down the line.
 */
export function releaseRemovedSongs(
  previous: Song[],
  next: Song[],
  extras: Record<string, PraiseSongExtras>,
  prayers: PraisePrayer[],
): PraisePrayer[] {
  const kept = new Set(next.map((song) => song.id));
  let remaining = previous;
  let result = prayers;
  for (const song of previous) {
    if (kept.has(song.id) || !extras[song.id]?.prayerAfter) continue;
    const checked = checkedSongIds(remaining, extras);
    result = releaseAt(result, checked.indexOf(song.id), checked.length, song.id);
    remaining = remaining.filter((candidate) => candidate.id !== song.id);
  }
  return result;
}

/** A slide moved one place up (-1) or down (+1) within its 기도. */
export function movePrayerSlide(prayer: PraisePrayer, slideId: string, step: -1 | 1): PraisePrayer {
  const from = prayer.slides.findIndex((slide) => slide.id === slideId);
  const to = from + step;
  if (from < 0 || to < 0 || to >= prayer.slides.length) return prayer;
  const slides = [...prayer.slides];
  [slides[from], slides[to]] = [slides[to], slides[from]];
  return { ...prayer, slides };
}

/**
 * `target` with each song's "기도 after this song" mark taken from `source`
 * and nothing else changed — so a check made from an older copy of the
 * extras never undoes English that arrived since.
 */
export function applyPrayerFlags(
  target: Record<string, PraiseSongExtras>,
  source: Record<string, PraiseSongExtras>,
): Record<string, PraiseSongExtras> {
  let result = target;
  for (const songId of new Set([...Object.keys(target), ...Object.keys(source)])) {
    const want = Boolean(source[songId]?.prayerAfter);
    if (Boolean(target[songId]?.prayerAfter) === want) continue;
    result = withPrayerAfter(result, songId, want);
  }
  return result;
}
