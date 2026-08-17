// Web lyrics lookup for the 찬양 가사 editor.
//
// Once a song's title is recognized off the conti, the editor can be seeded
// from the song's published lyrics instead of from OCR alone. The browser
// cannot do that itself — every lyrics site blocks cross-origin reads — so the
// proxy performs the lookup and hands back plain text.
//
// The pipeline is: search the web for the title, keep only results on the
// allowlisted Korean worship-lyrics hosts, fetch the best few, and extract the
// lyric block from each page. The client turns that text into labeled parts;
// this file stays out of the structuring business so the parsing rules live
// next to the rest of the editor's parsing rules.
//
// Everything except fetchLyricsCandidates is a pure function of its input, so
// the whole extraction chain is unit-tested without network access.

import {
  BUGS_ADAPTER,
  activeSourceAdapters,
  adapterForUrl,
  allowedHosts,
  bugsScrapingAllowed,
} from './lyricsSources.js';
import { linkOnlyCandidate, publicCandidate, rankLyricsCandidates } from './lyricsCandidates.js';
import { decodeHtmlEntities } from './lyricsHtml.js';

// Re-exported so existing importers (and the unit tests) keep one entry point
// for the whole lookup chain.
export {
  decodeHtmlEntities,
  extractLyricBlock,
  htmlToLines,
  isBoilerplateLine,
  looksLikeLyricLine,
  scoreLyricBlock,
} from './lyricsHtml.js';

/**
 * Hosts the proxy is willing to fetch. The client only ever sends a title —
 * never a URL — and search results are filtered against this list, so an
 * attacker-influenced search result can't turn the proxy into an open relay
 * for arbitrary hosts (SSRF).
 *
 * Derived from the source adapters so a host can only become fetchable by
 * gaining an adapter, and a permission-gated adapter (Bugs) stays out until
 * the deployment turns it on.
 */
export function lyricsHosts(env = {}) {
  return allowedHosts(env);
}

/** Default allowlist, for callers with no environment to consult. */
export const LYRICS_HOSTS = allowedHosts({});

