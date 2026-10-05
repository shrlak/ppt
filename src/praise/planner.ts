// Plans the 찬양집회 deck: which slides it has, in which order, carrying which
// Korean and English lines. Pure, so the download, the slide count and the
// on-screen preview all read the same plan.
//
// The deck follows last year's bilingual layout:
//
//   표지
//   (표지 뒤에 두기로 한 추가 자료)
//   곡마다: [한글 제목 / English Title] + 가사 슬라이드 (한글 위, 영어 아래)
//           + 그 곡 뒤에 두기로 한 추가 자료 (설교 PPT, 말씀 등)
//           + 기도 (기도제목 · 말씀 · 기도 / Prayer…), when the song is checked
//             for one — the night's 기도 go after the checked songs in order
//   (곡이 모자라 맨 뒤로 간 기도)
//   (맨 뒤에 두기로 한 추가 자료)
//
// That is last year's running order in general form: a set of songs, the
// sermon, 기도제목, 기도, the next set, and so on.
//
// Korean slides are split exactly as the Sunday deck splits them
// (planSlides: every part once, blank lines force a break, 슬라이드당 줄 수),
// and each slide then carries the English written for that slide.
import type { Song } from '../lib/utils/types';
import { planSlides } from '../lib/utils/slidePlanner';
import { fitBodyFontSize } from '../lib/pptx/textFit';
import { placePrayers, topicLines } from './prayers';
import {
  PRAISE_LYRICS_BASE_SZ,
  PRAISE_LYRICS_BODY_BOX,
  PRAISE_LYRICS_MIN_SZ,
  PRAISE_LYRICS_SPLIT_SZ,
  PRAISE_TOPICS_BASE_SZ,
  PRAISE_TOPICS_BODY_BOX,
  PRAISE_TOPICS_MIN_SZ,
  PRAISE_TOPICS_SPLIT_SZ,
} from './template';
import { extrasFor, type PraisePrayer, type PraiseSongExtras, type PraiseVerse } from './types';

const HANGUL = /[가-힣ㄱ-ㆎ]/;

export function hasHangul(text: string): boolean {
  return HANGUL.test(text);
}

/**
 * A song with no Korean anywhere ("Who Else", "Praise") is sung in English as
 * written: its lines ARE the English, so it gets no second language under
 * them and no translation step.
 */
export function isEnglishOnlySong(song: Song): boolean {
  if (hasHangul(song.title)) return false;
  return !song.sections.some((section) => section.lines.some((line) => hasHangul(line)));
}

/** Case, spacing and punctuation never make two lyric lines different. */
export function normalizeLyricLine(line: string): string {
  return line.toLowerCase().replace(/[^0-9a-z가-힣ㄱ-ㆎ]+/g, '');
}

/** The identity a Korean slide's English is stored under. */
export function slideKey(lines: string[]): string {
  return lines.map(normalizeLyricLine).filter(Boolean).join('/');
}

export interface PraiseLyricPage {
  lines: string[];
  english: string[];
}

export interface PraiseLyricSlide {
  key: string;
  /** Korean lines — or, for an English-only song, its English lines. */
  lines: string[];
  /** English printed under the Korean. Always empty for an English-only song. */
  english: string[];
  /**
   * What is actually projected: the slide itself, or — when its Korean and
   * English together would not fit the page at a readable size — the slide
   * split into consecutive pages.
   */
  pages: PraiseLyricPage[];
}

/** The lines a page draws: Korean, a blank line, then the English. */
function renderedLines(page: PraiseLyricPage): string[] {
  return page.english.length > 0 && page.lines.length > 0
    ? [...page.lines, '', ...page.english]
    : [...page.lines, ...page.english];
}

/** Font size (1/100 pt) the page would be drawn at on the template's lyrics box. */
export function pageFontSize(page: PraiseLyricPage): number {
  return fitBodyFontSize(PRAISE_LYRICS_BODY_BOX, renderedLines(page), PRAISE_LYRICS_BASE_SZ, PRAISE_LYRICS_MIN_SZ);
}

/**
 * Split a slide in two — Korean lines halved, the English shared out in the
 * same proportion — until every page fits at a readable size or is down to a
 * single line that cannot be divided any further.
 */
