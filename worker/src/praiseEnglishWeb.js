// 찬양집회 영어 가사 from the web: search "<곡 제목> 영어 가사", open the
// posts that come back, and hand the browser each page's lyric blocks.
//
// A 찬양집회 conti usually says nothing in English, and most of its songs
// are sung in English somewhere: a Korean translation of an English worship
// song, or a Korean song someone has put into English. Korean blogs publish
// exactly that, most often as the Korean stanza followed by its English
// stanza, so a page is returned as its run of Korean and English blocks in
// the order they were printed. The browser pairs them and matches each
// Korean stanza against the conti's own Korean lyrics — it is the only side
// that knows them — so the English lands under the slide it translates.
//
// When the song has an English original, its English title — the one the
// browser already knows, or the one the posts name it by ("부르신 곳에서 (At
// the Place You've Called Me To)") — is looked up too, the way the operator
// would next: "<English title> lyrics", on Genius and on Google. A lyrics
// site prints the English only, headed [Verse 1], [Chorus]…, so those
// headings come back as each block's label for the browser to line up with
// the conti's own parts.
//
// Like the other lookups only a title crosses the wire, and what is fetched
// is a page this proxy chose off its own searches: https only, never an
// address that resolves inside, a size cap, and the URL re-checked after
// redirects.
import {
  daumBlogSearchUrl,
  extractDaumBlogResults,
  extractGoogleResults,
  extractNaverBlogResults,
  extractSongPptResults,
  fetchWithTimeout,
  googleSearchKey,
  GOOGLE_SEARCH_ENDPOINT,
  isAllowedSongPptUrl,
  isNeverFileHost,
  mobileNaverBlogUrl,
  naverBlogSearchUrl,
  readBoundedText,
} from './songPpt.js';

/** Pages read per song: enough to find one good post, few enough to stay quick. */
export const MAX_ENGLISH_PAGES = 4;
/** Lyrics-site pages read for the English original, on top of the posts. */
export const MAX_ORIGINAL_PAGES = 2;
/** Candidates handed back to the browser: the best posts, and the best lyrics page. */
export const MAX_ENGLISH_CANDIDATES = 3;
const PAGE_TIMEOUT_MS = 6000;
const GOOGLE_TIMEOUT_MS = 8000;
/** A page's lyric blocks are capped: a whole blog's sidebar is not lyrics. */
const MAX_BLOCKS = 160;
const MAX_LINES = 500;
/**
 * DuckDuckGo turns away a client that does not look like a browser, and it
 * is only ever asked for a results page — never used to fetch a post.
 */
const BROWSER_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

/** The search the operator would type: the song's title and "영어 가사". */
export function englishLyricsQuery(title) {
  const clean = String(title || '').trim();
  return clean ? `${clean} 영어 가사` : '';
}

/** The search for an English original: its title and "lyrics". */
export function originalLyricsQuery(englishTitle) {
  const clean = String(englishTitle || '').trim();
  return clean ? `${clean} lyrics` : '';
}

/** True when a title is written in English letters, with no Hangul. */
export function isEnglishTitle(title) {
  const text = String(title || '');
  return !/[가-힣ㄱ-ㆎ]/.test(text) && (text.match(/[A-Za-z]/g) || []).length >= 2;
}

/** Letters and digits only, lower-cased — how two titles are compared. */
export function titleKey(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^0-9a-z가-힣ㄱ-ㆎ]+/g, '');
}

// ---- reading a page -----------------------------------------------------------

const NAMED_ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  rsquo: '’',
  lsquo: '‘',
  rdquo: '”',
  ldquo: '“',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  middot: '·',
  bull: '•',
  zwj: '',
  zwnj: '',
};

