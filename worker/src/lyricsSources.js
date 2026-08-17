// Which lyrics sites the proxy will read, and how to read each one.
//
// Extraction used to be one generic pass over whichever page scored highest.
// That is fine for finding *a* lyric block and useless for deciding whether it
// is the right song: the decision needs the page's own title and artist, and
// how much the site can be trusted. Each source is therefore an adapter that
// returns a full candidate rather than bare lines.
//
// The allowlist is also the SSRF boundary. The client only ever sends a title,
// never a URL, and a search result that is not on one of these hosts is
// dropped before any fetch happens.
import { decodeHtmlEntities, extractLyricBlock, htmlToLines } from './lyricsHtml.js';

/**
 * Trust is how much the source itself moves a candidate's score (weight 0.05),
 * not whether it is read at all. A dedicated Korean worship-lyrics database is
 * more reliable than a personal blog post that may be quoting from memory.
 */
export const SOURCE_ADAPTERS = [
  { id: 'ccm', hosts: ['ccm.co.kr', 'www.ccm.co.kr'], trust: 0.9, extract: extractGenericLyrics },
  { id: 'ccmpia', hosts: ['ccmpia.com', 'www.ccmpia.com', 'lyrics.ccmpia.com'], trust: 0.85, extract: extractGenericLyrics },
  { id: 'pjnara', hosts: ['pjnara.com', 'www.pjnara.com'], trust: 0.8, extract: extractGenericLyrics },
  { id: 'somang', hosts: ['somang.net', 'www.somang.net'], trust: 0.8, extract: extractGenericLyrics },
  { id: 'worshipedia', hosts: ['worshipedia.co.kr', 'www.worshipedia.co.kr'], trust: 0.85, extract: extractGenericLyrics },
  { id: 'naver-blog', hosts: ['blog.naver.com', 'm.blog.naver.com'], trust: 0.65, extract: extractGenericLyrics },
];

/**
 * Bugs is a commercial music service. Its pages are excellent metadata but
 * scraping them is not ours to decide, so the adapter exists and stays off
 * until an administrator records permission in the Worker environment. Without
 * it a Bugs search result may still be shown to the user as a LINK — the page
 * itself is never fetched.
 */
export const BUGS_ADAPTER = {
  id: 'bugs',
  hosts: ['music.bugs.co.kr', 'bugs.co.kr', 'www.bugs.co.kr'],
  trust: 0.9,
  extract: extractGenericLyrics,
};

/** True only when the deployment explicitly recorded permission. */
export function bugsScrapingAllowed(env = {}) {
  return env.BUGS_SCRAPING_ALLOWED === 'true';
}

/** The adapters this deployment may actually fetch from. */
export function activeSourceAdapters(env = {}) {
  return bugsScrapingAllowed(env) ? [...SOURCE_ADAPTERS, BUGS_ADAPTER] : [...SOURCE_ADAPTERS];
}

/** Every host any adapter — active or not — could name, for link-only results. */
export function knownSourceHosts() {
  return [...SOURCE_ADAPTERS, BUGS_ADAPTER].flatMap((adapter) => adapter.hosts);
}

/** Hosts the proxy may fetch, given this deployment's permissions. */
export function allowedHosts(env = {}) {
  return activeSourceAdapters(env).flatMap((adapter) => adapter.hosts);
}

/** The adapter that owns a URL's host, or null when no adapter claims it. */
export function adapterForUrl(rawUrl, adapters = SOURCE_ADAPTERS) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:') return null;
  const host = parsed.hostname.toLowerCase();
  return adapters.find((adapter) => adapter.hosts.includes(host)) ?? null;
}

/** Strip tags and whitespace from a fragment of markup. */
function plainText(value) {
  return decodeHtmlEntities(String(value ?? '').replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

/** Site furniture routinely appended to a page title. */
const TITLE_SUFFIX = /\s*[|\-–—:·]\s*(?:[^|\-–—:·]{1,30})$/;

/**
 * The song title the page itself claims.
 *
 * og:title first: it is the one field these sites fill in deliberately, while
 * <title> usually carries the site name too. The trailing site name is trimmed
 * because "은혜의 노래 - CCM 가사" must compare equal to "은혜의 노래".
 */
export function extractPageTitle(html) {
  const source = String(html ?? '');
  const og = source.match(/<meta[^>]+property=["']og:title["'][^>]*content=["']([^"']+)["']/i);
  const heading = source.match(/<h1[^>]*>([\s\S]{0,200}?)<\/h1>/i);
  const title = source.match(/<title[^>]*>([\s\S]{0,200}?)<\/title>/i);
  const raw = plainText(og?.[1] ?? heading?.[1] ?? title?.[1] ?? '');
  return raw.replace(TITLE_SUFFIX, '').trim();
}

/**
 * Labels these sites put in front of the performer's name.
 *
 * The separator is mandatory. Without it "어느 사역팀이 부른 곡" reads as a
 * label followed by a name, and the page would report an artist it never
 * named.
 */
const ARTIST_LABEL = /(?:아티스트|가수|찬양팀|사역팀|앨범아티스트|artist)\s*[:：]\s*([^<\n|]{1,40})/i;

/**
 * The performer, when the page names one.
 *
 * Deliberately conservative: a wrong artist is worse than no artist, because
 * artist agreement is what keeps two different songs with the same title
 * apart. Anything that does not sit behind an explicit label is left alone.
 */
export function extractPageArtist(html) {
  const source = String(html ?? '');
  const meta = source.match(/<meta[^>]+property=["']og:music:musician["'][^>]*content=["']([^"']+)["']/i);
  if (meta) return plainText(meta[1]);
  // Matched against the raw markup on purpose: the surrounding tags are what
  // bound the name. On flattened text the capture would run on into the lyrics.
  const labelled = ARTIST_LABEL.exec(source);
  const artist = labelled ? plainText(labelled[1]) : '';
  return artist.length >= 1 && artist.length <= 40 ? artist : '';
}

/** Read one lyrics page into a candidate. Returns null when it has no lyrics. */
export function extractGenericLyrics(html, url, adapter) {
  const lines = extractLyricBlock(htmlToLines(html));
  if (lines.length === 0) return null;
  let host = '';
  try {
    host = new URL(url).hostname;
  } catch {
    return null;
  }
  return {
    id: `${adapter.id}:${host}${new URL(url).pathname}`.slice(0, 200),
    title: extractPageTitle(html),
    artist: extractPageArtist(html) || undefined,
    lines,
    url,
    host,
    source: adapter.id,
    sourceTrust: adapter.trust,
  };
}
