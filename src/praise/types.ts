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
  /** Put a 기도 / Prayer slide right after this song. */
  prayerAfter?: boolean;
  /**
   * Where the English came from, so the card can say how far to trust it:
   * last year's deck / a saved song, the chord sheet the conti was uploaded
   * as, the AI, or the operator's own typing.
   */
  englishSource?: 'memory' | 'sheet' | 'ai' | 'manual';
}

export interface PraiseCoverImage {
  name: string;
  mimeType: 'image/png' | 'image/jpeg';
  data: ArrayBuffer;
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

export function emptyEnglish(): PraiseEnglish {
  return { title: '', slides: {} };
}

export function extrasFor(extras: Record<string, PraiseSongExtras>, songId: string): PraiseSongExtras {
  return extras[songId] ?? { english: emptyEnglish() };
}
