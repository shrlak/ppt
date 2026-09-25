export interface SheetImageHit {
  url: string;
  host: string;
  title: string;
  pageUrl?: string;
  /** The original's pixel size, when the search reports it. */
  width?: number;
  height?: number;
}

export interface SheetImageCandidate extends SheetImageHit {
  /** Signed stand-in for `url`, so the browser never chooses an address. */
  token: string;
  /** How well the hit's own title matches the song, 0..1. */
  score?: number;
  /** 'auto' when it is this song's 악보, 'review' when it is a guess. */
  decision?: 'auto' | 'review';
}

export const MAX_SHEET_IMAGE_BYTES: number;
export const MAX_SHEET_IMAGES: number;
export const SHEET_SEARCH_ENDPOINTS: ((query: string) => string)[];

export function buildSheetQueries(title: string): string[];
export function naverImageSearchUrl(query: string): string;
export function looksLikeImageUrl(rawUrl: string): boolean;
export function imageHostsOnly(env?: Record<string, string | undefined>): boolean;
export function isAllowedSheetImageUrl(rawUrl: string, env?: Record<string, string | undefined>): boolean;
export function extractSheetImageResults(
  html: string,
  env?: Record<string, string | undefined>,
  limit?: number,
): SheetImageHit[];
export function fetchableImageUrl(rawUrl: string): string | null;
export function extractNaverImageResults(
  html: string,
  env?: Record<string, string | undefined>,
  limit?: number,
): SheetImageHit[];
export function sheetLikeness(hit: Partial<SheetImageHit>): number;
export function keysNamed(title: string): number;
export function rankSheetImages<T extends SheetImageHit>(
  title: string,
  hits: T[],
): (T & { score: number; decision: 'auto' | 'review' })[];
export function isImageBytes(bytes: Uint8Array | ArrayBuffer | null | undefined): boolean;
export function imageMimeType(bytes: Uint8Array | ArrayBuffer): 'image/png' | 'image/jpeg';
export function fetchSheetImageCandidates(
  title: string,
  env?: Record<string, string | undefined>,
  sign?: ((url: string) => Promise<string>) | null,
): Promise<{ candidates: SheetImageCandidate[] }>;
export function fetchSheetImage(
  rawUrl: string,
  env?: Record<string, string | undefined>,
): Promise<{ bytes: Uint8Array; url: string; mimeType: 'image/png' | 'image/jpeg' }>;
export function hostOf(rawUrl: string): string;
export { songPptHosts } from './songPpt.js';