export function decodeEntities(text) {
  return String(text || '')
    .replace(/&#(\d+);/g, (_, code) => safeCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => safeCodePoint(parseInt(code, 16)))
    .replace(/&([a-z]+);/gi, (whole, name) => {
      const value = NAMED_ENTITIES[name.toLowerCase()];
      return value === undefined ? whole : value;
    });
}

function safeCodePoint(code) {
  try {
    return String.fromCodePoint(code);
  } catch {
    return '';
  }
}

/**
 * A page's text as lines, KEEPING the empty lines between stanzas: they are
 * what separates one stanza (or one language) from the next. Zero-width
 * spaces — which Korean blog editors put on every "empty" line — count as
 * empty too.
 */
export function pageLines(html) {
  const text = String(html || '')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|template|svg|head|nav|footer|header|aside|form|button|select)\b[\s\S]*?<\/\1>/gi, ' ')
    // Line breaks in the markup itself mean nothing; only the tags below do.
    .replace(/\s+/g, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    // A paragraph ends its line; only a paragraph with nothing in it — a
    // <p>&nbsp;</p>, or the zero-width space blog editors write — leaves an
    // empty line behind. Larger blocks start a new line of their own too.
    .replace(/<\/(p|div|li|tr|h[1-6]|section|article|blockquote|pre|table|ul|ol)>/gi, '\n')
    .replace(/<(div|li|tr|h[1-6]|section|article|blockquote|pre|table|ul|ol)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '');
  const lines = decodeEntities(text)
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) =>
      line
        .replace(/[​‌‍﻿]/g, '')
        .replace(/[\t  　]+/g, ' ')
        .trim(),
    );
  // Runs of empty lines are one break.
  const out = [];
  for (const line of lines) {
    if (!line && (out.length === 0 || out[out.length - 1] === '')) continue;
    out.push(line);
  }
  if (out[out.length - 1] === '') out.pop();
  return out;
}

/** A part heading: "Verse 1", "[Chorus]", "Bridge:", "1절", "후렴". */
const PART_LABEL =
  /^[[(<{]?\s*(?:verse|chorus|pre[- ]?chorus|bridge|tag|outro|intro|refrain|ending|interlude|instrumental|\d\s*절|절|후렴(?:구)?|브릿지|브리지|간주|전주|후주|코러스)\s*\d*\s*[\])>}]?\s*[:.]?\s*$/i;

/**
 * A lyrics site's heading, which names who sings the part after a colon:
 * "[Verse 1: Brandon Lake]", "[Chorus: All]", "[Post-Chorus]".
 */
const SITE_PART_LABEL =
  /^\[\s*(?:verse|chorus|pre[- ]?chorus|post[- ]?chorus|bridge|tag|outro|intro|refrain|ending|interlude|instrumental|hook|vamp|break)\b[^\]]{0,80}\]$/i;

