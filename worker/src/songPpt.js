// 수요예배 찬양 PPT lookup: find a song's .pptx on the web and hand the file
// to the browser.
//
// The browser cannot do either half itself. Search result pages and file hosts
// send no CORS headers, so `fetch(url)` from the app's origin is refused
// before it starts — the proxy has to fetch on its behalf.
//
// That makes this the one route family that returns bytes from an arbitrary
// outside URL, so the invariant the lyrics route states ("only a title crosses
// the wire — never a URL") is kept here too, by a different means: search
// hands back an opaque HMAC-signed token per hit instead of a URL, so the
// address fetched is one this proxy chose off its own search.
//
// Which addresses those may be is decided by what comes back, not by a host
// list: https only, never an address that resolves inside, a 25MB cap, the URL
// re-checked after redirects, and bytes that really are a PowerPoint package.
// A host list would have to name every 자료실 and 티스토리 blog that has ever
// hosted a 찬양 PPT, and the way a song is really found is to search its title
// and open whatever comes up first. A deployment that wants the list anyway
// sets WEDNESDAY_PPT_HOSTS_ONLY=true. Uploading the file by hand stays the
// path that always works (네이버 카페 and anything else behind a login can
// never be automated).
//
// Everything except fetchSongPptCandidates/fetchSongPptFile is a pure
// function of its input, so the whole chain is unit-tested without network.

/**
 * Hosts known to carry a 찬양 PPT.
 *
 * This is no longer a permission list — see isAllowedSongPptUrl below — but it
 * is still what the search prefers, because a hit on one of these is far more
 * likely to end in a real file than a hit on some news page. An entry matches
 * the host itself and every subdomain, so `tistory.com` covers the hundreds of
 * `*.tistory.com` blogs that share one.
 *
 * These are the places this church actually downloads from. A deployment adds
 * its own with the WEDNESDAY_PPT_HOSTS variable.
 */
export const DEFAULT_SONG_PPT_HOSTS = [
  // 네이버 블로그 — the post is on blog.naver.com, its attachments on these.
  'blog.naver.com',
  'm.blog.naver.com',
  'blogfiles.pstatic.net',
  'postfiles.pstatic.net',
  // 네이버 카페 — a public café attachment can be relayed; anything behind a
  // login simply fails the fetch, and the operator uploads instead.
  'cafe.naver.com',
  'cafefiles.naver.net',
  'cafeptthumb-phinf.pstatic.net',
  // 갓피플 — 악보·PPT 자료실, every subdomain.
  'godpeople.com',
  'godpeople.co.kr',
  // 티스토리 — the blog is *.tistory.com, its attachments on Kakao's CDNs.
  'tistory.com',
  'blog.kakaocdn.net',
  'daumcdn.net',
];

/**
 * Hosts that are never where a file is, however well their title matches.
 *
 * Search for a song title and the first page of hits is mostly streaming and
 * video. Following one costs a fetch that can only fail, so page hits from
 * these are shown as links rather than tried.
 */
const NEVER_FILE_HOSTS = [
  'youtube.com',
  'youtu.be',
  'music.youtube.com',
  'bugs.co.kr',
  'melon.com',
  'genie.co.kr',
  'flo.co.kr',
  'spotify.com',
  'apple.com',
  'instagram.com',
  'facebook.com',
  'twitter.com',
  'x.com',
  'tiktok.com',
  'namu.wiki',
  'wikipedia.org',
];

/** Per-request ceilings, so one lookup can never stall the Worker. */
const SEARCH_TIMEOUT_MS = 6000;
const DOWNLOAD_TIMEOUT_MS = 20_000;
const MAX_HTML_BYTES = 900_000;
export const MAX_SONG_PPT_BYTES = 25 * 1024 * 1024;
export const MAX_SONG_PPT_CANDIDATES = 6;

/** How long a search result's token stays usable. */
export const SONG_PPT_TOKEN_TTL_MS = 30 * 60 * 1000;

