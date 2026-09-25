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

/**
 * Where this church looks first: 티스토리 blogs (and their file CDN) and
 * 갓피플. A sure hit on one of these is tried before a sure hit anywhere
 * else, 네이버 블로그 included.
 */
export const PREFERRED_SONG_PPT_HOSTS = ['tistory.com', 'blog.kakaocdn.net', 'godpeople.com', 'godpeople.co.kr'];

/** The sites the Google search is restricted to. */
export const GOOGLE_SONG_PPT_SITES = ['tistory.com', 'godpeople.com'];

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

/**
 * 블로그 검색, asked alongside the web search above. A 찬양 PPT is nearly
 * always an attachment on a 티스토리 or 네이버 블로그 post, and these two
 * answer a server's plain fetch — DuckDuckGo increasingly turns one away —
 * with each post's title and a snippet that often names its attachment
 * ("첨부파일 은혜.pptx").
 */
export function daumBlogSearchUrl(query) {
  return `https://search.daum.net/search?w=fusion&col=blog&q=${encodeURIComponent(query)}`;
}

export function naverBlogSearchUrl(query) {
  return `https://search.naver.com/search.naver?ssc=tab.blog.all&query=${encodeURIComponent(query)}`;
}

/**
 * Google 검색, asked first and only for 티스토리 and 갓피플.
 *
 * Google answers a server's own fetch of its results page with a CAPTCHA
 * (/sorry/), and its Custom Search API takes no new sign-ups and ends on
 * 2027-01-01, so the search goes through Serper, which returns Google's own
 * results as JSON. A deployment without SERPER_API_KEY skips it, and the blog
 * and web searches below still run.
 */
export const GOOGLE_SEARCH_ENDPOINT = 'https://google.serper.dev/search';

export function googleSearchKey(env = {}) {
  return String(env.SERPER_API_KEY || '').trim();
}

/** A phrasing, restricted to the sites the Google search asks. */
export function googleSongPptQuery(query) {
  return `${query} (${GOOGLE_SONG_PPT_SITES.map((site) => `site:${site}`).join(' OR ')})`;
}

export function fetchGoogleSearch(query, env = {}) {
  return fetchWithTimeout(GOOGLE_SEARCH_ENDPOINT, {
    method: 'POST',
    headers: { 'X-API-KEY': googleSearchKey(env), 'Content-Type': 'application/json' },
    body: JSON.stringify({ q: googleSongPptQuery(query), gl: 'kr', hl: 'ko', num: 10 }),
  });
}

/**
 * Search phrasings, most specific first. 악보 leads: a 찬양 PPT is shared
 * both as 가사 only and with the 악보 on every slide, and only the second is
 * what this church puts up.
 */
export function buildSongPptQueries(title) {
  const clean = String(title || '').trim();
  if (!clean) return [];
  return [`${clean} 악보 ppt`, `${clean} 찬양 ppt`, `${clean} ppt 다운로드`];
}

