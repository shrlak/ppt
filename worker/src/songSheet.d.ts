export interface SheetImageHit {
  url: string;
  host: string;
  title: string;
  pageUrl?: string;
}

export interface SheetImageCandidate extends SheetImageHit {
  /** Signed stand-in for `url`, so the browser never chooses an address. */
  token: string;
}

export const MAX_SHEET_IMAGE_BYTES: number;
export const MAX_SHEET_IMAGES: number;
export const SHEET_SEARCH_ENDPOINTS: ((query: string) => string)[];

export function buildSheetQueries(title: string): string[];
export function looksLikeImageUrl(rawUrl: string): boolean;
export function imageHostsOnly(env?: Record<string, string | undefined>): boolean;
export function isAllowedSheetImageUrl(rawUrl: string, env?: Record<string, string | undefined>): boolean;
export function extractSheetImageResults(
  html: string,
  env?: Record<string, string | undefined>,
  limit?: number,
): SheetImageHit[];
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
