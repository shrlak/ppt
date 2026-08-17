import type { LyricsCandidate } from './lyrics.js';

export interface SourceAdapter {
  id: string;
  hosts: string[];
  trust: number;
  extract(html: string, url: string, adapter: SourceAdapter): LyricsCandidate | null;
}

export const SOURCE_ADAPTERS: SourceAdapter[];
export const BUGS_ADAPTER: SourceAdapter;

export function bugsScrapingAllowed(env?: Record<string, string | undefined>): boolean;
export function activeSourceAdapters(env?: Record<string, string | undefined>): SourceAdapter[];
export function knownSourceHosts(): string[];
export function allowedHosts(env?: Record<string, string | undefined>): string[];
export function adapterForUrl(rawUrl: string, adapters?: SourceAdapter[]): SourceAdapter | null;
export function extractPageTitle(html: string): string;
export function extractPageArtist(html: string): string;
export function extractGenericLyrics(html: string, url: string, adapter: SourceAdapter): LyricsCandidate | null;
