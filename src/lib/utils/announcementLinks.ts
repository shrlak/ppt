// Web addresses written into a 광고. Nobody types a link in off a projected
// slide, so each one is taken out of the text and drawn as a QR code in the
// slide's corner instead (see lib/pptx/qrCode.ts) — this finds them and says
// what the text reads without them.

/**
 * What an address is made of: printable ASCII but quotes and angle brackets.
 * Korean written straight after one ("…/abc에서 신청") is not part of it.
 */
const URL_CHAR = '[^\\s"\'<>`\\u0080-\\uffff]';

// With its scheme, from "www.", or a bare host and path as a short link is
// usually written ("forms.gle/abc", "bit.ly/xyz"). A bare host needs the path:
// "요한복음 20:21" or "pg. 10" must never read as one.
const URL_SOURCE = `(?:[Hh]ttps?://|[Ww]ww\\.)${URL_CHAR}+|(?:[A-Za-z0-9-]+\\.)+[a-z]{2,}/${URL_CHAR}*`;
const URL_PATTERN = new RegExp(URL_SOURCE, 'g');
const WHOLE_URL = new RegExp(`^(?:${URL_SOURCE})$`);

/** "[신청하기](https://…)", as a note app copies a link out. */
const MARKDOWN_LINK = new RegExp(`\\[([^\\]]*)\\]\\(\\s*<?(${URL_CHAR}+?)>?\\s*\\)`, 'g');

/** What joined a link to the words before it, left dangling once it is gone. */
const TRAILING_JOINER = /[\s,/|\-–—=]+$/;
/** A label the link was the value of: "신청:", "Zoom 링크 →". */
const TRAILING_LABEL_MARK = /\s*(?:[:：]|->|=>|→)$/;

export interface LinkSplit {
  /** The lines with every address taken out; a line that only carried a link is gone. */
  bodyLines: string[];
  /** Each address once, in the order written, ready to scan (always with a scheme). */
  links: string[];
}

function count(text: string, ch: string): number {
  return text.split(ch).length - 1;
}

/** The address without the sentence punctuation that followed it ("…/abc)." → "…/abc"). */
function trimTrailingPunctuation(url: string): string {
  let out = url;
  for (;;) {
    const last = out.slice(-1);
    if (/[.,;:!?]/.test(last)) out = out.slice(0, -1);
    else if (last === ')' && count(out, '(') < count(out, ')')) out = out.slice(0, -1);
    else if (last === ']' && count(out, '[') < count(out, ']')) out = out.slice(0, -1);
    else return out;
  }
}

/** What a phone's camera should open: "forms.gle/abc" → "https://forms.gle/abc". */
function scannable(url: string): string {
  return /^https?:\/\//i.test(url) ? url.replace(/^https?/i, (scheme) => scheme.toLowerCase()) : `https://${url}`;
}

/**
 * The line with its addresses (pushed onto `found`) taken out, or null when
 * nothing worth showing is left: no words at all, or only the short label the
 * link was the value of ("- 신청: https://…").
 */
function withoutLinks(line: string, found: string[]): string | null {
  const before = found.length;
  let text = line.replace(MARKDOWN_LINK, (match, label: string, url: string) => {
    if (!WHOLE_URL.test(url)) return match;
    found.push(trimTrailingPunctuation(url));
    return label;
  });
  text = text.replace(URL_PATTERN, (match: string, offset: number, whole: string) => {
    // A bare host glued to what precedes it belongs to something else, like an e-mail address.
    if (!/^(?:https?:|www\.)/i.test(match) && offset > 0 && /[\w@./-]/.test(whole[offset - 1])) return match;
    const url = trimTrailingPunctuation(match);
    found.push(url);
    return match.slice(url.length);
  });
  if (found.length === before) return line;

  text = text
    .replace(/\(\s*\)|\[\s*\]|<\s*>|（\s*）|「\s*」/g, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([,.!?])/g, '$1')
    .replace(TRAILING_JOINER, '')
    .trim();
  const words = text.replace(/^[-*•·●]\s*/, '');
  if (!/[\p{L}\p{N}]/u.test(words)) return null;
  if (TRAILING_LABEL_MARK.test(words) && words.split(/\s+/).length <= 3) return null;
  return text.replace(TRAILING_LABEL_MARK, '');
}

/** Take every web address out of an announcement's body lines. */
export function splitOutLinks(bodyLines: string[]): LinkSplit {
  const links: string[] = [];
  const kept: string[] = [];
  for (const line of bodyLines) {
    const found: string[] = [];
    const text = withoutLinks(line, found);
    for (const url of found.map(scannable)) {
      if (!links.includes(url)) links.push(url);
    }
    if (text !== null) kept.push(text);
  }
  return { bodyLines: kept, links };
}
