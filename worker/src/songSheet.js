// 악보 사진 lookup: find a song's sheet-music images on the web and hand the
// bytes to the browser, which turns each page into a slide.
//
// Same reason as songPpt.js — no image host sends CORS headers, so the
// browser cannot read one itself — and the same token discipline: search
// returns a signed token per hit, never a URL the caller can choose.
//
// Both routes are gated the same way, by *what comes back* rather than by a
// host list — 악보 images live on whatever CDN their blog uses, and the 찬양
// PPT is on whichever 자료실 that song happens to be on. Here that means https
// only, never an address that resolves inside, a hard size cap, and bytes that
// really are a PNG or JPEG. A deployment that wants a list anyway sets
// WEDNESDAY_IMAGE_HOSTS_ONLY=true and gets WEDNESDAY_PPT_HOSTS applied here.
//
// The search itself is 네이버 이미지 검색 first. It is where a Korean 찬양's
// 악보 actually are (mostly 네이버 블로그 posts), its page carries every
// result as JSON with the original's address and pixel size, and — unlike
// Bing, whose image page comes back empty to a server — it answers a plain
// fetch. Bing stays behind it as a fallback.
import {
  AUTO_ATTACH_SCORE,
  SET_LIST_TITLE,
  fetchWithTimeout,
  isKnownSongPptHost,
  rankSongMatches,
  readBoundedText,
  songPptHosts,
} from './songPpt.js';

export const MAX_SHEET_IMAGE_BYTES = 8 * 1024 * 1024;
export const MAX_SHEET_IMAGES = 8;
const IMAGE_TIMEOUT_MS = 15_000;
/** How many hits a search page is read for, before ranking picks the best. */
const MAX_SHEET_HITS = 30;

/** Image search phrasings, most specific first. */
export function buildSheetQueries(title) {
  const clean = String(title || '').trim();
  if (!clean) return [];
  return [`${clean} 악보`, `${clean} 찬양 악보`];
}

/** 네이버 이미지 검색, whose page embeds its results as a JSON array. */
export function naverImageSearchUrl(query) {
  return `https://search.naver.com/search.naver?where=image&sm=tab_jum&query=${encodeURIComponent(query)}`;
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
  if (imageHostsOnly(env)) return isKnownSongPptHost(rawUrl, env);
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

/**
 * Naver's own file hosts answer https as well as the http its search reports,
 * so their originals are upgraded. Anything else offered only over http is
 * left out: the proxy fetches https or nothing.
 */
const HTTPS_UPGRADABLE_HOSTS = ['naver.net', 'pstatic.net'];

/** The https address to fetch an image result at, or null when there is none. */
export function fetchableImageUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(String(rawUrl || ''));
  } catch {
    return null;
  }
  if (parsed.protocol === 'https:') return parsed.toString();
  if (parsed.protocol !== 'http:') return null;
  const host = parsed.hostname.toLowerCase();
  if (!HTTPS_UPGRADABLE_HOSTS.some((entry) => host === entry || host.endsWith(`.${entry}`))) return null;
  parsed.protocol = 'https:';
  return parsed.toString();
}

/** True for a format a slide cannot take (only PNG and JPEG become slides). */
function isUnsupportedImageUrl(rawUrl) {
  try {
    const { pathname } = new URL(rawUrl);
    // 네이버 blogfiles name the format in a path segment too: …_GIF/name.gif
    return /\.(gif|webp|bmp|svg|heic)$/i.test(pathname) || /_GIF\//.test(pathname);
  } catch {
    return true;
  }
}

/**
 * The JSON array that opens at `start` (the index of its '['), or null.
 * Strings are skipped whole, so a bracket inside a title does not end it.
 */
function readJsonArrayAt(text, start) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const char = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '[') depth++;
    else if (char === ']') {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

function positiveNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.round(number) : undefined;
}

