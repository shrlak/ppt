export interface SongPptHit {
  url: string;
  host: string;
  title: string;
  /** True when the hit is the .pptx itself rather than a page carrying one. */
  direct: boolean;
  /** True when the host is one known to share 찬양 PPT files. */
  known?: boolean;
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
export const MAX_SONG_PPT_BYTES: number;
export const MAX_SONG_PPT_CANDIDATES: number;
export const SONG_PPT_TOKEN_TTL_MS: number;
export const MAX_WEDNESDAY_SONG_ENTRIES: number;

export function buildSongPptQueries(title: string): string[];
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
export function isNeverFileHost(rawUrl: string): boolean;
export function isAllowedSongPptUrl(rawUrl: string, env?: Record<string, string | undefined>): boolean;
export function looksLikePptxUrl(rawUrl: string): boolean;
export function extractSongPptResults(
  html: string,
  env?: Record<string, string | undefined>,
  limit?: number,
): { results: SongPptHit[]; links: SongPptLink[] };
export function findSongPptAttachment(
  html: string,
  pageUrl: string,
  env?: Record<string, string | undefined>,
): string | null;

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
