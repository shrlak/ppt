// Data model for the Bible verse slide generator, ported from
// github.com/edcho1012/kccp-bible-slide (src/types/bible.ts, src/lib/generate-pptx.ts).

export interface BibleBook {
  id: number;
  nameKo: string;
  nameEn: string;
  abbrKo: string[];
  chapters: number;
}

export interface TranslationInfo {
  id: string;
  name: string;
  language: 'ko' | 'en';
}

/** One book's text: chapters[chapterIndex][verseIndex] = verse text (0-based). */
export type BookChapters = string[][];

/** Parsed reference, e.g. "요3:16" or "롬8:28-30" or "행1:8-10". */
export interface BibleRef {
  bookId: number;
  ko: string;
  en: string;
  startChapter: number;
  startVerse?: number;
  endChapter: number;
  endVerse?: number;
}

export interface Verse {
  chapter: number;
  verse: number;
  text: string;
}

/** One planned slide's placeholder values (see PLACEHOLDERS in slideBuilder.ts). */
export interface VerseSlideData {
  [key: string]: string | undefined;
}