export function fitToPages(page: PraiseLyricPage): PraiseLyricPage[] {
  if (pageFontSize(page) >= PRAISE_LYRICS_SPLIT_SZ) return [page];
  const n = page.lines.length;
  const m = page.english.length;
  if (n >= 2) {
    const half = Math.ceil(n / 2);
    const cut = Math.round((half * m) / n);
    return [
      ...fitToPages({ lines: page.lines.slice(0, half), english: page.english.slice(0, cut) }),
      ...fitToPages({ lines: page.lines.slice(half), english: page.english.slice(cut) }),
    ];
  }
  if (m >= 2) {
    // One Korean line under a long English verse: keep the Korean on both.
    const cut = Math.ceil(m / 2);
    return [
      ...fitToPages({ lines: page.lines, english: page.english.slice(0, cut) }),
      ...fitToPages({ lines: page.lines, english: page.english.slice(cut) }),
    ];
  }
  return [page];
}

export interface PraiseSongPlan {
  songId: string;
  titleKo: string;
  /** Empty when the song has only one title. */
  titleEn: string;
  /** Corner label on each lyric slide: "한글 | English", or the one title. */
  header: string;
  englishOnly: boolean;
  slides: PraiseLyricSlide[];
  prayerAfter: boolean;
}

/** Where a 기도's slides are: which 기도 (1-based) and the song it follows (null: at the end). */
interface PrayerSlideAt {
  prayerId: string;
  prayerNumber: number;
  afterSongId: string | null;
}

export type PraiseSlidePlan =
  | { kind: 'cover' }
  | { kind: 'title'; songId: string; titleKo: string; titleEn: string }
  | { kind: 'lyrics'; songId: string; header: string; lines: string[]; english: string[] }
  /** 기도 / Prayer, or another prayer title. */
  | ({ kind: 'prayer'; ko: string; en: string } & PrayerSlideAt)
  /** One page of a 기도제목 slide; `heading` as printed: "기도제목 | Prayer Prompt". */
  | ({ kind: 'prayer-topics'; heading: string; topics: string[] } & PrayerSlideAt)
  /** One verse of a 말씀 slide. */
  | ({ kind: 'scripture'; passageKo: string; passageEn: string; verse: PraiseVerse } & PrayerSlideAt)
  /** Stands for every slide of one 추가 자료 file, spliced in at this point. */
  | { kind: 'additional'; fileId: string };

/** Where a 추가 자료 file goes: right after the cover, after a song, or at the end. */
export type AdditionalPlacement = 'start' | 'end' | { afterSongId: string };

export interface PlacedAdditional {
  fileId: string;
  placement: AdditionalPlacement;
}

function joinTitles(ko: string, en: string): string {
  return en ? `${ko} | ${en}` : ko;
}

export function planPraiseSong(song: Song, extras: PraiseSongExtras | undefined): PraiseSongPlan {
  const englishOnly = isEnglishOnlySong(song);
  const titleKo = song.title.trim();
  const rawEn = (extras?.english.title ?? '').trim();
  const titleEn = englishOnly || normalizeLyricLine(rawEn) === normalizeLyricLine(titleKo) ? '' : rawEn;
  const slides = planSlides(song)
    .filter((plan) => plan.kind === 'lyrics')
    .map((plan) => {
      const lines = plan.lines ?? [];
      const key = slideKey(lines);
      const english = englishOnly ? [] : (extras?.english.slides[key] ?? []).filter((line) => line.trim());
      return { key, lines, english, pages: fitToPages({ lines, english }) };
    });
  return {
    songId: song.id,
    titleKo,
    titleEn,
    header: joinTitles(titleKo, titleEn),
    englishOnly,
    slides,
    prayerAfter: Boolean(extras?.prayerAfter),
  };
}

/** Font size (1/100 pt) a page of topics would be drawn at on the 기도제목 slide. */
export function topicsFontSize(topics: string[]): number {
  return fitBodyFontSize(PRAISE_TOPICS_BODY_BOX, topics, PRAISE_TOPICS_BASE_SZ, PRAISE_TOPICS_MIN_SZ);
}

/**
 * Topics shared out over as many 기도제목 slides as it takes to keep each one
 * readable, in order, never splitting a topic: a page takes topics while they
 * still fit at the split size.
 */
