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
// Like the other lookups only a title crosses the wire, and what is fetched
// is a page this proxy chose off its own searches: https only, never an
// address that resolves inside, a size cap, and the URL re-checked after
// redirects.
import {
  daumBlogSearchUrl,
  extractDaumBlogResults,
  extractGoogleResults,
  extractNaverBlogResults,
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
/** Candidates handed back to the browser. */
export const MAX_ENGLISH_CANDIDATES = 3;
const PAGE_TIMEOUT_MS = 6000;
const GOOGLE_TIMEOUT_MS = 8000;
/** A page's lyric blocks are capped: a whole blog's sidebar is not lyrics. */
const MAX_BLOCKS = 160;
const MAX_LINES = 500;

/** The search the operator would type: the song's title and "영어 가사". */
export function englishLyricsQuery(title) {
  const clean = String(title || '').trim();
  return clean ? `${clean} 영어 가사` : '';
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
  if (PART_LABEL.test(text)) return 'label';
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
    label = kind === 'label' ? line.replace(/[[\](){}<>:.]/g, '').trim() : kind === 'blank' ? label : '';
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

/**
 * The English title a post names the song by, if it names one: text in
 * brackets first ("주님의 선하심 (Goodness of God)"), else the longest run
 * of English words in the heading. '' when there is none.
 */
export function englishTitleFrom(heading) {
  const text = decodeEntities(String(heading || ''));
  const candidates = [];
  for (const match of text.matchAll(/[([（【<「『]\s*([A-Za-z][A-Za-z0-9 '’,.!?&-]{2,60}?)\s*[)\]）】>」』]/g)) {
    candidates.push(match[1]);
  }
  if (candidates.length === 0) {
    for (const match of text.matchAll(/[A-Za-z][A-Za-z0-9'’]*(?:[ ,.!?&-]+[A-Za-z0-9'’]+)*/g)) candidates.push(match[0]);
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

/**
 * One page as a candidate: its lyric blocks and how likely it is to be the
 * song's English. Null when it carries no English lyrics at all.
 */
export function englishCandidateFromPage(html, { url, host, heading = '' }, title) {
  const blocks = lyricBlocks(pageLines(html));
  const english = lyricEnglishLines(blocks);
  if (english.length < 4) return null;
  const titleText = `${heading} ${pageTitle(html)}`;
  const named = titleKey(titleText).includes(titleKey(title));
  const bilingual = blocks.some((block) => block.lang === 'ko') && blocks.some((block) => block.lang === 'en');
  const aboutEnglish = /영어|영문|english|lyrics/i.test(titleText);
  const score =
    (named ? 0.5 : 0) + (aboutEnglish ? 0.2 : 0) + (bilingual ? 0.15 : 0) + Math.min(english.length, 40) / 40 * 0.15;
  return {
    url,
    host,
    title: (heading || pageTitle(html)).slice(0, 200),
    englishTitle: englishTitleFrom(heading) || englishTitleFrom(pageTitle(html)),
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

/** Google, through SerpApi, for the same phrase — only when a key is set. */
export function googleEnglishSearchUrl(query, env = {}) {
  const params = new URLSearchParams({
    engine: 'google',
    q: query,
    hl: 'ko',
    gl: 'kr',
    google_domain: 'google.co.kr',
    api_key: googleSearchKey(env),
  });
  return `${GOOGLE_SEARCH_ENDPOINT}?${params}`;
}

async function searchHits(query, env) {
  const searches = [
    fetchWithTimeout(daumBlogSearchUrl(query)).then(async (response) =>
      response.ok ? extractDaumBlogResults(await readBoundedText(response), {}, 12).results : [],
    ),
    fetchWithTimeout(naverBlogSearchUrl(query)).then(async (response) =>
      response.ok ? extractNaverBlogResults(await readBoundedText(response), {}, 12).results : [],
    ),
  ];
  if (googleSearchKey(env)) {
    searches.unshift(
      fetchWithTimeout(googleEnglishSearchUrl(query, env), { timeoutMs: GOOGLE_TIMEOUT_MS }).then(async (response) =>
        response.ok ? extractGoogleResults(await response.json(), {}, 12).results : [],
      ),
    );
  }
  const settled = await Promise.allSettled(searches);
  return settled.flatMap((result) => (result.status === 'fulfilled' ? result.value : []));
}

async function readPage(hit) {
  const target = mobileNaverBlogUrl(hit.url) ?? hit.url;
  const response = await fetchWithTimeout(target, { timeoutMs: PAGE_TIMEOUT_MS });
  if (!response.ok) return null;
  // Re-check where the fetch actually landed: a page may redirect.
  const finalUrl = response.url || target;
  if (!isAllowedSongPptUrl(finalUrl, {})) return null;
  const type = response.headers.get('content-type') || '';
  if (type && !/html|text/i.test(type)) return null;
  return readBoundedText(response);
}

/**
 * Look a song's English lyrics up: search, open the few posts whose heading
 * names the song, and return the best of them, most promising first.
 */
export async function fetchEnglishLyricsCandidates(title, env = {}) {
  const query = englishLyricsQuery(title);
  if (!query) return { query, candidates: [] };
  const hits = relevantHits(await searchHits(query, env), title).slice(0, MAX_ENGLISH_PAGES);
  const pages = await Promise.allSettled(
    hits.map(async (hit) => {
      const html = await readPage(hit);
      if (!html) return null;
      return englishCandidateFromPage(html, { url: hit.url, host: hit.host, heading: hit.title }, title);
    }),
  );
  const candidates = pages
    .flatMap((result) => (result.status === 'fulfilled' && result.value ? [result.value] : []))
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_ENGLISH_CANDIDATES);
  return { query, candidates };
}
