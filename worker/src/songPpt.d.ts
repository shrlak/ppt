export interface SongPptHit {
  url: string;
  host: string;
  title: string;
  /** True when the hit is the .pptx itself rather than a page carrying one. */
  direct: boolean;
  /** True when the host is one known to share 찬양 PPT files. */
  known?: boolean;
  /** What a blog search's snippet says the post has attached, when it says. */
  attachment?: 'pptx' | 'ppt';
  /** True when the hit's title or snippet says its PPT has the 악보. */
  sheet?: boolean;
}

export interface SongPptCandidate extends SongPptHit {
  /** Signed stand-in for `url`, so the browser never chooses an address. */
  token: string;
  /** How well the hit's own title matches the song, 0..1. */
  score?: number;
  /** 'auto' when it is confidently this song, 'review' when it is a guess. */
  decision?: 'auto' | 'review';
}

export interface SongPptLink {
  url: string;
  host: string;
  title: string;
}

export interface WednesdaySongEntry {
  title: string;
  sourceUrl?: string;
  sourceHost?: string;
  slideCount?: number;
  updatedAt: string;
}

export const DEFAULT_SONG_PPT_HOSTS: string[];
export const PREFERRED_SONG_PPT_HOSTS: string[];
export const GOOGLE_SONG_PPT_SITES: string[];
export const GOOGLE_SEARCH_ENDPOINT: string;
export const MAX_SONG_PPT_BYTES: number;
export const MAX_SONG_PPT_CANDIDATES: number;
export const SONG_PPT_TOKEN_TTL_MS: number;
export const MAX_WEDNESDAY_SONG_ENTRIES: number;

export function buildSongPptQueries(title: string): string[];
export function mentionsSheet(text: string): boolean;
export function googleSearchKey(env?: Record<string, string | undefined>): string;
export function googleSongPptQuery(query: string): string;
export function googleSearchUrl(query: string, env?: Record<string, string | undefined>): string;
export function fetchGoogleSearch(query: string, env?: Record<string, string | undefined>): Promise<Response>;
export function extractGoogleResults(
  payload: unknown,
  env?: Record<string, string | undefined>,
  limit?: number,
): { results: SongPptHit[]; links: SongPptLink[] };
export function scoreSongMatch(title: string, text: string): number;
export const AUTO_ATTACH_SCORE: number;
export function rankSongMatches<T extends { title?: string; url?: string }>(
  title: string,
  hits: T[],
): (T & { score: number; decision: 'auto' | 'review' })[];
export function fetchWithTimeout(
  url: string,
  options?: { timeoutMs?: number; headers?: Record<string, string> },
): Promise<Response>;
export function readBoundedText(response: Response): Promise<string>;
export function songPptHosts(env?: Record<string, string | undefined>): string[];
export function songPptHostsOnly(env?: Record<string, string | undefined>): boolean;
export function isKnownSongPptHost(rawUrl: string, env?: Record<string, string | undefined>): boolean;
export function isPreferredSongPptHost(rawUrl: string): boolean;
export function isNeverFileHost(rawUrl: string): boolean;
export function isAllowedSongPptUrl(rawUrl: string, env?: Record<string, string | undefined>): boolean;
export function looksLikePptxUrl(rawUrl: string): boolean;
export function looksLikeModernPptxUrl(rawUrl: string): boolean;
export function extractSongPptResults(
  html: string,
  env?: Record<string, string | undefined>,
  limit?: number,
): { results: SongPptHit[]; links: SongPptLink[] };
export function daumBlogSearchUrl(query: string): string;
export function naverBlogSearchUrl(query: string): string;
export function attachmentKind(text: string): 'pptx' | 'ppt' | undefined;
export function extractDaumBlogResults(
  html: string,
  env?: Record<string, string | undefined>,
  limit?: number,
): { results: SongPptHit[]; links: SongPptLink[] };
export function extractNaverBlogResults(
  html: string,
  env?: Record<string, string | undefined>,
  limit?: number,
): { results: SongPptHit[]; links: SongPptLink[] };
export function mobileNaverBlogUrl(rawUrl: string): string | null;
export const SET_LIST_TITLE: RegExp;
export function rankSongPptHits<T extends SongPptHit>(
  title: string,
  hits: T[],
): (T & { score: number; decision: 'auto' | 'review' })[];
export function findSongPptAttachment(
  html: string,
  pageUrl: string,
  env?: Record<string, string | undefined>,
): string | null;
export function hasLegacyPptAttachment(html: string, pageUrl: string): boolean;
export function pptVersionRank(name: string): number;

export function signSongPptToken(
  url: string,
  secret: string,
  options?: { now?: number; ttlMs?: number },
): Promise<string>;
export function verifySongPptToken(
  token: string,
  secret: string,
  options?: { now?: number },
): Promise<string | null>;

export function isPptxBytes(bytes: Uint8Array | ArrayBuffer | null | undefined): boolean;
export function fetchSongPptCandidates(
  title: string,
  env?: Record<string, string | undefined>,
  secret?: string,
): Promise<{ candidates: SongPptCandidate[]; links: SongPptLink[] }>;
export function fetchSongPptFile(
  rawUrl: string,
  env?: Record<string, string | undefined>,
): Promise<{ bytes: Uint8Array; url: string }>;

export function sanitizeWednesdaySongEntry(raw: unknown): WednesdaySongEntry | null;
export function sanitizeWednesdaySongEntries(raw: unknown): WednesdaySongEntry[];