/** Search engines are tried in order until one returns usable result links. */
const SEARCH_ENDPOINTS = [
  (query) => `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
  (query) => `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`,
];

/** Per-request ceilings, so one lookup can never stall the Worker. */
const FETCH_TIMEOUT_MS = 6000;
const MAX_CANDIDATES = 3;
const MAX_HTML_BYTES = 900_000;

/** Search phrasings, most specific first. An artist narrows a common title. */
export function buildSearchQueries(title, artist = '') {
  const clean = String(title || '').trim();
  if (!clean) return [];
  const performer = String(artist || '').trim();
  return performer
    ? [`${clean} ${performer} 가사`, `${clean} 찬양 가사`, `${clean} 가사`]
    : [`${clean} 찬양 가사`, `${clean} 가사`];
}

/** True when a URL is on a host the proxy may fetch. */
export function isAllowedLyricsUrl(rawUrl, env = {}) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:') return false;
  return lyricsHosts(env).includes(parsed.hostname.toLowerCase());
}

/** True when a URL is a Bugs page — readable only with recorded permission. */
export function isBugsUrl(rawUrl) {
  try {
    return BUGS_ADAPTER.hosts.includes(new URL(rawUrl).hostname.toLowerCase());
  } catch {
    return false;
  }
}

/**
 * Pull candidate result links out of a search engine's HTML.
 *
 * DuckDuckGo's HTML endpoint wraps every outbound link in a redirector
 * (`/l/?uddg=<encoded>`), so the real URL is unwrapped before filtering.
 * Results are deduplicated and capped, and anything off the allowlist is
 * dropped here rather than at fetch time.
 */
export function extractSearchResultUrls(html, limit = MAX_CANDIDATES, env = {}) {
  const urls = [];
  const seen = new Set();
  const hrefPattern = /href="([^"]+)"/gi;
  let match;
  while ((match = hrefPattern.exec(String(html || ''))) !== null) {
    let href = decodeHtmlEntities(match[1]);
    const redirect = href.match(/[?&]uddg=([^&]+)/);
    if (redirect) {
      try {
        href = decodeURIComponent(redirect[1]);
      } catch {
        continue;
      }
    }
    if (href.startsWith('//')) href = `https:${href}`;
    if (!isAllowedLyricsUrl(href, env)) continue;
    const key = href.split('#')[0];
    if (seen.has(key)) continue;
    seen.add(key);
    urls.push(key);
    if (urls.length >= limit) break;
  }
  return urls;
}

/** Fetch with a hard timeout so a slow site can't hold the request open. */
async function fetchWithTimeout(url, init = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: {
        // Some hosts serve an empty shell to clients with no UA at all.
        'User-Agent': 'Mozilla/5.0 (compatible; KCCP-Lyrics/1.0)',
        'Accept-Language': 'ko,en;q=0.8',
        ...(init.headers || {}),
      },
    });
  } finally {
    clearTimeout(timer);
  }
}

/** Read a response body, refusing pages too large to be worth scanning. */
async function readBoundedText(response) {
  const declared = Number(response.headers.get('content-length') || 0);
  if (declared > MAX_HTML_BYTES) return '';
  const text = await response.text();
  return text.length > MAX_HTML_BYTES ? text.slice(0, MAX_HTML_BYTES) : text;
}

/**
 * Look a song's lyrics up on the web and return the best few CANDIDATES.
 *
 * Returning several scored candidates rather than one answer is the point:
 * several different Korean worship songs share a title, so the decision of
 * which page is this song belongs to the scorer (and sometimes to the user),
 * not to whichever page happened to rank highest on a search engine.
 *
 * Every page is fetched through the allowlist, and the FINAL url after
 * redirects is re-checked before the body is read — otherwise an allowlisted
 * host could redirect the proxy anywhere.
 */
export async function fetchLyricsCandidates(query, env = {}) {
  const queries = buildSearchQueries(query.title, query.artist);
  if (queries.length === 0) return { candidates: [], links: [] };
  const adapters = activeSourceAdapters(env);

  const urls = [];
  const links = [];
  for (const search of queries) {
    for (const endpoint of SEARCH_ENDPOINTS) {
      try {
        const response = await fetchWithTimeout(endpoint(search));
        if (!response.ok) continue;
        const html = await readBoundedText(response);
        for (const url of extractSearchResultUrls(html, MAX_CANDIDATES, env)) {
          if (!urls.includes(url)) urls.push(url);
        }
        // A Bugs hit is worth telling the user about even when this deployment
        // may not read it — the link is theirs to open.
        if (!bugsScrapingAllowed(env)) {
          for (const url of bugsSearchResultUrls(html)) {
            if (!links.some((link) => link.url === url)) {
              links.push(linkOnlyCandidate(url, new URL(url).hostname));
            }
          }
        }
        if (urls.length > 0) break;
      } catch {
        // A search engine being unreachable just means trying the next one.
      }
    }
    if (urls.length >= MAX_CANDIDATES) break;
  }

  const candidates = [];
  for (const url of urls.slice(0, MAX_CANDIDATES)) {
    try {
      const response = await fetchWithTimeout(url);
      if (!response.ok) continue;
      // Re-check where we actually landed: an allowlisted host may redirect.
      const finalUrl = response.url || url;
      const adapter = adapterForUrl(finalUrl, adapters);
      if (!adapter) continue;
      const candidate = adapter.extract(await readBoundedText(response), finalUrl, adapter);
      if (candidate) candidates.push(candidate);
    } catch {
      // Skip a page that refuses the fetch; the next candidate may work.
    }
  }

  return { candidates: rankLyricsCandidates(query, candidates).map(publicCandidate), links };
}

/** Bugs result links from a search page, for the permission-off case. */
function bugsSearchResultUrls(html) {
  const urls = [];
  const hrefPattern = /href="([^"]+)"/gi;
  let match;
  while ((match = hrefPattern.exec(String(html || ''))) !== null) {
    let href = decodeHtmlEntities(match[1]);
    const redirect = href.match(/[?&]uddg=([^&]+)/);
    if (redirect) {
      try {
        href = decodeURIComponent(redirect[1]);
      } catch {
        continue;
      }
    }
    if (!href.startsWith('https://') || !isBugsUrl(href)) continue;
    const clean = href.split('#')[0];
    if (!urls.includes(clean)) urls.push(clean);
    if (urls.length >= 2) break;
  }
  return urls;
}
