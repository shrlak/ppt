// 악보 사진 lookup: find a song's sheet-music images on the web and hand the
// bytes to the browser, which turns each page into a slide.
//
// Same reason as songPpt.js — no image host sends CORS headers, so the
// browser cannot read one itself — and the same token discipline: search
// returns a signed token per hit, never a URL the caller can choose.
//
// The one deliberate difference is the host policy. A 찬양 PPT comes from a
// handful of known file hosts, so that route is allowlisted by host. 악보
// images are scattered across every blog CDN there is, so an allowlist would
// mean the feature never finds anything. These are gated by *what comes back*
// instead: https only, never an address that resolves inside, a hard size cap,
// and bytes that really are a PNG or JPEG. A deployment that wants the
// stricter rule anyway sets WEDNESDAY_IMAGE_HOSTS_ONLY=true and gets the
// songPpt allowlist applied here too.
import { fetchWithTimeout, isAllowedSongPptUrl, readBoundedText, songPptHosts } from './songPpt.js';

export const MAX_SHEET_IMAGE_BYTES = 8 * 1024 * 1024;
export const MAX_SHEET_IMAGES = 6;
const IMAGE_TIMEOUT_MS = 15_000;

/** Image search phrasings, most specific first. */
export function buildSheetQueries(title) {
  const clean = String(title || '').trim();
  if (!clean) return [];
  return [`${clean} 악보`, `${clean} 찬양 악보`];
}

/** Bing's image search markup carries each result's real URL as JSON. */
export const SHEET_SEARCH_ENDPOINTS = [
  (query) => `https://www.bing.com/images/search?q=${encodeURIComponent(query)}&qft=+filterui:imagesize-large`,
  (query) => `https://www.bing.com/images/search?q=${encodeURIComponent(query)}`,
];

function decodeEntities(value) {
  return String(value || '')
    .replace(/&quot;/g, '"')
    .replace(/&#34;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

export function looksLikeImageUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    return /\.(png|jpe?g)(?:$|[?#])/i.test(parsed.pathname + parsed.search);
  } catch {
    return false;
  }
}

function isLocalHostname(hostname) {
  const host = String(hostname || '').toLowerCase();
  if (!host) return true;
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host.endsWith('.local') || host.endsWith('.internal')) return true;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return true;
  if (host.startsWith('[') || host.includes(':')) return true;
  return false;
}

/** True when this deployment restricts images to the 찬양 PPT allowlist. */
export function imageHostsOnly(env = {}) {
  return String(env.WEDNESDAY_IMAGE_HOSTS_ONLY || '').toLowerCase() === 'true';
}

/** True when the proxy may fetch this image at all. */
export function isAllowedSheetImageUrl(rawUrl, env = {}) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:') return false;
  if (isLocalHostname(parsed.hostname)) return false;
  if (imageHostsOnly(env)) return isAllowedSongPptUrl(rawUrl, env);
  return true;
}

/**
 * Pull image hits out of a search page.
 *
 * Bing wraps each result in `<a class="iusc" m="{…&quot;murl&quot;:…}">`, so
 * the real image URL, its page and its title all come from that JSON. Anything
 * this deployment may not fetch is dropped here rather than at fetch time.
 */
export function extractSheetImageResults(html, env = {}, limit = MAX_SHEET_IMAGES) {
  const results = [];
  const seen = new Set();

  for (const match of String(html || '').matchAll(/\sm="(\{[^"]*\})"/g)) {
    let payload;
    try {
      payload = JSON.parse(decodeEntities(match[1]));
    } catch {
      continue;
    }
    const url = typeof payload?.murl === 'string' ? payload.murl : '';
    if (!url || seen.has(url)) continue;
    if (!looksLikeImageUrl(url)) continue;
    if (!isAllowedSheetImageUrl(url, env)) continue;
    seen.add(url);

    let host;
    try {
      host = new URL(url).hostname.toLowerCase();
    } catch {
      continue;
    }
    results.push({
      url,
      host,
      title: String(payload?.t ?? '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 160),
      pageUrl: typeof payload?.purl === 'string' ? payload.purl.slice(0, 500) : undefined,
    });
    if (results.length >= limit) break;
  }

  return results;
}

/** True when these bytes really are a PNG or JPEG. */
export function isImageBytes(bytes) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes ?? []);
  if (view.length < 4) return false;
  const png = view[0] === 0x89 && view[1] === 0x50 && view[2] === 0x4e && view[3] === 0x47;
  const jpeg = view[0] === 0xff && view[1] === 0xd8 && view[2] === 0xff;
  return png || jpeg;
}

export function imageMimeType(bytes) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes ?? []);
  return view[0] === 0x89 ? 'image/png' : 'image/jpeg';
}

/** Search for a song's 악보 images. Hosts are checked, files are not fetched. */
export async function fetchSheetImageCandidates(title, env = {}, sign = null) {
  const queries = buildSheetQueries(title);
  if (queries.length === 0) return { candidates: [] };

  const hits = [];
  for (const query of queries) {
    for (const endpoint of SHEET_SEARCH_ENDPOINTS) {
      try {
        const response = await fetchWithTimeout(endpoint(query));
        if (!response.ok) continue;
        for (const hit of extractSheetImageResults(await readBoundedText(response), env)) {
          if (!hits.some((existing) => existing.url === hit.url)) hits.push(hit);
        }
        if (hits.length > 0) break;
      } catch {
        // A search engine being unreachable just means trying the next one.
      }
    }
    if (hits.length >= MAX_SHEET_IMAGES) break;
  }

  const candidates = [];
  for (const hit of hits.slice(0, MAX_SHEET_IMAGES)) {
    candidates.push({ ...hit, token: sign ? await sign(hit.url) : '' });
  }
  return { candidates };
}

/** Download one 악보 image, refusing anything that is not a real image. */
export async function fetchSheetImage(rawUrl, env = {}) {
  if (!isAllowedSheetImageUrl(rawUrl, env)) {
    throw new Error('이 주소에서는 악보 사진을 받아올 수 없습니다. 파일을 직접 올려 주세요.');
  }

  const response = await fetchWithTimeout(rawUrl, {
    timeoutMs: IMAGE_TIMEOUT_MS,
    headers: { Accept: 'image/avif,image/webp,image/png,image/jpeg,*/*;q=0.8' },
  });
  if (!response.ok) throw new Error(`악보 사진을 받지 못했습니다 (HTTP ${response.status}).`);

  const finalUrl = response.url || rawUrl;
  if (!isAllowedSheetImageUrl(finalUrl, env)) throw new Error('허용되지 않은 주소로 이동했습니다.');

  const declared = Number(response.headers.get('content-length') || 0);
  if (declared > MAX_SHEET_IMAGE_BYTES) throw new Error('악보 사진이 너무 큽니다 (8MB 초과).');

  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length > MAX_SHEET_IMAGE_BYTES) throw new Error('악보 사진이 너무 큽니다 (8MB 초과).');
  // A site that answers a missing file with an HTML page still returns 200,
  // and PowerPoint cannot show that as a slide.
  if (!isImageBytes(bytes)) throw new Error('받은 파일이 PNG·JPG 이미지가 아닙니다.');

  return { bytes, url: finalUrl, mimeType: imageMimeType(bytes) };
}

/** A hostname a search hit's `hosts` list can show, or '' when unreadable. */
export function hostOf(rawUrl) {
  try {
    return new URL(rawUrl).hostname.toLowerCase();
  } catch {
    return '';
  }
}

export { songPptHosts };