function cleanTitle(value) {
  return decodeEntities(String(value ?? '').replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
}

/**
 * Pull image hits out of a 네이버 이미지 검색 page.
 *
 * The page renders from an `items: [...]` array in its own script, one object
 * per result: `originalUrl` is the image itself, `link` the post it is on,
 * `title` that post's title and `orgWidth`/`orgHeight` its pixel size — which
 * is what tells a full-page 악보 from a thumbnail or a video still.
 */
export function extractNaverImageResults(html, env = {}, limit = MAX_SHEET_HITS) {
  const text = String(html || '');
  const results = [];
  const seen = new Set();

  for (const marker of text.matchAll(/["']?items["']?\s*:\s*\[/g)) {
    const items = readJsonArrayAt(text, marker.index + marker[0].length - 1);
    if (!Array.isArray(items)) continue;
    for (const item of items) {
      if (results.length >= limit) break;
      const url = fetchableImageUrl(typeof item?.originalUrl === 'string' ? item.originalUrl : '');
      if (!url || seen.has(url)) continue;
      if (isUnsupportedImageUrl(url) || !isAllowedSheetImageUrl(url, env)) continue;
      seen.add(url);
      const link = typeof item.link === 'string' && /^https?:\/\//i.test(item.link) ? item.link : '';
      results.push({
        url,
        host: new URL(url).hostname.toLowerCase(),
        title: cleanTitle(item.title),
        pageUrl: link ? link.slice(0, 500) : undefined,
        width: positiveNumber(item.orgWidth),
        height: positiveNumber(item.orgHeight),
      });
    }
    if (results.length > 0) break;
  }

  return results;
}

/**
 * Sites whose images are a paid score's watermarked preview or another
 * instrument's part. Still offered, never attached unasked.
 */
const PREVIEW_IMAGE_HOSTS = ['akbobada.com', 'akbotong.com', 'mapianist.com', 'ukulscore.com'];

/**
 * Titles of pictures that carry the song's name but are not the 악보 a
 * congregation reads from: another instrument's part, an intro, a cover
 * video's still, a lesson ad. (기타 and 영상 are left out on purpose: a
 * guitar 코드 악보 is a fine lead sheet, and a post "악보/영상/가사" embeds
 * a video beside the 악보 it is named for.)
 */
const NOT_THE_SHEET =
  /(드럼|일렉|베이스|세컨|플루트|칼림바|우쿨렐레|바이올린|첼로|반주|3단|인트로|intro|커버|cover|연주|레슨|학원|\bmr\b)/i;

const SHEET_WORDS = /(악보|코드|chord|score|sheet)/i;

/** A page this small is a thumbnail, not something to project. */
const MIN_SHEET_SIDE = 400;
/** A page this large reads from the back of the room. */
const SHARP_SHEET_SIDE = 1000;

/**
 * How much a hit looks like a 악보 page, 0 when it does not at all.
 *
 * Its post calling it 악보 counts most; a portrait page counts too, because
 * a sheet is taller than it is wide and a video still or a photo is not; and
 * a large one beats a small one, because it is going on a projector.
 */
export function sheetLikeness(hit) {
  const title = String(hit?.title ?? '');
  // A post of several songs' 악보 — a week's 콘티 — is not this song's.
  if (NOT_THE_SHEET.test(title) || SET_LIST_TITLE.test(title)) return 0;
  const host = hostOf(hit?.url ?? '');
  if (PREVIEW_IMAGE_HOSTS.some((entry) => host === entry || host.endsWith(`.${entry}`))) return 0;

  const width = Number(hit?.width) || 0;
  const height = Number(hit?.height) || 0;
  if (width && height) {
    if (Math.min(width, height) < MIN_SHEET_SIDE) return 0;
    const ratio = height / width;
    if (ratio < 0.4 || ratio > 2.5) return 0;
  }
  let score = 0;
  if (SHEET_WORDS.test(title)) score += 2;
  if (width && height && height >= width) score += 1;
  if (score > 0 && Math.max(width, height) >= SHARP_SHEET_SIDE) score += 1;
  return score;
}

/**
 * How many keys a post's title lists: "F, G, A", "C,F,G,B♭ key". A post
 * with several is the one song once per key, so its images are alternatives,
 * not pages to put one after another.
 */
export function keysNamed(title) {
  return (String(title || '').match(/(?<![A-Za-z])[A-G](?:#|♯|♭|b)?\*?(?![A-Za-z])/g) ?? []).length;
}

/** True when two images are the same size, give or take, as a document's pages are. */
function samePageSize(a, b) {
  if (!a.width || !a.height || !b.width || !b.height) return true;
  const close = (x, y) => Math.abs(x - y) <= Math.max(x, y) * 0.1;
  return close(a.width, b.width) && close(a.height, b.height);
}

/**
 * Rank image hits for a song, and mark the ones the app may attach unasked:
 * the title is this song's and the picture looks like its 악보.
 *
 * Sure hits come first — the ones that name the song exactly, then the most
 * sheet-like — and otherwise the search engine's own order stands. The pages that share the best hit's post
 * are pulled up beside it, because a two-page 악보 is two images of one post
 * and the app attaches those together.
 */
export function rankSheetImages(title, hits) {
  const order = new Map(hits.map((hit, index) => [hit.url, index]));
  const ranked = rankSongMatches(title, hits)
    .map((hit) => {
      const likeness = sheetLikeness(hit);
      const decision = hit.score >= AUTO_ATTACH_SCORE && likeness > 0 ? 'auto' : 'review';
      return { hit: { ...hit, decision }, likeness };
    })
    .sort((a, b) => {
      const sure = (entry) => (entry.hit.decision === 'auto' ? 0 : 1);
      return (
        sure(a) - sure(b) ||
        b.hit.score - a.hit.score ||
        b.likeness - a.likeness ||
        order.get(a.hit.url) - order.get(b.hit.url)
      );
    })
    .map((entry) => entry.hit);

  const best = ranked[0];
  if (!best || best.decision !== 'auto' || !best.pageUrl) return ranked;
  // The post's other pages: sure, the same size, and not the same song in
  // another key. The best hit's siblings that fail that are demoted to guesses,
  // so the app never puts them on a slide by itself.
  const multiKey = keysNamed(best.title) >= 2;
  const others = ranked
    .filter((hit) => hit !== best)
    .map((hit) =>
      hit.pageUrl === best.pageUrl && hit.decision === 'auto' && (multiKey || !samePageSize(hit, best))
        ? { ...hit, decision: 'review' }
        : hit,
    );
  // In page order, which the file names nearly always follow (악보1.jpg,
  // 악보2.jpg; IMG_1331, IMG_1332; upload timestamps).
  const pages = [best, ...others.filter((hit) => hit.decision === 'auto' && hit.pageUrl === best.pageUrl)].sort(
    (a, b) => imageFileName(a.url).localeCompare(imageFileName(b.url), undefined, { numeric: true }),
  );
  return [...pages, ...others.filter((hit) => !pages.includes(hit))];
}

function imageFileName(rawUrl) {
  let name;
  try {
    name = new URL(rawUrl).pathname.split('/').filter(Boolean).pop() ?? '';
  } catch {
    return '';
  }
  try {
    return decodeURIComponent(name);
  } catch {
    return name;
  }
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

/**
 * Search for a song's 악보 images, ranked (see rankSheetImages). Hosts are
 * checked, files are not fetched.
 */
export async function fetchSheetImageCandidates(title, env = {}, sign = null) {
  const queries = buildSheetQueries(title);
  if (queries.length === 0) return { candidates: [] };

  const hits = [];
  for (const query of queries) {
    // 네이버 first; Bing only when it has nothing for this phrasing.
    const searches = [
      { url: naverImageSearchUrl(query), extract: extractNaverImageResults },
      ...SHEET_SEARCH_ENDPOINTS.map((endpoint) => ({ url: endpoint(query), extract: extractSheetImageResults })),
    ];
    for (const search of searches) {
      try {
        const response = await fetchWithTimeout(search.url);
        if (!response.ok) continue;
        const found = search.extract(await readBoundedText(response), env, MAX_SHEET_HITS);
        for (const hit of found) {
          if (!hits.some((existing) => existing.url === hit.url)) hits.push(hit);
        }
        if (found.length > 0) break;
      } catch {
        // A search engine being unreachable just means trying the next one.
      }
    }
    if (hits.length >= MAX_SHEET_IMAGES) break;
  }

  const candidates = [];
  for (const hit of rankSheetImages(title, hits).slice(0, MAX_SHEET_IMAGES)) {
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
    // Only the two formats a slide takes: a CDN that negotiates would
    // otherwise answer an Accept listing WebP with WebP.
    headers: { Accept: 'image/png,image/jpeg;q=0.9,*/*;q=0.5' },
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
