// Turning a scraped HTML page into candidate lyric lines.
//
// Pure string work, split out from lyrics.js so the source adapters can use it
// without the two files importing each other. Nothing here touches the
// network, so the whole extraction chain is unit-tested directly.

/** A page must carry at least this many Korean lines to count as lyrics. */
const MIN_LYRIC_LINES = 4;
/** Beyond this a "lyric block" is really a whole page of prose. */
const MAX_LYRIC_LINES = 200;

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

