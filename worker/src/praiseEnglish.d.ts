export interface PraiseEnglishSlide {
  ko: string[];
  en: string[];
}

export interface PraiseEnglishEntry {
  title: string;
  englishTitle: string;
  slides: PraiseEnglishSlide[];
  updatedAt: string;
}

export const MAX_PRAISE_ENGLISH_ENTRIES: number;
export function sanitizePraiseEnglishEntry(raw: unknown): PraiseEnglishEntry | null;
export function sanitizePraiseEnglishEntries(raw: unknown): PraiseEnglishEntry[];
