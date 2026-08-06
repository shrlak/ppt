export interface WebLyricsResult {
  /** Lyric lines as printed on the source page, in order. */
  lines: string[];
  url: string;
  host: string;
}

export const LYRICS_HOSTS: string[];

export function buildSearchQueries(title: string): string[];
export function isAllowedLyricsUrl(rawUrl: string): boolean;
export function extractSearchResultUrls(html: string, limit?: number): string[];
export function decodeHtmlEntities(text: string): string;
export function htmlToLines(html: string): string[];
export function isBoilerplateLine(line: string): boolean;
export function looksLikeLyricLine(line: string): boolean;
export function extractLyricBlock(lines: string[]): string[];
export function scoreLyricBlock(block: string[], title: string, pageText: string): number;
export function fetchWebLyrics(title: string): Promise<WebLyricsResult | null>;
