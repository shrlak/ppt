import type { LyricsCandidate, LyricsQuery, ScoredLyricsCandidate, LinkOnlyCandidate } from './lyrics.js';

export const AUTO_SCORE: number;
export const AUTO_MARGIN: number;
export const REVIEW_SCORE: number;
export const MIN_LYRIC_EVIDENCE: number;
export const MAX_SAMPLE_CHARS: number;
export const SAME_SONG_OVERLAP: number;

export function normalizeForMatch(value: unknown): string;
export function normalizeSample(value: unknown): string;
export function containment(needle: string, haystack: string): number;
export function pairContainment(needle: string, haystack: string): number;
export function lyricEvidence(sample: string, pageText: string): number;
export function sameSongLyrics(a: { lines?: string[] }, b: { lines?: string[] }): boolean;
export function nameSimilarity(a: unknown, b: unknown): number;
export function scoreLyricsCandidate(query: LyricsQuery, candidate: LyricsCandidate): ScoredLyricsCandidate;
export function rankLyricsCandidates(
  query: LyricsQuery,
  candidates: LyricsCandidate[],
  limit?: number,
): ScoredLyricsCandidate[];
export function publicCandidate(scored: ScoredLyricsCandidate): ScoredLyricsCandidate;
export function linkOnlyCandidate(url: string, host: string): LinkOnlyCandidate;