export function paginateTopics(topics: string[]): string[][] {
  const pages: string[][] = [];
  let page: string[] = [];
  for (const topic of topics) {
    if (page.length > 0 && topicsFontSize([...page, topic]) < PRAISE_TOPICS_SPLIT_SZ) {
      pages.push(page);
      page = [];
    }
    page.push(topic);
  }
  if (page.length > 0) pages.push(page);
  return pages;
}

/** The slides one 기도 projects, in its own order; slides with nothing on them yet are left out. */
export function planPrayerSlides(prayer: PraisePrayer, at: PrayerSlideAt): PraiseSlidePlan[] {
  return prayer.slides.flatMap((slide): PraiseSlidePlan[] => {
    switch (slide.kind) {
      case 'topics':
        return paginateTopics(topicLines(slide.text)).map((topics) => ({
          kind: 'prayer-topics',
          // Korean and English on one line, the deck's "한글 | English".
          heading: [slide.heading.trim(), slide.headingEn.trim()].filter(Boolean).join(' | '),
          topics,
          ...at,
        }));
      case 'scripture':
        return (slide.passage?.verses ?? []).map((verse) => ({
          kind: 'scripture',
          passageKo: slide.passage!.rangeKo,
          passageEn: slide.passage!.rangeEn,
          verse,
          ...at,
        }));
      default:
        return slide.ko.trim() || slide.en.trim()
          ? [{ kind: 'prayer', ko: slide.ko.trim(), en: slide.en.trim(), ...at }]
          : [];
    }
  });
}

/** True for every slide a 기도 put in the deck. */
export function isPrayerPlan(
  plan: PraiseSlidePlan,
): plan is Extract<PraiseSlidePlan, { kind: 'prayer' | 'prayer-topics' | 'scripture' }> {
  return plan.kind === 'prayer' || plan.kind === 'prayer-topics' || plan.kind === 'scripture';
}

/**
 * Every slide of the deck, in order. A file placed after a song that is no
 * longer on the list falls back to the end rather than disappearing, and so
 * does a 기도 with no checked song left for it.
 */
export function planPraiseDeck(
  songs: Song[],
  extras: Record<string, PraiseSongExtras>,
  additional: PlacedAdditional[] = [],
  prayers: PraisePrayer[] = [],
): PraiseSlidePlan[] {
  const songIds = new Set(songs.map((song) => song.id));
  const placedAfter = (songId: string) =>
    additional
      .filter((item) => typeof item.placement === 'object' && item.placement.afterSongId === songId)
      .map((item): PraiseSlidePlan => ({ kind: 'additional', fileId: item.fileId }));
  const atEnd = additional.filter(
    (item) =>
      item.placement === 'end' ||
      (typeof item.placement === 'object' && !songIds.has(item.placement.afterSongId)),
  );

  const placedPrayers = placePrayers(songs, extras, prayers);
  const prayerSlides = (afterSongId: string | null) =>
    placedPrayers
      .filter((placed) => placed.afterSongId === afterSongId)
      .flatMap((placed) =>
        planPrayerSlides(placed.prayer, { prayerId: placed.prayer.id, prayerNumber: placed.number, afterSongId }),
      );

  const plans: PraiseSlidePlan[] = [{ kind: 'cover' }];
  for (const item of additional) {
    if (item.placement === 'start') plans.push({ kind: 'additional', fileId: item.fileId });
  }
  for (const song of songs) {
    const plan = planPraiseSong(song, extrasFor(extras, song.id));
    plans.push({ kind: 'title', songId: song.id, titleKo: plan.titleKo, titleEn: plan.titleEn });
    for (const slide of plan.slides) {
      for (const page of slide.pages) {
        plans.push({ kind: 'lyrics', songId: song.id, header: plan.header, lines: page.lines, english: page.english });
      }
    }
    plans.push(...placedAfter(song.id));
    plans.push(...prayerSlides(song.id));
  }
  plans.push(...prayerSlides(null));
  for (const item of atEnd) plans.push({ kind: 'additional', fileId: item.fileId });
  return plans;
}

/** Korean slides of a song still waiting for their English. */
export function missingEnglishCount(song: Song, extras: PraiseSongExtras | undefined): number {
  const plan = planPraiseSong(song, extras);
  if (plan.englishOnly) return 0;
  return plan.slides.filter((slide) => slide.english.length === 0).length;
}
