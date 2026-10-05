// The 찬양집회 (praise night) generator's own state. The songs themselves are
// the same Song objects the Sunday 찬양 step produces — the conti, the 악보
// recognition and the 찬양 라이브러리 are shared — and everything this page
// adds on top of them is kept per song here, keyed by the song's id.
import type { AdditionalFile } from '../lib/additionalFiles/types';

/** A song's English side: its English title and the English under each slide. */
export interface PraiseEnglish {
  /** English title, e.g. "Goodness of God". Empty when the song has one title. */
  title: string;
  /**
   * English lines for each Korean lyric slide, keyed by `slideKey()` of that
   * slide's Korean lines. Keying by the Korean text (not by position) keeps
   * each English block under the Korean it translates when songs are
   * reordered, parts are moved, or a section is split differently.
   */
  slides: Record<string, string[]>;
}

export interface PraiseSongExtras {
  english: PraiseEnglish;
  /**
   * A 기도 comes right after this song: the night's 기도 go after the songs
   * checked this way, in order — the first 기도 after the first checked song,
   * the second after the second, and so on (see prayers.ts).
   */
  prayerAfter?: boolean;
  /**
   * Where the English came from, so the card can say how far to trust it:
   * last year's deck / a saved song, the chord sheet the conti was uploaded
   * as, a post found on the web, the AI, or the operator's own typing.
   */
  englishSource?: 'memory' | 'sheet' | 'web' | 'ai' | 'manual';
  /** The post the web English came from, for the card to link to. */
  englishSourceUrl?: string;
}

/** One verse of a 말씀 slide: 개역개정 over NASB. */
export interface PraiseVerse {
  /** "사도행전 1장 3절" (a verse 개역개정 prints with the next: "신명기 6장 18-19절"). */
  refKo: string;
  /** "Acts 1:3". */
  refEn: string;
  ko: string;
  en: string;
}

/** A typed passage as read from the Bible files, kept with the night so the deck never has to look it up again. */
export interface PraisePassage {
  /** "사도행전 1장 3-5, 8절". */
  rangeKo: string;
  /** "Acts 1:3-5, 8". */
  rangeEn: string;
  verses: PraiseVerse[];
}

/** One slide (or run of slides) of a 기도. */
export type PraisePrayerSlide =
  /** 기도 / Prayer, or any other prayer title (통성기도 / Corporate Prayer, 축도 / Benediction…). */
  | { id: string; kind: 'title'; ko: string; en: string }
  /**
   * 기도제목: a heading — Korean and English, "기도제목 | Prayer Prompt" — over
   * the topics typed one to a line; more than fit go on to another slide.
   */
  | { id: string; kind: 'topics'; heading: string; headingEn: string; text: string }
  /** 말씀: the typed passage, one verse a slide, 개역개정 over NASB. */
  | { id: string; kind: 'scripture'; reference: string; passage: PraisePassage | null };

export type PraisePrayerSlideKind = PraisePrayerSlide['kind'];

/** One time of prayer in the night, and the slides projected for it, in order. */
export interface PraisePrayer {
  id: string;
  slides: PraisePrayerSlide[];
  /**
   * The song this 기도 followed until that song was unchecked: checking the
   * song again brings this 기도 back to it.
   */
  releasedFrom?: string;
}

export interface PraiseCoverImage {
  name: string;
  mimeType: 'image/png' | 'image/jpeg';
  data: ArrayBuffer;
}

/** A picture on the poster slide, with the size it was drawn at so the slide can place it. */
export interface PraisePosterImage {
  name: string;
  mimeType: 'image/png' | 'image/jpeg';
  data: ArrayBuffer;
  width: number;
  height: number;
}

/**
 * The poster: the night's very first slide, ahead of the 표지. A poster
 * picture (this year's flyer, or a photo to write on), the words on it, and
 * its colours, every one of them editable here — and the slide is built of
 * an ordinary picture and an ordinary text box, so it stays editable in
 * PowerPoint too.
 */
export interface PraisePoster {
  /** On: the poster goes in as slide 1. Off keeps what was entered, out of the deck. */
  enabled: boolean;
  image: PraisePosterImage | null;
  /** `contain`: the whole picture, the background colour around it. `cover`: the picture fills the slide, its edges cut off. */
  fit: 'contain' | 'cover';
  /** `RRGGBB` behind the picture — the whole slide when there is none. */
  background: string;
  /** One line, as large as it fits ("EM & KM Praise Night"). */
  title: string;
  /** One line under the title (a theme, a verse). */
  subtitle: string;
  /** One line each under that: the date and time, the place… */
  details: string;
  /** `RRGGBB` of every word on the poster. */
  textColor: string;
}

export interface PraiseService {
  /** Event date, `YYYY-MM-DD` (the date input's own format). */
  date: string;
}

export interface PraiseDeckInputs {
  service: PraiseService;
  extras: Record<string, PraiseSongExtras>;
  coverImage: PraiseCoverImage | null;
  additionalFiles: AdditionalFile[];
}

/** The 표지's own dark green, so a poster with no picture sits in the deck's colours. */
export const DEFAULT_POSTER_BACKGROUND = '010C05';
export const DEFAULT_POSTER_TEXT_COLOR = 'FFFFFF';

export function emptyPoster(): PraisePoster {
  return {
    enabled: false,
    image: null,
    fit: 'contain',
    background: DEFAULT_POSTER_BACKGROUND,
    title: '',
    subtitle: '',
    details: '',
    textColor: DEFAULT_POSTER_TEXT_COLOR,
  };
}

export function emptyEnglish(): PraiseEnglish {
  return { title: '', slides: {} };
}

export function extrasFor(extras: Record<string, PraiseSongExtras>, songId: string): PraiseSongExtras {
  return extras[songId] ?? { english: emptyEnglish() };
}
