// Client half of the web lyrics lookup: ask the shared proxy for a recognized
// song's published lyrics and hand back editor-ready parts.
//
// The proxy does the fetching (lyrics sites all block cross-origin reads) and
// returns plain lines; structuring and 맞춤법 normalization happen here, next
// to the rest of the editor's parsing rules.
import type { Section } from '../utils/types';
import { orderForSections, structureScrapedLyrics } from './lyricsStructure';

const PROXY_URL = import.meta.env.VITE_RECOGNITION_PROXY_URL?.trim() || undefined;

/** How long a lookup may take before the editor stops waiting for it. */
const LOOKUP_TIMEOUT_MS = 12_000;

export interface WebLyrics {
  /** Parts as published, already normalized to 한국어 맞춤법. */
  sections: Section[];
  /** Fallback play order covering each part once. */
  order: string[];
  /** Page the lyrics came from, shown to the user so they can check it. */
  sourceUrl: string;
  sourceHost: string;
}

export function hasWebLyricsLookup(): boolean {
  return !!PROXY_URL;
}

function trimTrailingSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}

/**
 * Look up a song's lyrics on the web.
 *
 * Returns null whenever the lookup can't help — no proxy configured, no
 * match found, a network failure, or a result too short to be a whole song.
 * Every caller treats that as "carry on with what the score said", so a
 * lookup failure never blocks recognition.
 */
export async function fetchWebLyrics(title: string, signal?: AbortSignal): Promise<WebLyrics | null> {
  const clean = title.trim();
  if (!PROXY_URL || !clean || /^새 찬양/.test(clean)) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LOOKUP_TIMEOUT_MS);
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort);

  try {
    const response = await fetch(
      `${trimTrailingSlash(PROXY_URL)}/lyrics?title=${encodeURIComponent(clean)}`,
      { method: 'GET', headers: { Accept: 'application/json' }, signal: controller.signal },
    );
    if (!response.ok) return null;
    const payload = (await response.json()) as {
      lines?: unknown;
      url?: unknown;
      host?: unknown;
    };
    const lines = Array.isArray(payload.lines)
      ? payload.lines.filter((line): line is string => typeof line === 'string')
      : [];
    if (lines.length === 0) return null;

    const sections = structureScrapedLyrics(lines);
    if (sections.length === 0) return null;
    return {
      sections,
      order: orderForSections(sections),
      sourceUrl: typeof payload.url === 'string' ? payload.url : '',
      sourceHost: typeof payload.host === 'string' ? payload.host : '',
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}
