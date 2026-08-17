// Client half of the web lyrics lookup: ask the shared proxy for a recognized
// song's published lyrics and hand back editor-ready candidates.
//
// The proxy does the fetching (lyrics sites all block cross-origin reads) and
// the scoring (it is the only side that sees the pages). What crosses the wire
// back is a small ranked list, because several different Korean worship songs
// share a title and picking the wrong page would replace a conti's lyrics with
// a different song's. Structuring and 맞춤법 normalization happen here, next to
// the rest of the editor's parsing rules.
import type { Section } from '../utils/types';
import { orderForSections, structureScrapedLyrics } from './lyricsStructure';

const PROXY_URL = import.meta.env.VITE_RECOGNITION_PROXY_URL?.trim() || undefined;

/** How long a lookup may take before the editor stops waiting for it. */
const LOOKUP_TIMEOUT_MS = 12_000;

/** Most recognized-lyric characters sent as matching evidence. */
export const MAX_SAMPLE_CHARS = 300;

/** How sure the proxy is that a candidate is this song. */
export type CandidateDecision = 'auto' | 'review' | 'reject';

export interface ScoredLyricsCandidate {
  id: string;
  title: string;
  artist?: string;
  /** Parts as published, already normalized to 한국어 맞춤법. */
  sections: Section[];
  /** Fallback play order covering each part once. */
  order: string[];
  sourceUrl: string;
  sourceHost: string;
  source: string;
  score: number;
  titleScore: number;
  artistScore: number;
  lyricsScore: number;
  decision: CandidateDecision;
}

/** A search hit this deployment may not read, offered to the user as a link. */
export interface LyricsSourceLink {
  url: string;
  host: string;
  source: string;
}

export interface WebLyricsLookup {
  candidates: ScoredLyricsCandidate[];
  links: LyricsSourceLink[];
}

export function hasWebLyricsLookup(): boolean {
  return !!PROXY_URL;
}

function trimTrailingSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}

/**
 * A slice of what the models read, as matching evidence.
 *
 * Normalized and capped before it leaves the browser: the proxy only needs
 * enough characters to tell one song from another, and sending a whole song's
 * lyrics to a third party to look up that song's lyrics would be absurd.
 */
export function lyricSample(sections: { lines: string[] }[]): string {
  return sections
    .flatMap((section) => section.lines)
    .join('')
    .toLowerCase()
    .replace(/[^0-9a-zㄱ-ㆎ가-힣]+/g, '')
    .slice(0, MAX_SAMPLE_CHARS);
}

const DECISIONS: CandidateDecision[] = ['auto', 'review', 'reject'];

function unitNumber(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 && number <= 1 ? number : 0;
}

/** Turn one proxy row into an editor-ready candidate, or drop it. */
function toCandidate(raw: unknown): ScoredLyricsCandidate | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>;
  const lines = Array.isArray(value.lines)
    ? value.lines.filter((line): line is string => typeof line === 'string')
    : [];
  if (lines.length === 0) return null;
  const sections = structureScrapedLyrics(lines);
  if (sections.length === 0) return null;
  const decision = DECISIONS.includes(value.decision as CandidateDecision)
    ? (value.decision as CandidateDecision)
    : 'reject';
  return {
    id: typeof value.id === 'string' && value.id ? value.id : `${value.host ?? 'web'}:${lines.length}`,
    title: typeof value.title === 'string' ? value.title : '',
    artist: typeof value.artist === 'string' && value.artist ? value.artist : undefined,
    sections,
    order: orderForSections(sections),
    sourceUrl: typeof value.url === 'string' ? value.url : '',
    sourceHost: typeof value.host === 'string' ? value.host : '',
    source: typeof value.source === 'string' ? value.source : 'web',
    score: unitNumber(value.score),
    titleScore: unitNumber(value.titleScore),
    artistScore: unitNumber(value.artistScore),
    lyricsScore: unitNumber(value.lyricsScore),
    decision,
  };
}

function toLink(raw: unknown): LyricsSourceLink | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>;
  if (typeof value.url !== 'string' || !/^https:\/\//.test(value.url)) return null;
  return {
    url: value.url,
    host: typeof value.host === 'string' ? value.host : '',
    source: typeof value.source === 'string' ? value.source : 'web',
  };
}

export interface WebLyricsQuery {
  title: string;
  artist?: string;
  /** What the models read, used as evidence that a page is the same song. */
  sample?: string;
}

/**
 * Look a song's lyrics up on the web.
 *
 * Returns an empty lookup whenever it can't help — no proxy configured, no
 * match found, a network failure. Every caller treats that as "carry on with
 * what the score said", so a lookup failure never blocks recognition.
 */
export async function fetchWebLyrics(
  query: WebLyricsQuery | string,
  signal?: AbortSignal,
): Promise<WebLyricsLookup> {
  const request = typeof query === 'string' ? { title: query } : query;
  const clean = request.title.trim();
  const empty: WebLyricsLookup = { candidates: [], links: [] };
  if (!PROXY_URL || !clean || /^새 찬양/.test(clean)) return empty;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LOOKUP_TIMEOUT_MS);
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort);

  try {
    const params = new URLSearchParams({ title: clean });
    if (request.artist?.trim()) params.set('artist', request.artist.trim());
    if (request.sample) params.set('sample', request.sample.slice(0, MAX_SAMPLE_CHARS));
    const response = await fetch(`${trimTrailingSlash(PROXY_URL)}/lyrics?${params.toString()}`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
    if (!response.ok) return empty;
    const payload = (await response.json()) as { candidates?: unknown; links?: unknown };
    const candidates = Array.isArray(payload.candidates)
      ? payload.candidates
          .map(toCandidate)
          .filter((candidate): candidate is ScoredLyricsCandidate => candidate !== null)
          .filter((candidate) => candidate.decision !== 'reject')
      : [];
    const links = Array.isArray(payload.links)
      ? payload.links.map(toLink).filter((link): link is LyricsSourceLink => link !== null)
      : [];
    return { candidates, links };
  } catch {
    return empty;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}
