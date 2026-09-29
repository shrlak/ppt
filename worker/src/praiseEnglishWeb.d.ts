export const MAX_ENGLISH_PAGES: number;
export const MAX_BUGS_PAGES: number;
export const MAX_ENGLISH_CANDIDATES: number;
export const BUGS_SEARCH_ENDPOINT: string;

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
  /** The English title a Bugs track is listed under, when the search read one. */
  englishTitle?: string;
}

export function englishLyricsQuery(title: string): string;
export function titleKey(value: unknown): string;
export function decodeEntities(text: string): string;
export function pageLines(html: string): string[];
export function lineKind(line: string): 'ko' | 'en' | 'label' | 'blank' | 'other';
export function lyricBlocks(lines: string[]): EnglishLyricBlock[];
export function englishTitleFrom(heading: string, songTitle?: string): string;
export function isGeniusUrl(url: string): boolean;
export function geniusLyricsHtml(html: string): string;
export function geniusSongTitle(pageHeading: string): string;
export function bugsSearchUrl(title: string): string;
export function bugsTrackId(url: string): string;
export function bugsTitleNames(trackTitle: string, title: string): boolean;
export function extractBugsTrackHits(html: string, title: string): (EnglishSearchHit & { englishTitle: string })[];
export function bugsLyricsHtml(html: string): string;
export function englishCandidateFromPage(
  html: string,
  page: { url: string; host: string; heading?: string; englishTitle?: string },
  title: string,
): EnglishLyricsCandidate | null;
export function relevantHits<T extends EnglishSearchHit>(hits: T[], title: string): T[];
export function googleEnglishSearchUrl(query: string, env?: Record<string, unknown>): string;
export function duckDuckGoSearchUrl(query: string): string;
export function englishTitleFromHits(hits: EnglishSearchHit[], title: string): string;
export function fetchEnglishLyricsCandidates(
  title: string,
  env?: Record<string, unknown>,
): Promise<{ query: string; englishTitle: string; candidates: EnglishLyricsCandidate[] }>;
