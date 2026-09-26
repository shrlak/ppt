export const MAX_ENGLISH_PAGES: number;
export const MAX_ENGLISH_CANDIDATES: number;

export interface EnglishLyricBlock {
  lang: 'ko' | 'en';
  lines: string[];
  label?: string;
}

export interface EnglishLyricsCandidate {
  url: string;
  host: string;
  title: string;
  englishTitle: string;
  score: number;
  blocks: EnglishLyricBlock[];
}

export interface EnglishSearchHit {
  url: string;
  host: string;
  title: string;
}

export function englishLyricsQuery(title: string): string;
export function titleKey(value: unknown): string;
export function decodeEntities(text: string): string;
export function pageLines(html: string): string[];
export function lineKind(line: string): 'ko' | 'en' | 'label' | 'blank' | 'other';
export function lyricBlocks(lines: string[]): EnglishLyricBlock[];
export function englishTitleFrom(heading: string): string;
export function englishCandidateFromPage(
  html: string,
  page: { url: string; host: string; heading?: string },
  title: string,
): EnglishLyricsCandidate | null;
export function relevantHits<T extends EnglishSearchHit>(hits: T[], title: string): T[];
export function googleEnglishSearchUrl(query: string, env?: Record<string, unknown>): string;
export function fetchEnglishLyricsCandidates(
  title: string,
  env?: Record<string, unknown>,
): Promise<{ query: string; candidates: EnglishLyricsCandidate[] }>;
