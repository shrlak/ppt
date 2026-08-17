export interface LyricsCandidate {
  id: string;
  title: string;
  artist?: string;
  /** Lyric lines as printed on the source page, in order. */
  lines: string[];
  url: string;
  host: string;
  source: string;
  sourceTrust: number;
}

export interface ScoredLyricsCandidate extends LyricsCandidate {
  score: number;
  titleScore: number;
  artistScore: number;
  lyricsScore: number;
  decision: 'auto' | 'review' | 'reject';
}

/** A result the deployment has no permission to read: a link, nothing more. */
export interface LinkOnlyCandidate {
  id: string;
  source: string;
  linkOnly: true;
  url: string;
  host: string;
}

export interface LyricsQuery {
  title: string;
  artist?: string;
  /** Normalized slice of what the models read off the 악보. */
  sample?: string;
}

export const LYRICS_HOSTS: string[];

export function lyricsHosts(env?: Record<string, string | undefined>): string[];
export function buildSearchQueries(title: string, artist?: string): string[];
export function isAllowedLyricsUrl(rawUrl: string, env?: Record<string, string | undefined>): boolean;
export function isBugsUrl(rawUrl: string): boolean;
export function extractSearchResultUrls(
  html: string,
  limit?: number,
  env?: Record<string, string | undefined>,
): string[];
export function decodeHtmlEntities(text: string): string;
export function htmlToLines(html: string): string[];
export function isBoilerplateLine(line: string): boolean;
export function looksLikeLyricLine(line: string): boolean;
export function extractLyricBlock(lines: string[]): string[];
export function scoreLyricBlock(block: string[], title: string, pageText: string): number;
export function fetchLyricsCandidates(
  query: LyricsQuery,
  env?: Record<string, string | undefined>,
): Promise<{ candidates: ScoredLyricsCandidate[]; links: LinkOnlyCandidate[] }>;