/** A heading as the block's label: "[Verse 1: Brandon Lake]" → "Verse 1". */
function partLabel(line) {
  return line
    .replace(/:.*$/, '')
    .replace(/[[\](){}<>:.]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Site furniture around the lyrics on these pages. */
const BOILERPLATE =
  /(copyright|all rights reserved|ccli|admin(istere)?d by|songselect|저작권|출처|공유하기|댓글|구독|좋아요|카테고리|로그인|블로그|이웃|스크랩|게시글|방명록|관련글|https?:\/\/|www\.)/i;

function counts(line) {
  return {
    hangul: (line.match(/[가-힣]/g) || []).length,
    latin: (line.match(/[A-Za-z]/g) || []).length,
    words: line.split(/\s+/).filter((word) => /[A-Za-z]{2,}/.test(word)).length,
  };
}

/**
 * What a line is: Korean lyrics, English lyrics, a part heading, an empty
 * line (a stanza break), or anything else (prose, dates, menus).
 *
 * Lyric lines are short. A blog's own sentences about the song run long, so
 * the length caps are what keep its write-up out of the lyrics.
 */
export function lineKind(line) {
  const text = String(line ?? '').trim();
  if (!text) return 'blank';
  if (PART_LABEL.test(text) || SITE_PART_LABEL.test(text)) return 'label';
  if (BOILERPLATE.test(text)) return 'other';
  const { hangul, latin, words } = counts(text);
  if (hangul >= 2 && latin * 2 <= hangul && text.length <= 48) return 'ko';
  if (hangul === 0 && latin >= 3 && words >= 1 && words <= 16 && text.length <= 90) {
    // A lone word is a heading ("Lyrics", "Korean") unless it is sung.
    if (words === 1 && !/^(hallelujah|alleluia|hosanna|amen|oh+|jesus|holy|worthy)[!,.]*$/i.test(text)) return 'other';
    return 'en';
  }
  return 'other';
}

/**
 * The page's lyric blocks, in order: each a run of lines in one language,
 * broken wherever the page leaves an empty line, prints a heading, or
 * switches language. A heading right before a block is kept as its label.
 */
export function lyricBlocks(lines) {
  const blocks = [];
  let current = null;
  let label = '';
  const close = () => {
    if (current && current.lines.length > 0) blocks.push(current);
    current = null;
  };
  for (const line of lines) {
    const kind = lineKind(line);
    if (kind === 'ko' || kind === 'en') {
      if (current && current.lang !== kind) close();
      if (!current) {
        current = { lang: kind, lines: [], ...(label ? { label } : {}) };
        label = '';
      }
      current.lines.push(line);
      continue;
    }
    close();
    label = kind === 'label' ? partLabel(line) : kind === 'blank' ? label : '';
  }
  close();
  const capped = [];
  let total = 0;
  for (const block of blocks.slice(0, MAX_BLOCKS)) {
    if (total >= MAX_LINES) break;
    const lines = block.lines.slice(0, MAX_LINES - total).map((line) => line.slice(0, 200));
    total += lines.length;
    capped.push({ ...block, lines });
  }
  return capped;
}

/** English lines that read as lyrics: two words or more. */
function lyricEnglishLines(blocks) {
  return blocks
    .filter((block) => block.lang === 'en')
    .flatMap((block) => block.lines)
    .filter((line) => counts(line).words >= 2);
}

/** Words in a title that are about the post, not the song. */
const TITLE_NOISE =
  /\b(lyrics?|english|korean|ver(sion)?|ccm|ppt|mr|key|chords?|official|live|audio|video|cover|feat)\b/gi;

/** Where `title` ends in `text`, however the two are spaced; -1 when it is not there. */
function titleEnd(text, title) {
  const letters = [...String(title || '').replace(/\s+/g, '')];
  if (letters.length === 0) return -1;
  const pattern = new RegExp(letters.map((ch) => ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s*'), 'i');
  const match = pattern.exec(text);
  return match ? match.index + match[0].length : -1;
}

/**
 * The English title a post names the song by, if it names one: text in
 * brackets first ("주님의 선하심 (Goodness of God)"), else the longest run
 * of English words in the heading. '' when there is none.
 *
 * With the song's own title, brackets printed before it are passed over: a
 * post leads with its series or category there ("[K-Gospel Ep-1] 부르신
 * 곳에서"), and the song's English name follows the song.
 */
export function englishTitleFrom(heading, songTitle = '') {
  const text = decodeEntities(String(heading || ''));
  const songAt = songTitle ? titleEnd(text, songTitle) : -1;
  const candidates = [];
  for (const match of text.matchAll(/[([（【<「『]\s*([A-Za-z][A-Za-z0-9 '’,.!?&-]{2,60}?)\s*[)\]）】>」』]/g)) {
    if (songAt >= 0 && match.index < songAt) continue;
    candidates.push(match[1]);
  }
  if (candidates.length === 0) {
    // Without brackets, a leading bracketed tag is not the song's name either.
    const rest = songAt >= 0 ? text.replace(/^\s*[[(【<「『][^\])】>」』]*[\])】>」』]/, ' ') : text;
    for (const match of rest.matchAll(/[A-Za-z][A-Za-z0-9'’]*(?:[ ,.!?&-]+[A-Za-z0-9'’]+)*/g)) candidates.push(match[0]);
  }
  const cleaned = candidates
    .map((candidate) =>
      candidate
        .replace(TITLE_NOISE, ' ')
        .replace(/\s+/g, ' ')
        .replace(/^[\s,.&-]+|[\s,.&-]+$/g, '')
        .trim(),
    )
    .filter((candidate) => candidate.split(' ').filter((word) => /[A-Za-z]{2,}/.test(word)).length >= 2);
  cleaned.sort((a, b) => b.length - a.length);
  const best = cleaned[0] ?? '';
  // Title case as the post wrote it; an all-lowercase one gets capitals.
  return best && best === best.toLowerCase() ? best.replace(/\b[a-z]/g, (ch) => ch.toUpperCase()) : best;
}

/** The page's own title, for a page found without a search heading. */
function pageTitle(html) {
  const source = String(html || '');
  const og = source.match(/<meta[^>]+property=["']og:title["'][^>]*content=["']([^"']+)["']/i);
  const title = source.match(/<title[^>]*>([\s\S]{0,300}?)<\/title>/i);
  return decodeEntities((og?.[1] ?? title?.[1] ?? '').replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

// ---- Genius ------------------------------------------------------------------------

/** True for a Genius page (genius.com and its subdomains). */
export function isGeniusUrl(rawUrl) {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'genius.com' || host.endsWith('.genius.com');
  } catch {
    return false;
  }
}

/**
 * Every element whose opening tag matches `attribute`, with all it holds:
 * the tag's own name is counted open and shut to find where it ends.
 * Returns each element's [start, end) in `html`.
 */
function elementSpans(html, attribute) {
  const spans = [];
  const opening = new RegExp(`<([a-z][a-z0-9]*)\\b[^>]*${attribute.source}[^>]*>`, 'gi');
  let match;
  while ((match = opening.exec(html))) {
    const tag = match[1].toLowerCase();
    const tags = new RegExp(`<(/?)${tag}\\b[^>]*?(/?)>`, 'gi');
    tags.lastIndex = match.index + match[0].length;
    let depth = 1;
    let end = html.length;
    let inner;
    while ((inner = tags.exec(html))) {
      if (inner[2]) continue; // <div/> opens nothing
      depth += inner[1] ? -1 : 1;
      if (depth === 0) {
        end = inner.index + inner[0].length;
        break;
      }
    }
    spans.push([match.index, end]);
    opening.lastIndex = end;
  }
  return spans;
}

/**
 * A Genius page's lyrics, and nothing else of it.
 *
 * The page is mostly not lyrics — its header, the song's description,
 * annotations, credits, comments — and much of that is short English lines
 * that would read as lyrics, so only the lyrics' own containers
 * (data-lyrics-container="true") are kept. Inside them, what Genius marks
 * as outside the lyrics (data-exclude-from-selection: the "N Contributors
 * · Song Lyrics" header, 'Translations') is dropped. An ad splits the
 * lyrics into several containers, often in the middle of a stanza, so they
 * read on as one: the line breaks a container starts or ends on are not a
 * stanza's end (Genius heads every stanza — [Chorus] — and that is what
 * separates them). '' when the page holds no lyrics containers.
 */
export function geniusLyricsHtml(html) {
  const source = String(html || '');
  return elementSpans(source, /data-lyrics-container="true"/)
    .map(([start, end]) => {
      let part = source.slice(start, end);
      const excluded = elementSpans(part, /data-exclude-from-selection="true"/);
      for (const [from, to] of excluded.reverse()) part = part.slice(0, from) + part.slice(to);
      return part
        .replace(/^<[^>]+>/, '')
        .replace(/<\/[a-z0-9]+>\s*$/i, '')
        .replace(/^(?:\s|<br\s*\/?>)+|(?:\s|<br\s*\/?>)+$/gi, '');
    })
    .filter(Boolean)
    .join('<br>');
}

/** "Elevation Worship – Praise Lyrics | Genius Lyrics" → "Praise". */
export function geniusSongTitle(pageHeading) {
  const text = decodeEntities(String(pageHeading || ''))
    .replace(/\s*\|\s*Genius(?: Lyrics)?\s*$/i, '')
    .replace(/\s+Lyrics\s*$/i, '')
    .trim();
  const parts = text.split(/\s+[–—-]\s+/);
  return (parts.length > 1 ? parts.slice(1).join(' - ') : '').trim();
}

/**
 * One page as a candidate: its lyric blocks and how likely it is to be the
 * song's English. Null when it carries no English lyrics at all.
 *
 * `title` is the title the page was searched by: the Korean one for a
 * 영어 가사 post, the English one for a lyrics site's page. `englishTitle`,
 * when the search already knows it, is the English title handed back.
 */
export function englishCandidateFromPage(html, { url, host, heading = '', englishTitle = '' }, title) {
  const genius = isGeniusUrl(url);
  const lyricsHtml = genius ? geniusLyricsHtml(html) : html;
  if (!lyricsHtml) return null;
  const blocks = lyricBlocks(pageLines(lyricsHtml));
  const english = lyricEnglishLines(blocks);
  if (english.length < 4) return null;
  const titleText = `${heading} ${pageTitle(html)}`;
  const named = titleKey(titleText).includes(titleKey(title));
  const bilingual = blocks.some((block) => block.lang === 'ko') && blocks.some((block) => block.lang === 'en');
  const aboutEnglish = /영어|영문|english|lyrics/i.test(titleText);
  const score =
    (named ? 0.5 : 0) + (aboutEnglish ? 0.2 : 0) + (bilingual ? 0.15 : 0) + Math.min(english.length, 40) / 40 * 0.15;
  // A lyrics site's heading names the artist too, so the English title is
  // the one searched by, or the one its "Artist – Title Lyrics" gives.
  const englishName = genius
    ? englishTitle || geniusSongTitle(pageTitle(html)) || geniusSongTitle(heading)
    : englishTitle || englishTitleFrom(heading, title) || englishTitleFrom(pageTitle(html), title);
  return {
    url,
    host,
    title: (heading || pageTitle(html)).slice(0, 200),
    englishTitle: englishName,
    score: Math.round(score * 100) / 100,
    blocks,
  };
}

// ---- searching ------------------------------------------------------------------

/** Search hits whose heading names the song: the only ones worth opening. */
export function relevantHits(hits, title) {
  const want = titleKey(title);
  if (!want) return [];
  const seen = new Set();
  const out = [];
  for (const hit of hits) {
    if (!hit?.url || !titleKey(hit.title).includes(want)) continue;
    if (!isAllowedSongPptUrl(hit.url, {}) || isNeverFileHost(hit.url)) continue;
    const key = (mobileNaverBlogUrl(hit.url) ?? hit.url).replace(/^https:\/\/m\./, 'https://').replace(/\/$/, '');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(hit);
  }
  // A post that says it is the English lyrics before one that merely names the song.
  const aboutEnglish = (hit) => (/영어|영문|english|lyrics/i.test(hit.title) ? 0 : 1);
  return out
    .map((hit, index) => ({ hit, index }))
    .sort((a, b) => aboutEnglish(a.hit) - aboutEnglish(b.hit) || a.index - b.index)
    .map(({ hit }) => hit);
}

/**
 * Google, through SerpApi, for the same phrase — only when a key is set.
 * An English original's "<title> lyrics" is asked of Google in English.
 */
export function googleEnglishSearchUrl(query, env = {}, { english = false } = {}) {
  const params = new URLSearchParams({
    engine: 'google',
    q: query,
    ...(english ? { hl: 'en', gl: 'us' } : { hl: 'ko', gl: 'kr', google_domain: 'google.co.kr' }),
    api_key: googleSearchKey(env),
  });
  return `${GOOGLE_SEARCH_ENDPOINT}?${params}`;
}

/**
 * DuckDuckGo's HTML results — Bing's index, and no key needed. It turns a
 * server away often (HTTP 202 and no results), so it is only ever one
 * search among several.
 */
export function duckDuckGoSearchUrl(query) {
  return `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
}

function searchGoogle(query, env, options) {
  return fetchWithTimeout(googleEnglishSearchUrl(query, env, options), { timeoutMs: GOOGLE_TIMEOUT_MS }).then(
    async (response) => (response.ok ? extractGoogleResults(await response.json(), {}, 12).results : []),
  );
}

function searchDuckDuckGo(query) {
  return fetchWithTimeout(duckDuckGoSearchUrl(query), { headers: { 'User-Agent': BROWSER_USER_AGENT } }).then(
    async (response) => (response.ok ? extractSongPptResults(await readBoundedText(response), {}, 12).results : []),
  );
}

async function settledHits(searches) {
  const settled = await Promise.allSettled(searches);
  return settled.flatMap((result) => (result.status === 'fulfilled' ? result.value : []));
}

/** "<곡 제목> 영어 가사" on Google (with a key), DuckDuckGo, 다음 and 네이버 블로그. */
async function searchHits(query, env) {
  const searches = [
    fetchWithTimeout(daumBlogSearchUrl(query)).then(async (response) =>
      response.ok ? extractDaumBlogResults(await readBoundedText(response), {}, 12).results : [],
    ),
    fetchWithTimeout(naverBlogSearchUrl(query)).then(async (response) =>
      response.ok ? extractNaverBlogResults(await readBoundedText(response), {}, 12).results : [],
    ),
    searchDuckDuckGo(query),
  ];
  if (googleSearchKey(env)) searches.unshift(searchGoogle(query, env));
  return settledHits(searches);
}

// ---- the English original ----------------------------------------------------------

/** Genius's own song search: keyless JSON, the same the site's search box asks. */
export const GENIUS_SEARCH_ENDPOINT = 'https://genius.com/api/search/song';

export function geniusSearchUrl(englishTitle) {
  return `${GENIUS_SEARCH_ENDPOINT}?${new URLSearchParams({ q: String(englishTitle || '').trim(), per_page: '10' })}`;
}

/**
 * Artists a 찬양집회 sings, so that of several songs called "Praise" or
 * "Holy" the worship song is opened, not a rapper's. Any artist whose name
 * says Worship counts too.
 */
const WORSHIP_ARTISTS =
  /worship|hillsong|bethel|maverick city|elevation|passion|jesus culture|housefires|upperroom|planetshakers|chris tomlin|phil wickham|matt redman|brandon lake|cece winans|kari jobe|cody carnes|lauren daigle|casting crowns|michael w\.? smith|don moen|darlene zschech|shane (?:&|and) shane|rend collective|crowder|for king (?:&|and) country|lincoln brewster|israel houghton|tim hughes|paul baloche|sinach|leeland|all sons (?:&|and) daughters|torwalt|amanda cook|kristene dimarco|jeremy riddle|pat barrett|sean feucht|gateway|vertical|anthem lights|citizens|sovereign grace|keith (?:&|and) kristyn getty|getty|matt maher|jesus image|red rocks|we the kingdom|brooke ligertwood|chandler moore|naomi raine|tasha cobbs|hezekiah walker|william mcdowell|travis greene|j(?:\.|onathan)? ?mcreynolds|zach williams|mercyme|big daddy weave|newsboys|third day|sonicflood|delirious|stuart townend|graham kendrick|marcos witt|israel (?:&|and) new breed|dante bowe|tauren wells|tobymac|jeremy camp|hillsong young (?:&|and) free/i;

/**
 * Genius search hits for a title: songs whose own title is the title (not
 * one that merely contains it), a worship artist's first, then Genius's
 * order.
 */
export function extractGeniusHits(payload, englishTitle) {
  const want = titleKey(englishTitle);
  if (!want) return [];
  const sections = Array.isArray(payload?.response?.sections) ? payload.response.sections : [];
  const results = sections.flatMap((section) => (Array.isArray(section?.hits) ? section.hits : [])).map((hit) => hit?.result);
  const seen = new Set();
  const out = [];
  for (const result of results) {
    const url = typeof result?.url === 'string' ? result.url.split('#')[0] : '';
    if (!url || seen.has(url) || !isGeniusUrl(url) || !isAllowedSongPptUrl(url, {})) continue;
    if (titleKey(result.title) !== want) continue;
    seen.add(url);
    const artist = String(result.artist_names ?? result.primary_artist?.name ?? '');
    out.push({
      url,
      host: new URL(url).hostname.toLowerCase(),
      title: `${artist ? `${artist} – ` : ''}${result.title} Lyrics`.slice(0, 160),
      englishTitle: String(result.title).trim(),
      worship: WORSHIP_ARTISTS.test(artist),
    });
  }
  return out
    .map((hit, index) => ({ hit, index }))
    .sort((a, b) => Number(b.hit.worship) - Number(a.hit.worship) || a.index - b.index)
    .map(({ hit }) => hit);
}

/**
 * Pages that may carry the English original, best first: Genius's own
 * search, then "<English title> lyrics" on Google (with a key) and
 * DuckDuckGo — kept only when their heading names the song, Genius first.
 * Google is asked only when Genius finds nothing, to spare the month's
 * searches.
 */
async function originalHits(englishTitle, env) {
  const query = originalLyricsQuery(englishTitle);
  const genius = await settledHits([
    fetchWithTimeout(geniusSearchUrl(englishTitle), {
      headers: { Accept: 'application/json', 'User-Agent': BROWSER_USER_AGENT },
    }).then(async (response) => (response.ok ? extractGeniusHits(await response.json(), englishTitle) : [])),
  ]);
  const searches = [searchDuckDuckGo(query)];
  if (genius.length === 0 && googleSearchKey(env)) searches.unshift(searchGoogle(query, env, { english: true }));
  const found = relevantHits(await settledHits(searches), englishTitle);
  const onGenius = (hit) => (isGeniusUrl(hit.url) ? 0 : 1);
  const others = found
    .filter((hit) => !genius.some((known) => known.url === hit.url))
    .map((hit, index) => ({ hit, index }))
    .sort((a, b) => onGenius(a.hit) - onGenius(b.hit) || a.index - b.index)
    .map(({ hit }) => ({ ...hit, englishTitle }));
  return [...genius, ...others];
}

/**
 * The English title the posts name the song by, when most of those that
 * name one agree: "부르신 곳에서 (At the Place You've Called Me To)".
 */
export function englishTitleFromHits(hits, title) {
  const votes = new Map();
  for (const hit of hits) {
    const named = englishTitleFrom(hit.title, title);
    if (!named) continue;
    const key = titleKey(named);
    const entry = votes.get(key) ?? { named, count: 0 };
    entry.count += 1;
    votes.set(key, entry);
  }
  let best = null;
  for (const entry of votes.values()) if (!best || entry.count > best.count) best = entry;
  return best?.named ?? '';
}

async function readPage(hit) {
  const target = mobileNaverBlogUrl(hit.url) ?? hit.url;
  const response = await fetchWithTimeout(target, {
    timeoutMs: PAGE_TIMEOUT_MS,
    // Genius serves its lyrics to a browser only.
    ...(isGeniusUrl(target) ? { headers: { 'User-Agent': BROWSER_USER_AGENT } } : {}),
  });
  if (!response.ok) return null;
  // Re-check where the fetch actually landed: a page may redirect.
  const finalUrl = response.url || target;
  if (!isAllowedSongPptUrl(finalUrl, {})) return null;
  const type = response.headers.get('content-type') || '';
  if (type && !/html|text/i.test(type)) return null;
  return readBoundedText(response);
}

/** Open each hit and keep the pages that carry English lyrics, best first. */
async function readCandidates(hits, title) {
  const pages = await Promise.allSettled(
    hits.map(async (hit) => {
      const html = await readPage(hit);
      if (!html) return null;
      return englishCandidateFromPage(
        html,
        { url: hit.url, host: hit.host, heading: hit.title, englishTitle: hit.englishTitle ?? '' },
        title,
      );
    }),
  );
  return pages
    .flatMap((result) => (result.status === 'fulfilled' && result.value ? [result.value] : []))
    .sort((a, b) => b.score - a.score);
}

/**
 * Look a song's English lyrics up: search, open the few posts whose heading
 * names the song, and return the best of them, most promising first.
 *
 * `englishTitle` is the song's English title when the browser knows it;
 * otherwise it is the song's own title when that is English, or the one the
 * posts found name it by. With one, the English original's lyrics page is
 * looked up too, and the best of those comes back after the posts.
 */
export async function fetchEnglishLyricsCandidates(title, env = {}, { englishTitle = '' } = {}) {
  const query = englishLyricsQuery(title);
  if (!query) return { query, englishTitle: '', candidates: [] };
  const hits = relevantHits(await searchHits(query, env), title);
  const knownEnglish =
    String(englishTitle || '').trim() || (isEnglishTitle(title) ? String(title).trim() : '') || englishTitleFromHits(hits, title);
  const [posts, originals] = await Promise.all([
    readCandidates(hits.slice(0, MAX_ENGLISH_PAGES), title),
    knownEnglish
      ? originalHits(knownEnglish, env)
          .then((found) => readCandidates(found.slice(0, MAX_ORIGINAL_PAGES), knownEnglish))
          .catch(() => [])
      : Promise.resolve([]),
  ]);
  const candidates = posts.slice(0, MAX_ENGLISH_CANDIDATES);
  const original = originals.find((page) => !candidates.some((candidate) => candidate.url === page.url));
  if (original) candidates.push(original);
  return { query, englishTitle: knownEnglish, candidates };
}