const SEARCH_ENDPOINTS = [
  (query) => `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
  (query) => `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`,
];

/** Search phrasings, most specific first. */
export function buildSongPptQueries(title) {
  const clean = String(title || '').trim();
  if (!clean) return [];
  return [`${clean} 찬양 ppt`, `${clean} ppt 다운로드`, `${clean} 악보 ppt`];
}

/** The known-host list for this deployment: the defaults plus its own. */
export function songPptHosts(env = {}) {
  const extra = String(env.WEDNESDAY_PPT_HOSTS || '')
    .split(',')
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean);
  return [...new Set([...DEFAULT_SONG_PPT_HOSTS, ...extra])];
}

/** True when `hostname` is `entry` or a subdomain of it. */
function hostMatches(hostname, entry) {
  const host = String(hostname || '').toLowerCase();
  const want = String(entry || '').toLowerCase();
  if (!host || !want) return false;
  return host === want || host.endsWith(`.${want}`);
}

/** True when two hosts share their last two labels, e.g. a post and its CDN. */
function sameSite(a, b) {
  const labels = (host) => String(host || '').toLowerCase().split('.').slice(-2).join('.');
  const site = labels(a);
  return Boolean(site) && site === labels(b);
}

/** True when this host is one we know shares 찬양 PPT files. */
export function isKnownSongPptHost(rawUrl, env = {}) {
  let hostname;
  try {
    hostname = new URL(rawUrl).hostname;
  } catch {
    return false;
  }
  return songPptHosts(env).some((entry) => hostMatches(hostname, entry));
}

/** True when this host never holds a file, whatever its page is titled. */
export function isNeverFileHost(rawUrl) {
  let hostname;
  try {
    hostname = new URL(rawUrl).hostname;
  } catch {
    return true;
  }
  return NEVER_FILE_HOSTS.some((entry) => hostMatches(hostname, entry));
}

/**
 * True when this deployment restricts downloads to the known-host list.
 *
 * Off by default, because the way a song is actually found is to search the
 * title and open whichever site comes up first — 네이버 블로그 one week, 갓피플
 * or some 티스토리 blog the next. An allowlist would turn most of those into
 * "직접 올려 주세요", which is the manual work this route exists to remove.
 */
export function songPptHostsOnly(env = {}) {
  return String(env.WEDNESDAY_PPT_HOSTS_ONLY || '').toLowerCase() === 'true';
}

/** Hostnames that are never a public file host, whatever an allowlist says. */
function isLocalHostname(hostname) {
  if (!hostname) return true;
  const host = hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host.endsWith('.local') || host.endsWith('.internal')) return true;
  // IP literals: a host that resolves to itself bypasses the point of a
  // hostname allowlist, and private ranges are the SSRF target.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return true;
  if (host.startsWith('[') || host.includes(':')) return true;
  return false;
}

/**
 * True when the proxy may fetch this URL at all.
 *
 * What makes this safe is not the host but what comes back: only bytes that
 * really are a PowerPoint package are ever returned (isPptxBytes), under a
 * 25MB cap, over https, never to an address that resolves inside, and the URL
 * after redirects is checked again. That is the same posture the 악보 사진
 * route already takes, for the same reason — the files are everywhere.
 * WEDNESDAY_PPT_HOSTS_ONLY=true restores the old allowlist behaviour.
 */
export function isAllowedSongPptUrl(rawUrl, env = {}) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:') return false;
  if (isLocalHostname(parsed.hostname)) return false;
  if (songPptHostsOnly(env)) return isKnownSongPptHost(rawUrl, env);
  return true;
}

/** True when a URL names a PowerPoint file outright. */
export function looksLikePptxUrl(rawUrl) {
  try {
    return /\.pptx?(?:$|[?#])/i.test(new URL(rawUrl).pathname + new URL(rawUrl).search);
  } catch {
    return false;
  }
}

function decodeEntities(value) {
  return String(value || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)));
}

/** Unwrap a DuckDuckGo redirector link back into the real URL. */
function unwrapSearchHref(href) {
  let url = decodeEntities(href);
  const redirect = url.match(/[?&]uddg=([^&]+)/);
  if (redirect) {
    try {
      url = decodeURIComponent(redirect[1]);
    } catch {
      return null;
    }
  }
  if (url.startsWith('//')) url = `https:${url}`;
  if (!/^https?:/i.test(url)) return null;
  return url.split('#')[0];
}

/**
 * Pull 찬양 PPT hits out of a search engine's HTML.
 *
 * Three kinds of hit come back. A link straight to a .pptx is best. A page is
 * next — the file is usually an attachment on the post, which the download
 * route follows one step to reach, exactly as a person would. Hits from hosts
 * that never carry a file (streaming, video, wikis) and anything this
 * deployment may not fetch are returned as `links` instead: shown so the
 * operator can open them by hand, never fetched.
 *
 * Known 찬양 자료 hosts come first, so 네이버 블로그·갓피플·티스토리 outrank a
 * random page that happens to share a word with the title.
 */
export function extractSongPptResults(html, env = {}, limit = MAX_SONG_PPT_CANDIDATES) {
  const results = [];
  const links = [];
  const seen = new Set();
  const text = String(html || '');

  for (const match of text.matchAll(/<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)) {
    if (results.length >= limit * 5) break;
    const url = unwrapSearchHref(match[1]);
    if (!url) continue;
    const key = url.replace(/\/$/, '');
    if (seen.has(key)) continue;
    // Search engines link their own pages on every result page.
    let host;
    try {
      host = new URL(url).hostname.toLowerCase();
    } catch {
      continue;
    }
    if (/duckduckgo\.com$/.test(host)) continue;
    seen.add(key);

    const title = decodeEntities(match[2].replace(/<[^>]*>/g, ' '))
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 160);

    const direct = looksLikePptxUrl(url);
    if (isAllowedSongPptUrl(url, env) && (direct || !isNeverFileHost(url))) {
      results.push({ url, host, title, direct, known: isKnownSongPptHost(url, env) });
    } else if (direct && links.length < limit) {
      // A .pptx this deployment may not relay is still worth showing.
      links.push({ url, host, title });
    }
  }

  // A file beats a post, and a host we know beats one we do not.
  const rank = (hit) => (hit.direct ? 0 : 1) + (hit.known ? 0 : 2);
  return {
    results: results
      .map((hit, index) => ({ hit, index }))
      .sort((a, b) => rank(a.hit) - rank(b.hit) || a.index - b.index)
      .slice(0, limit)
      .map(({ hit }) => hit),
    links,
  };
}

function absoluteUrl(rawUrl, pageUrl) {
  let url = decodeEntities(rawUrl);
  if (url.startsWith('//')) url = `https:${url}`;
  try {
    return new URL(url, pageUrl).toString();
  } catch {
    return null;
  }
}

/**
 * Find the .pptx attachment on a post.
 *
 * Two shapes cover what the Korean blog platforms do. 네이버 and 티스토리 link
 * the file itself, so the address ends in .pptx. 갓피플 and most 자료실 boards
 * link a download script instead, and the only place the file name appears is
 * the link's own text — so a link labelled `찬양.pptx` is taken as the
 * attachment even when its address says nothing. Either way the bytes that
 * come back are still checked, so a wrong guess fails loudly rather than
 * putting a stray file on a slide.
 */
export function findSongPptAttachment(html, pageUrl, env = {}) {
  const text = String(html || '');
  const found = [];
  for (const match of text.matchAll(/(?:href|src|data-src)="([^"]+)"/gi)) {
    const url = absoluteUrl(match[1], pageUrl);
    if (!url || !looksLikePptxUrl(url)) continue;
    if (!isAllowedSongPptUrl(url, env)) continue;
    found.push(url);
  }
  if (found.length > 0) {
    // A post links out to other sites too, so the attachment is the one on a
    // file host we know or on the post's own domain, before anything else.
    const pageHost = (() => {
      try {
        return new URL(pageUrl).hostname.toLowerCase();
      } catch {
        return '';
      }
    })();
    const rank = (url) => {
      if (isKnownSongPptHost(url, env)) return 0;
      try {
        return sameSite(new URL(url).hostname, pageHost) ? 1 : 2;
      } catch {
        return 2;
      }
    };
    return found.reduce((best, url) => (rank(url) < rank(best) ? url : best), found[0]);
  }

  // No address gave it away; try the one a person would click.
  for (const match of text.matchAll(/<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]{0,200}?)<\/a>/gi)) {
    const label = decodeEntities(match[2].replace(/<[^>]*>/g, ' '));
    if (!/\.pptx?\b/i.test(label)) continue;
    const url = absoluteUrl(match[1], pageUrl);
    if (!url || !isAllowedSongPptUrl(url, env)) continue;
    return url;
  }
  return null;
}

/**
 * How well a hit's title matches the song, 0..1.
 *
 * This is what lets the app attach a result by itself: the operator typed the
 * title, so a hit whose own title carries it is the song, and one that shares
 * only a word or two is a guess worth showing rather than acting on.
 */
export function scoreSongMatch(title, text) {
  const wanted = normalizeForMatch(title);
  const found = normalizeForMatch(text);
  if (!wanted || !found) return 0;
  if (found.includes(wanted)) return 1;

  // Fall back to how much of the title's words the hit carries, so
  // "나의 반석이신 하나님 (D키)" still scores well against the plain title.
  const words = String(title || '')
    .split(/\s+/)
    .map(normalizeForMatch)
    .filter((word) => word.length > 0);
  if (words.length === 0) return 0;
  const hits = words.filter((word) => found.includes(word)).length;
  return hits / words.length;
}

function normalizeForMatch(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^0-9a-z\uac00-\ud7a3]+/g, '');
}

/** At or above this, a hit is the song and the app may attach it unasked. */
export const AUTO_ATTACH_SCORE = 0.8;

/** Score a list of hits against the title, best first. */
export function rankSongMatches(title, hits) {
  return hits
    .map((hit) => {
      const score = Math.max(
        scoreSongMatch(title, hit.title ?? ''),
        // The file name is often the only place the title appears in full.
        scoreSongMatch(title, decodeURIComponent(fileNameOf(hit.url ?? ''))),
      );
      return { ...hit, score, decision: score >= AUTO_ATTACH_SCORE ? 'auto' : 'review' };
    })
    .sort((a, b) => b.score - a.score);
}

function fileNameOf(rawUrl) {
  try {
    return new URL(rawUrl).pathname.split('/').filter(Boolean).pop() ?? '';
  } catch {
    return '';
  }
}

// ---- tokens -------------------------------------------------------------
//
// A search hit is handed to the browser as a signed token, so the download
// route can trust that the URL is one the proxy itself chose off its own
// allowlist. The signature is HMAC-SHA256 over the URL and an expiry.

function base64UrlEncode(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecode(value) {
  const padded = String(value || '')
    .replace(/-/g, '+')
    .replace(/_/g, '/')
    .padEnd(Math.ceil(String(value || '').length / 4) * 4, '=');
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function hmacKey(secret) {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(String(secret || '')),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

export async function signSongPptToken(url, secret, { now = Date.now(), ttlMs = SONG_PPT_TOKEN_TTL_MS } = {}) {
  const payload = base64UrlEncode(
    new TextEncoder().encode(JSON.stringify({ u: String(url), e: now + ttlMs })),
  );
  const signature = await crypto.subtle.sign('HMAC', await hmacKey(secret), new TextEncoder().encode(payload));
  return `${payload}.${base64UrlEncode(new Uint8Array(signature))}`;
}

/** The URL a token stands for, or null when it is forged, stale or malformed. */
export async function verifySongPptToken(token, secret, { now = Date.now() } = {}) {
  const [payload, signature] = String(token || '').split('.');
  if (!payload || !signature) return null;
  let valid;
  try {
    valid = await crypto.subtle.verify(
      'HMAC',
      await hmacKey(secret),
      base64UrlDecode(signature),
      new TextEncoder().encode(payload),
    );
  } catch {
    return null;
  }
  if (!valid) return null;
  let parsed;
  try {
    parsed = JSON.parse(new TextDecoder().decode(base64UrlDecode(payload)));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed.u !== 'string' || !Number.isFinite(parsed.e)) return null;
  if (parsed.e < now) return null;
  return parsed.u;
}

// ---- fetching -----------------------------------------------------------

export async function fetchWithTimeout(url, { timeoutMs = SEARCH_TIMEOUT_MS, headers = {} } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      signal: controller.signal,
      headers: {
        // Some hosts serve an empty shell to clients with no UA at all.
        'User-Agent': 'Mozilla/5.0 (compatible; KCCP-Praise/1.0)',
        'Accept-Language': 'ko,en;q=0.8',
        ...headers,
      },
    });
  } finally {
    clearTimeout(timer);
  }
}

export async function readBoundedText(response) {
  const declared = Number(response.headers.get('content-length') || 0);
  if (declared > MAX_HTML_BYTES) return '';
  const text = await response.text();
  return text.length > MAX_HTML_BYTES ? text.slice(0, MAX_HTML_BYTES) : text;
}

/** True when these bytes really are a PowerPoint package. */
export function isPptxBytes(bytes) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes ?? []);
  if (view.length < 4) return false;
  // Every .pptx is a ZIP, and every ZIP starts with the local file header.
  if (!(view[0] === 0x50 && view[1] === 0x4b && view[2] === 0x03 && view[3] === 0x04)) return false;
  // The central directory near the end lists every part by name, so the
  // presentation part's name appears verbatim in the bytes.
  const tail = view.subarray(Math.max(0, view.length - 200_000));
  let ascii = '';
  for (const byte of tail) ascii += String.fromCharCode(byte);
  return ascii.includes('ppt/presentation.xml');
}

/**
 * Search for a song's 찬양 PPT. Returns hits the proxy is willing to
 * download (each with a signed token) plus links it is not.
 */
export async function fetchSongPptCandidates(title, env = {}, secret = '') {
  const queries = buildSongPptQueries(title);
  if (queries.length === 0) return { candidates: [], links: [] };

  const results = [];
  const links = [];
  for (const query of queries) {
    for (const endpoint of SEARCH_ENDPOINTS) {
      try {
        const response = await fetchWithTimeout(endpoint(query));
        if (!response.ok) continue;
        const found = extractSongPptResults(await readBoundedText(response), env);
        for (const hit of found.results) {
          if (!results.some((existing) => existing.url === hit.url)) results.push(hit);
        }
        for (const link of found.links) {
          if (!links.some((existing) => existing.url === link.url)) links.push(link);
        }
        if (results.length > 0) break;
      } catch {
        // A search engine being unreachable just means trying the next one.
      }
    }
    if (results.length >= MAX_SONG_PPT_CANDIDATES) break;
  }

  const candidates = [];
  for (const hit of rankSongMatches(title, results.slice(0, MAX_SONG_PPT_CANDIDATES))) {
    candidates.push({ ...hit, token: await signSongPptToken(hit.url, secret) });
  }
  return { candidates, links: links.slice(0, MAX_SONG_PPT_CANDIDATES) };
}

/**
 * Download one 찬양 PPT. A page URL is followed one step to its .pptx
 * attachment; the final URL after redirects is re-checked, because an
 * allowlisted host may redirect anywhere.
 */
export async function fetchSongPptFile(rawUrl, env = {}) {
  if (!isAllowedSongPptUrl(rawUrl, env)) {
    throw new Error('이 주소에서는 받아올 수 없습니다. 파일을 직접 올려 주세요.');
  }

  let fileUrl = rawUrl;
  if (!looksLikePptxUrl(fileUrl)) {
    const page = await fetchWithTimeout(fileUrl);
    if (!page.ok) throw new Error(`게시글을 열지 못했습니다 (HTTP ${page.status}).`);
    const finalPageUrl = page.url || fileUrl;
    if (!isAllowedSongPptUrl(finalPageUrl, env)) {
      throw new Error('허용되지 않은 주소로 이동했습니다.');
    }
    const attachment = findSongPptAttachment(await readBoundedText(page), finalPageUrl, env);
    if (!attachment) {
      throw new Error('이 게시글에서 PPT 첨부를 찾지 못했습니다. 파일을 직접 올려 주세요.');
    }
    fileUrl = attachment;
  }

  const response = await fetchWithTimeout(fileUrl, {
    timeoutMs: DOWNLOAD_TIMEOUT_MS,
    // Attachment hosts commonly require the post they belong to as referer.
    headers: { Referer: rawUrl },
  });
  if (!response.ok) throw new Error(`파일을 받지 못했습니다 (HTTP ${response.status}).`);
  const finalUrl = response.url || fileUrl;
  if (!isAllowedSongPptUrl(finalUrl, env)) throw new Error('허용되지 않은 주소로 이동했습니다.');

  const declared = Number(response.headers.get('content-length') || 0);
  if (declared > MAX_SONG_PPT_BYTES) throw new Error('찬양 PPT가 너무 큽니다 (25MB 초과).');

  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length > MAX_SONG_PPT_BYTES) throw new Error('찬양 PPT가 너무 큽니다 (25MB 초과).');
  if (!isPptxBytes(bytes)) throw new Error('받은 파일이 PowerPoint(.pptx) 파일이 아닙니다.');

  return { bytes, url: finalUrl };
}

// ---- the link-only 수요예배 song library --------------------------------

export const MAX_WEDNESDAY_SONG_ENTRIES = 2000;

/**
 * One stored song: its title and where its PPT came from. Deliberately no
 * file — the library remembers where to get a deck again, and the deck itself
 * lives only in the week's own 라이브러리 entry.
 */
export function sanitizeWednesdaySongEntry(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const title = typeof raw.title === 'string' ? raw.title.trim().slice(0, 200) : '';
  if (!title) return null;
  const sourceUrl = typeof raw.sourceUrl === 'string' ? raw.sourceUrl.trim().slice(0, 500) : '';
  const entry = { title };
  if (/^https:\/\//.test(sourceUrl)) {
    entry.sourceUrl = sourceUrl;
    try {
      entry.sourceHost = new URL(sourceUrl).hostname.toLowerCase();
    } catch {
      delete entry.sourceUrl;
    }
  }
  const slideCount = Number(raw.slideCount);
  if (Number.isFinite(slideCount) && slideCount > 0 && slideCount < 500) {
    entry.slideCount = Math.floor(slideCount);
  }
  const updatedAt = typeof raw.updatedAt === 'string' ? raw.updatedAt.slice(0, 40) : '';
  entry.updatedAt = Number.isFinite(Date.parse(updatedAt)) ? updatedAt : new Date().toISOString();
  return entry;
}

export function sanitizeWednesdaySongEntries(raw) {
  if (!Array.isArray(raw)) return [];
  const entries = [];
  for (const item of raw.slice(0, MAX_WEDNESDAY_SONG_ENTRIES)) {
    const entry = sanitizeWednesdaySongEntry(item);
    if (entry) entries.push(entry);
  }
  return entries;
}
