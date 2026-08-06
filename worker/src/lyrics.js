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
// Everything except fetchWebLyrics is a pure function of its input, so the
// whole extraction chain is unit-tested without network access.

/**
 * Hosts the proxy is willing to fetch. The client only ever sends a title —
 * never a URL — and search results are filtered against this list, so an
 * attacker-influenced search result can't turn the proxy into an open relay
 * for arbitrary hosts (SSRF).
 */
export const LYRICS_HOSTS = [
  'ccm.co.kr',
  'www.ccm.co.kr',
  'lyrics.ccmpia.com',
  'www.ccmpia.com',
  'ccmpia.com',
  'pjnara.com',
  'www.pjnara.com',
  'blog.naver.com',
  'm.blog.naver.com',
  'somang.net',
  'www.somang.net',
  'worshipedia.co.kr',
  'www.worshipedia.co.kr',
];

/** Search engines are tried in order until one returns usable result links. */
const SEARCH_ENDPOINTS = [
  (query) => `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
  (query) => `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`,
];

/** A page must carry at least this many Korean lines to count as lyrics. */
const MIN_LYRIC_LINES = 4;
/** Beyond this a "lyric block" is really a whole page of prose. */
const MAX_LYRIC_LINES = 200;

/** Per-request ceilings, so one lookup can never stall the Worker. */
const FETCH_TIMEOUT_MS = 6000;
const MAX_CANDIDATES = 3;
const MAX_HTML_BYTES = 900_000;

/** Search phrasings, most specific first. */
export function buildSearchQueries(title) {
  const clean = String(title || '').trim();
  if (!clean) return [];
  return [`${clean} 찬양 가사`, `${clean} 가사`];
}

/** True when a URL is on a host the proxy may fetch. */
export function isAllowedLyricsUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:') return false;
  return LYRICS_HOSTS.includes(parsed.hostname.toLowerCase());
}

/**
 * Pull candidate result links out of a search engine's HTML.
 *
 * DuckDuckGo's HTML endpoint wraps every outbound link in a redirector
 * (`/l/?uddg=<encoded>`), so the real URL is unwrapped before filtering.
 * Results are deduplicated and capped, and anything off the allowlist is
 * dropped here rather than at fetch time.
 */
export function extractSearchResultUrls(html, limit = MAX_CANDIDATES) {
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
    if (!isAllowedLyricsUrl(href)) continue;
    const key = href.split('#')[0];
    if (seen.has(key)) continue;
    seen.add(key);
    urls.push(key);
    if (urls.length >= limit) break;
  }
  return urls;
}

const NAMED_ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  '#39': "'",
};

/** Decode the entities that actually appear in scraped lyric markup. */
export function decodeHtmlEntities(text) {
  return String(text || '')
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&([a-z]+|#\d+);/gi, (whole, name) => {
      const value = NAMED_ENTITIES[name.toLowerCase()];
      return value === undefined ? whole : value;
    });
}

/**
 * Turn a lyrics page's HTML into plain lines.
 *
 * Line breaks in lyrics markup are carried by <br> and by block-level tags, so
 * both become newlines before the remaining tags are stripped. Script, style
 * and template content is removed first — otherwise inline JSON on a blog page
 * ends up looking like the longest text block on it.
 */
export function htmlToLines(html) {
  const text = String(html || '')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|template|svg|head)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6]|section|article|blockquote)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');

  return decodeHtmlEntities(text)
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[\t 　]+/g, ' ').replace(/ {2,}/g, ' ').trim())
    .filter((line) => line.length > 0);
}

/** Fraction of a line's characters that are Hangul. */
function hangulRatio(line) {
  const hangul = (line.match(/[가-힣]/g) || []).length;
  const letters = (line.match(/[0-9a-zA-Z가-힣]/g) || []).length;
  return letters === 0 ? 0 : hangul / letters;
}

/** Boilerplate that shows up around the lyric block on these sites. */
const BOILERPLATE = [
  /저작권/,
  /운영자|관리자|로그인|회원가입|댓글|덧글|공유하기|스크랩|이웃추가/,
  /^(홈|home|메뉴|검색|목록|이전|다음|더보기|top)$/i,
  /copyright|all rights reserved|admin(istere)?d by/i,
  /^\s*[-=·•]+\s*$/,
  /https?:\/\//,
];

export function isBoilerplateLine(line) {
  return BOILERPLATE.some((pattern) => pattern.test(line));
}

/**
 * A lyric line is short, mostly Korean (or a part label), and not site
 * furniture. Prose paragraphs from a blog post are long, so the length cap is
 * what separates a song's lines from the write-up around it.
 */
export function looksLikeLyricLine(line) {
  if (line.length < 2 || line.length > 60) return false;
  if (isBoilerplateLine(line)) return false;
  if (PART_LABEL_LINE.test(line)) return true;
  return hangulRatio(line) >= 0.6;
}

/** A standalone part heading, which belongs to the lyrics even though it is not one. */
const PART_LABEL_LINE =
  /^[[(<{]?\s*(?:\d\s*절|절|후렴(?:구)?|간주|전주|후주|브릿지|브리지|프리\s*코러스|verse|chorus|bridge|pre[- ]?chorus|intro|outro|refrain|tag)\s*\d?\s*[\])>}]?\s*[:.]?\s*$/i;

/**
 * Pick the lyric block out of a page's lines.
 *
 * Lyrics are a *run* of lyric-shaped lines, so the longest such run wins. A
 * single stray non-lyric line (a blank-turned-caption, an inline ad label) is
 * tolerated inside a run, because otherwise a lyric block splits in two and
 * loses to a shorter, cleaner one elsewhere on the page.
 */
export function extractLyricBlock(lines) {
  let best = [];
  let current = [];
  let misses = 0;

  const flush = () => {
    // Trailing tolerated misses are not part of the block.
    while (current.length > 0 && !looksLikeLyricLine(current[current.length - 1])) current.pop();
    if (current.length > best.length) best = current;
    current = [];
    misses = 0;
  };

  for (const line of lines) {
    if (looksLikeLyricLine(line)) {
      current.push(line);
      misses = 0;
      continue;
    }
    if (current.length > 0 && misses < 1 && !isBoilerplateLine(line)) {
      misses += 1;
      continue;
    }
    flush();
  }
  flush();

  return best.length >= MIN_LYRIC_LINES ? best.slice(0, MAX_LYRIC_LINES) : [];
}

/**
 * Score how well a page's extracted block matches the song we asked for.
 * Pages that never mention the title are usually a search result for a
 * different song on the same site, so title presence dominates the score.
 */
export function scoreLyricBlock(block, title, pageText) {
  if (block.length === 0) return 0;
  const key = (value) => String(value || '').toLowerCase().replace(/[^0-9a-z가-힣]+/g, '');
  const wanted = key(title);
  const haystack = key(`${pageText} ${block.join(' ')}`);
  const titleHit = wanted.length >= 2 && haystack.includes(wanted) ? 1 : 0;
  // Enough lines to be a whole song, without rewarding a runaway block.
  const lengthScore = Math.min(block.length, 40) / 40;
  return titleHit * 2 + lengthScore;
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
 * Look a song's lyrics up on the web.
 *
 * Returns `{ lines, url, host }` for the best-scoring allowlisted page, or
 * `null` when nothing usable was found — the caller then falls back to what
 * the vision models read off the score.
 */
export async function fetchWebLyrics(title) {
  const queries = buildSearchQueries(title);
  if (queries.length === 0) return null;

  const candidates = [];
  for (const query of queries) {
    for (const endpoint of SEARCH_ENDPOINTS) {
      try {
        const response = await fetchWithTimeout(endpoint(query));
        if (!response.ok) continue;
        const urls = extractSearchResultUrls(await readBoundedText(response));
        for (const url of urls) {
          if (!candidates.includes(url)) candidates.push(url);
        }
        if (candidates.length > 0) break;
      } catch {
        // A search engine being unreachable just means trying the next one.
      }
    }
    if (candidates.length >= MAX_CANDIDATES) break;
  }
  if (candidates.length === 0) return null;

  let best = null;
  for (const url of candidates.slice(0, MAX_CANDIDATES)) {
    try {
      const response = await fetchWithTimeout(url);
      if (!response.ok) continue;
      const html = await readBoundedText(response);
      const lines = htmlToLines(html);
      const block = extractLyricBlock(lines);
      const score = scoreLyricBlock(block, title, lines.slice(0, 40).join(' '));
      if (score > 0 && (!best || score > best.score)) {
        best = { score, lines: block, url, host: new URL(url).hostname };
      }
    } catch {
      // Skip a page that refuses the fetch; the next candidate may work.
    }
  }

  return best ? { lines: best.lines, url: best.url, host: best.host } : null;
}