/** True when a hit's title or snippet says its PPT carries the 악보. */
export function mentionsSheet(text) {
  return /악보/.test(String(text || ''));
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

/** True when this host is 티스토리 or 갓피플, the sites tried first. */
export function isPreferredSongPptHost(rawUrl) {
  let hostname;
  try {
    hostname = new URL(rawUrl).hostname;
  } catch {
    return false;
  }
  return PREFERRED_SONG_PPT_HOSTS.some((entry) => hostMatches(hostname, entry));
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

/** True when a URL names a .pptx — not the old .ppt, which a slide cannot be made from. */
export function looksLikeModernPptxUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    return /\.pptx(?:$|[?#&])/i.test(parsed.pathname + parsed.search);
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
      results.push({ url, host, title, direct, known: isKnownSongPptHost(url, env), sheet: mentionsSheet(title) });
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

/** Every link on a results page with all the text shown for it, in page order. */
function collectLabelledLinks(html, tagNames) {
  const labels = new Map();
  const pattern = new RegExp(`<(${tagNames.join('|')})\\b([^>]*)>([\\s\\S]*?)</\\1>`, 'gi');
  for (const match of String(html || '').matchAll(pattern)) {
    const href = match[2].match(/\s(?:data-)?href="([^"]+)"/i);
    if (!href) continue;
    const url = decodeEntities(href[1]).split('#')[0];
    // The search's own highlighting sits inside words: [찬양<b>PPT</b>,가사]
    const label = decodeEntities(
      match[3].replace(/<\/?(?:b|mark|strong|em)\b[^>]*>/gi, '').replace(/<[^>]*>/g, ' '),
    )
      // 네이버 appends this for screen readers to every result link.
      .replace(/새 창 열림/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!labels.has(url)) labels.set(url, []);
    if (label) labels.get(url).push(label);
  }
  return labels;
}

/** What a result's snippet says the post has attached, when it says. */
export function attachmentKind(text) {
  const value = String(text || '');
  if (/\.pptx\b/i.test(value)) return 'pptx';
  if (/\.ppt\b/i.test(value)) return 'ppt';
  return undefined;
}

function blogPostHits(labels, isPost, env, limit) {
  const results = [];
  for (const [url, texts] of labels) {
    if (results.length >= limit) break;
    if (texts.length === 0 || !isPost(url)) continue;
    if (!isAllowedSongPptUrl(url, env) || isNeverFileHost(url)) continue;
    results.push({
      url,
      host: new URL(url).hostname.toLowerCase(),
      title: texts[0].slice(0, 160),
      direct: looksLikePptxUrl(url),
      known: isKnownSongPptHost(url, env),
      attachment: attachmentKind(texts.join(' ')),
      sheet: mentionsSheet(texts.join(' ')),
    });
  }
  return { results, links: [] };
}

/**
 * Pull hits out of a Google search answered as JSON (see fetchGoogleSearch):
 * `organic` is the results page, each with its address, title and snippet.
 * The same rules as the HTML searches decide what may be fetched.
 */
export function extractGoogleResults(payload, env = {}, limit = MAX_SONG_PPT_CANDIDATES * 2) {
  const results = [];
  const links = [];
  const clean = (value) =>
    decodeEntities(String(value ?? ''))
      .replace(/\s+/g, ' ')
      .trim();
  for (const item of Array.isArray(payload?.organic) ? payload.organic : []) {
    if (results.length >= limit) break;
    const url = typeof item?.link === 'string' ? item.link.split('#')[0] : '';
    let host;
    try {
      host = new URL(url).hostname.toLowerCase();
    } catch {
      continue;
    }
    const title = clean(item.title).slice(0, 160);
    const text = `${title} ${clean(item.snippet)}`;
    const direct = looksLikePptxUrl(url);
    if (isAllowedSongPptUrl(url, env) && (direct || !isNeverFileHost(url))) {
      results.push({
        url,
        host,
        title,
        direct,
        known: isKnownSongPptHost(url, env),
        attachment: attachmentKind(text),
        sheet: mentionsSheet(text),
      });
    } else if (direct && links.length < limit) {
      links.push({ url, host, title });
    }
  }
  return { results, links };
}

/**
 * Pull posts out of a 다음 블로그 검색 page. Each result is a `<c-title>`
 * carrying the post's address in data-href, and a `<c-contents-desc>`
 * snippet for the same address.
 */
export function extractDaumBlogResults(html, env = {}, limit = MAX_SONG_PPT_CANDIDATES * 2) {
  const isPost = (url) => {
    try {
      const parsed = new URL(url);
      const host = parsed.hostname.toLowerCase();
      if (/(^|\.)(daum\.net|kakao\.com|daumcdn\.net|kakaocdn\.net)$/.test(host)) return false;
      return parsed.pathname.replace(/\/+$/, '') !== '';
    } catch {
      return false;
    }
  };
  return blogPostHits(collectLabelledLinks(html, ['c-title', 'c-contents-desc']), isPost, env, limit);
}

/** A 네이버 블로그 post's address: blog.naver.com/<blog>/<number>. */
const NAVER_POST = /^https:\/\/(?:m\.)?blog\.naver\.com\/[A-Za-z0-9_-]+\/\d+(?:[?#]|$)/;

/**
 * Pull posts out of a 네이버 블로그 검색 page: every link to a post, with the
 * title and snippet shown for it.
 */
export function extractNaverBlogResults(html, env = {}, limit = MAX_SONG_PPT_CANDIDATES * 2) {
  return blogPostHits(collectLabelledLinks(html, ['a']), (url) => NAVER_POST.test(url), env, limit);
}

/**
 * The address a 네이버 블로그 post can actually be read at.
 *
 * blog.naver.com/<blog>/<number> is only a frame around the post, so the
 * attachment is nowhere in it; m.blog.naver.com serves the post itself.
 * Returns null for anything that is not a 네이버 블로그 post.
 */
export function mobileNaverBlogUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }
  if (parsed.hostname.toLowerCase() !== 'blog.naver.com') return null;
  const segments = parsed.pathname.split('/').filter(Boolean);
  const logNo = parsed.searchParams.get('logNo') ?? '';
  // PostView.naver?blogId=<blog>&logNo=<number>, and <blog>?Redirect=Log&logNo=<number>
  const blogId = parsed.searchParams.get('blogId') || (segments.length === 1 ? segments[0] : '');
  if (blogId && /^\d+$/.test(logNo) && /^[A-Za-z0-9_-]+$/.test(blogId)) {
    return `https://m.blog.naver.com/${blogId}/${logNo}`;
  }
  if (segments.length >= 2 && /^[A-Za-z0-9_-]+$/.test(segments[0]) && /^\d+$/.test(segments[1])) {
    return `https://m.blog.naver.com/${segments[0]}/${segments[1]}`;
  }
  return null;
}

/** One post found by two searches is one hit, whichever address each gave. */
function postKey(url) {
  return (mobileNaverBlogUrl(url) ?? url)
    .replace(/^https:\/\/m\.blog\.naver\.com\//, 'https://blog.naver.com/')
    .replace(/\/$/, '');
}

/**
 * Titles of posts that carry several songs at once — a week's 콘티, a
 * 모음 — whose PPT would put every one of them on the slides.
 */
export const SET_LIST_TITLE = /(콘티|모음|메들리|medley|셋리스트|set\s*list)/i;

/**
 * Rank 찬양 PPT hits for a song, and mark the ones the app may try unasked.
 *
 * Sure hits come first, and a post whose only attachment is the old .ppt
 * format goes to the end of them, because a slide cannot be made from one.
 * Among the rest a post that says it has the 악보 comes first, then 티스토리
 * and 갓피플 before any other site — those are where this church gets its
 * songs. Guesses are shown best match first instead, since a preferred site
 * does not make another song's post any closer. After that a link straight
 * to the file beats a post whose snippet names a .pptx attachment, which
 * beats a post on a 자료실 we know, which beats the rest.
 */
export function rankSongPptHits(title, hits) {
  const order = new Map(hits.map((hit, index) => [hit.url, index]));
  const fileRank = (hit) => {
    if (hit.direct) return 0;
    if (hit.attachment === 'pptx') return 1;
    return hit.known ? 2 : 3;
  };
  return rankSongMatches(title, hits)
    .map((hit) => ({
      ...hit,
      decision: hit.decision === 'auto' && !SET_LIST_TITLE.test(hit.title ?? '') ? 'auto' : 'review',
    }))
    .sort((a, b) => {
      const sure = (hit) => (hit.decision === 'auto' ? 0 : 1);
      if (sure(a) !== sure(b)) return sure(a) - sure(b);
      const legacy = (hit) => (hit.attachment === 'ppt' ? 1 : 0);
      const sheet = (hit) => (hit.sheet ? 0 : 1);
      const preferred = (hit) => (isPreferredSongPptHost(hit.url) ? 0 : 1);
      const byPreference = legacy(a) - legacy(b) || sheet(a) - sheet(b) || preferred(a) - preferred(b);
      const byScore = b.score - a.score;
      return (
        (a.decision === 'auto' ? byPreference || byScore : byScore || byPreference) ||
        fileRank(a) - fileRank(b) ||
        order.get(a.url) - order.get(b.url)
      );
    });
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
 *
 * Only a .pptx counts. A post that offers the old .ppt format beside it
 * (티스토리 often has both, 4:3 and wide) gets its .pptx taken; one that only
 * has a .ppt has nothing a slide can be made from — see hasLegacyPptAttachment.
 *
 * A post often has more than one .pptx: 악보 and 가사 only, with a background
 * and 무배경. The file's name decides between them (see pptVersionRank), so
 * the one with the 악보, and without a background, is the one taken.
 */
export function findSongPptAttachment(html, pageUrl, env = {}) {
  const text = String(html || '');
  const labels = linkLabels(text, pageUrl);
  const version = (url) => pptVersionRank(`${labels.get(url) ?? ''} ${fileNameOf(url)}`);
  const best = (urls, rank) =>
    urls.reduce((chosen, url) => (rank(url) < rank(chosen) ? url : chosen), urls[0]);

  const found = [];
  for (const match of text.matchAll(/(?:href|src|data-src)="([^"]+)"/gi)) {
    const url = absoluteUrl(match[1], pageUrl);
    if (!url || !looksLikeModernPptxUrl(url)) continue;
    if (!isAllowedSongPptUrl(url, env) || found.includes(url)) continue;
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
    const hostRank = (url) => {
      if (isKnownSongPptHost(url, env)) return 0;
      try {
        return sameSite(new URL(url).hostname, pageHost) ? 1 : 2;
      } catch {
        return 2;
      }
    };
    return best(found, (url) => hostRank(url) * 10 + version(url));
  }

  // No address gave it away; try the one a person would click.
  const named = [...labels.entries()]
    .filter(([url, label]) => /\.pptx\b/i.test(label) && isAllowedSongPptUrl(url, env))
    .map(([url]) => url);
  return named.length > 0 ? best(named, version) : null;
}

/** Every link on a page with the text shown for it — on most blogs, the file's name. */
function linkLabels(html, pageUrl) {
  const labels = new Map();
  for (const match of html.matchAll(/<a\b[^>]*?\shref="([^"]+)"[^>]*>([\s\S]{0,400}?)<\/a>/gi)) {
    const url = absoluteUrl(match[1], pageUrl);
    if (!url) continue;
    const label = decodeEntities(match[2].replace(/<[^>]*>/g, ' '))
      .replace(/\s+/g, ' ')
      .trim();
    labels.set(url, `${labels.get(url) ?? ''} ${label}`.trim());
  }
  return labels;
}

/**
 * Which of a post's PowerPoint files to take, lowest first, from its name:
 * one with the 악보 before one that does not say, before one that is 가사
 * only; and among those, 무배경 before the same with a background.
 */
export function pptVersionRank(name) {
  const text = String(name || '').toLowerCase();
  const sheet = /악보/.test(text);
  const lyricsOnly = !sheet && /가사/.test(text);
  const plain = /무배경|배경\s*(?:x|없)/.test(text);
  return (sheet ? 0 : lyricsOnly ? 4 : 2) + (plain ? 0 : 1);
}

/** True when a post's only PowerPoint attachment is the old binary .ppt. */
export function hasLegacyPptAttachment(html, pageUrl) {
  for (const match of String(html || '').matchAll(/(?:href|src|data-src)="([^"]+)"/gi)) {
    const url = absoluteUrl(match[1], pageUrl);
    if (url && looksLikePptxUrl(url) && !looksLikeModernPptxUrl(url)) return true;
  }
  return false;
}

/**
 * How well a hit's title matches the song, 0..1.
 *
 * This is what lets the app attach a result by itself: the operator typed the
 * title, so a hit that names it is the song, and one that shares only a word
 * or two is a guess worth showing rather than acting on.
 *
 * "Names it" means one part of the hit's title — between its brackets,
 * quotes, dashes and slashes — is the title and nothing else but words every
 * 찬양 post adds (악보, 가사, ppt, a key). That is what tells 은혜 from
 * 하나님의 은혜 and 은혜 아니면, which merely contain it. A longer title is
 * specific enough that containing it still counts, a little lower; a short
 * one that is only contained is a guess.
 */
export function scoreSongMatch(title, text) {
  const wanted = normalizeForMatch(title);
  const found = normalizeForMatch(text);
  if (!wanted || !found) return 0;
  if (namesTitle(wanted, text)) return 1;
  const short = wanted.length <= SHORT_TITLE_LENGTH;
  if (found.includes(wanted)) return short ? UNSURE_SCORE : CONTAINS_SCORE;

  // Fall back to how much of the title's words the hit carries, so
  // "나의 반석이신 하나님 (D키)" still scores well against the plain title.
  const words = String(title || '')
    .split(/\s+/)
    .map(normalizeForMatch)
    .filter((word) => word.length > 0);
  if (words.length === 0) return 0;
  const hits = words.filter((word) => found.includes(word)).length;
  return short ? Math.min(hits / words.length, UNSURE_SCORE) : Math.min(hits / words.length, CONTAINS_SCORE);
}

/** Titles this short (in letters, spaces aside) must be named, not just contained. */
const SHORT_TITLE_LENGTH = 4;
/** A longer title the hit contains inside a longer phrase: still the song. */
const CONTAINS_SCORE = 0.9;
/** A short title the hit merely contains: worth showing, not attaching. */
const UNSURE_SCORE = 0.5;

/**
 * Words a 찬양 post puts around a song's name — none of them make the name a
 * different song's. A key (C, Bb, Am) counts too; see isPostWords.
 */
const POST_WORDS = [
  '찬양', '찬송가', '복음성가', 'ccm', 'ppt', '피피티', '악보', '가사', '코드', '무배경',
  '다운로드', '다운', '공유', '추천', '듣기', '키', 'key', 'ver', '버전',
];

/**
 * True when `rest` (normalized) is nothing but POST_WORDS and keys, run
 * together. Walked position by position rather than with one big regex, whose
 * overlapping alternatives could backtrack for ever on a crafted title.
 */
function isPostWords(rest) {
  const reachable = new Array(rest.length + 1).fill(false);
  reachable[0] = true;
  for (let i = 0; i < rest.length; i++) {
    if (!reachable[i]) continue;
    for (const word of POST_WORDS) {
      if (rest.startsWith(word, i)) reachable[i + word.length] = true;
    }
    if ('abcdefg'.includes(rest[i])) {
      reachable[i + 1] = true;
      if (rest[i + 1] === 'm') reachable[i + 2] = true;
    }
  }
  return reachable[rest.length];
}

/**
 * True when some part of `text` — split at its brackets, quotes, dashes and
 * slashes — is the song's name (`wanted`, normalized) with nothing but
 * POST_WORDS around it.
 */
function namesTitle(wanted, text) {
  const parts = String(text || '')
    .toLowerCase()
    .split(/[^\s0-9a-z\uac00-\ud7a3#♭♯]+/)
    .map(normalizeForMatch);
  return parts.some((part) => {
    for (let at = part.indexOf(wanted); at !== -1; at = part.indexOf(wanted, at + 1)) {
      if (isPostWords(part.slice(0, at)) && isPostWords(part.slice(at + wanted.length))) return true;
    }
    return false;
  });
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
        scoreSongMatch(title, fileNameOf(hit.url ?? '')),
      );
      return { ...hit, score, decision: score >= AUTO_ATTACH_SCORE ? 'auto' : 'review' };
    })
    .sort((a, b) => b.score - a.score);
}

/**
 * A URL's file name, decoded when it is UTF-8. 네이버's older files are
 * named in EUC-KR (`%B3%AA…`), which decodeURIComponent throws on.
 */
function fileNameOf(rawUrl) {
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

export async function fetchWithTimeout(url, { timeoutMs = SEARCH_TIMEOUT_MS, headers = {}, method, body } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      method,
      body,
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

  // Each search is its own list of requests, tried in order until one
  // answers with hits; the searches themselves run side by side, so one
  // engine being slow or turning the Worker away costs nothing. Google comes
  // first, so on a tie in the ranking its order is the one that stands.
  const htmlSearch = (endpoints, extract) => ({
    requests: endpoints.map((endpoint) => (query) => fetchWithTimeout(endpoint(query))),
    read: async (response) => extract(await readBoundedText(response), env),
  });
  const searches = [
    ...(googleSearchKey(env)
      ? [
          {
            requests: [(query) => fetchGoogleSearch(query, env)],
            read: async (response) => extractGoogleResults(JSON.parse(await readBoundedText(response)), env),
          },
        ]
      : []),
    htmlSearch([daumBlogSearchUrl], extractDaumBlogResults),
    htmlSearch([naverBlogSearchUrl], extractNaverBlogResults),
    htmlSearch(SEARCH_ENDPOINTS, extractSongPptResults),
  ];
  const runSearch = async (search, query) => {
    for (const request of search.requests) {
      try {
        const response = await request(query);
        if (!response.ok) continue;
        const found = await search.read(response);
        if (found.results.length > 0 || found.links.length > 0) return found;
      } catch {
        // A search engine being unreachable just means trying the next one.
      }
    }
    return { results: [], links: [] };
  };

  const results = [];
  const links = [];
  const seen = new Map();
  for (const query of queries) {
    for (const found of await Promise.all(searches.map((search) => runSearch(search, query)))) {
      for (const hit of found.results) {
        const key = postKey(hit.url);
        const existing = seen.get(key);
        if (existing) {
          // The other search may have seen the snippet that names the file.
          existing.attachment ??= hit.attachment;
          existing.sheet ||= hit.sheet;
          continue;
        }
        seen.set(key, hit);
        results.push(hit);
      }
      for (const link of found.links) {
        if (!links.some((existing) => existing.url === link.url)) links.push(link);
      }
    }
    if (results.length >= MAX_SONG_PPT_CANDIDATES) break;
  }

  const candidates = [];
  for (const hit of rankSongPptHits(title, results).slice(0, MAX_SONG_PPT_CANDIDATES)) {
    candidates.push({ ...hit, token: await signSongPptToken(hit.url, secret) });
  }
  return { candidates, links: links.slice(0, MAX_SONG_PPT_CANDIDATES) };
}

/** True when these bytes are an OLE compound file — the old binary .ppt. */
function isLegacyOfficeBytes(bytes) {
  return bytes.length >= 4 && bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0;
}

const LEGACY_PPT_MESSAGE =
  '이 게시글의 PPT는 옛 형식(.ppt)이라 넣을 수 없습니다. PowerPoint에서 .pptx로 저장해 직접 올려 주세요.';

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
    // A 네이버 블로그 address is a frame; the post, and its attachment, are
    // on the mobile page.
    const pageUrl = mobileNaverBlogUrl(fileUrl) ?? fileUrl;
    const page = await fetchWithTimeout(pageUrl);
    if (!page.ok) throw new Error(`게시글을 열지 못했습니다 (HTTP ${page.status}).`);
    const finalPageUrl = page.url || pageUrl;
    if (!isAllowedSongPptUrl(finalPageUrl, env)) {
      throw new Error('허용되지 않은 주소로 이동했습니다.');
    }
    const html = await readBoundedText(page);
    const attachment = findSongPptAttachment(html, finalPageUrl, env);
    if (!attachment) {
      if (hasLegacyPptAttachment(html, finalPageUrl)) throw new Error(LEGACY_PPT_MESSAGE);
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
  if (isLegacyOfficeBytes(bytes)) throw new Error(LEGACY_PPT_MESSAGE);
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
