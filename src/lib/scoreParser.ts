// Turns the raw OCR text of a scanned 악보 (sheet-music) page into a draft song:
// title, musical key, play order, and lyric sections. Everything here is a pure,
// deterministic function of the OCR string so it can be unit-tested without a
// browser or the OCR engine. Scanned scores are noisy, so this is best-effort:
// the order line at the top and any printed part labels are the strongest
// signals; the result is always meant to be reviewed against the score image.
import type { Section } from './types';
import { normalizeToken, parseOrder } from './orderParser';

export interface ParsedScore {
  title?: string;
  key?: string;
  /** Normalized play-order tokens, e.g. ["I","V1","V2","PC","C","C"] */
  order: string[];
  sections: Section[];
}

/** A bare canonical part token like I, V1, PC, C2, B, O, T. */
const PART_TOKEN = /^(I|V\d*|PC\d*|C\d*|B\d*|O\d*|T\d*)$/i;

/** Korean/English words scores use to label a part. */
const PART_WORD: Record<string, string> = {
  '1절': 'V1',
  '2절': 'V2',
  '3절': 'V3',
  '4절': 'V4',
  절: 'V1',
  후렴: 'C',
  후렴구: 'C',
  브릿지: 'B',
  간주: 'I',
  전주: 'I',
  벌스: 'V1',
  버스: 'V1',
  verse: 'V1',
  chorus: 'C',
  bridge: 'B',
  prechorus: 'PC',
  intro: 'I',
};

function hangulCount(s: string): number {
  return (s.match(/[가-힣]/g) ?? []).length;
}

/** OCR routinely reads a leading "I" as l, |, 1 or i — repair standalone tokens. */
function normalizeOrderOcr(line: string): string {
  return line
    .split(/([-–—~→,/\s]+)/)
    .map((tok) => (/^[lI1|i]$/.test(tok) ? 'I' : tok))
    .join('');
}

/** Strip surrounding brackets/punctuation and return the canonical part label, or null. */
function toPartLabel(raw: string): string | null {
  const t = raw
    .trim()
    .replace(/^[([{<]+/, '')
    .replace(/[)\]}>.:]+$/, '')
    .trim();
  if (!t) return null;
  if (PART_TOKEN.test(t)) return normalizeToken(t);
  const word = PART_WORD[t.toLowerCase()] ?? PART_WORD[t];
  return word ?? null;
}

const SEPARATORS = /[-–—~→,/\s]+/;

/** True when a line reads as a play-order sequence (I-V1-V2-PC-C-C). */
function looksLikeOrderLine(line: string): boolean {
  const parts = line.split(SEPARATORS).filter(Boolean);
  if (parts.length < 2) return false;
  const known = parts.filter((p) => toPartLabel(p) !== null).length;
  return known >= 2 && known >= Math.ceil(parts.length * 0.6);
}

/** Pull a trailing/standalone musical key like "E", "(F#m)", "Bb". */
function extractKey(line: string): string | undefined {
  const m = line.match(/[([]?\s*([A-G](?:#|♯|b|♭)?m?)\s*[)\]]?\s*$/);
  if (!m) return undefined;
  // Avoid mistaking a lone lyric character; require it to be a plausible key token.
  const key = m[1].replace('♯', '#').replace('♭', 'b');
  return key;
}

/** Unique parts (excluding intro) in first-appearance order. */
function uniqueParts(order: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of order) {
    if (t === 'I') continue;
    if (!seen.has(t)) {
      seen.add(t);
      out.push(t);
    }
  }
  return out;
}

/**
 * Split lyric lines into sections using any inline part labels the OCR picked up
 * (e.g. a line that is just "V1" or "후렴"). Returns null when no labels are found.
 */
function sectionsFromLabels(lyricLines: string[]): Section[] | null {
  const sections: Section[] = [];
  let current: Section | null = null;
  let sawLabel = false;

  for (const line of lyricLines) {
    const label = toPartLabel(line);
    if (label) {
      sawLabel = true;
      if (label === 'I') {
        current = null; // intro/간주 carries no lyrics
        continue;
      }
      current = { label, lines: [] };
      sections.push(current);
      continue;
    }
    if (current) current.lines.push(line);
  }

  if (!sawLabel) return null;
  return sections.filter((s) => s.lines.length > 0);
}

/**
 * Parse OCR text of a single score page into a draft song. Best-effort:
 * - order comes from the top order line (per KCCP scores, usually starts with I),
 * - title/key from the heading above it,
 * - sections from printed part labels when present, otherwise a scaffold of the
 *   parts named in the order, with the recognized lyric text seeded into it.
 */
export function parseScoreText(text: string): ParsedScore {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  // 1) Order line — scan the first several lines for an order-like sequence.
  let order: string[] = [];
  let orderIdx = -1;
  for (let i = 0; i < Math.min(lines.length, 8); i++) {
    const repaired = normalizeOrderOcr(lines[i]);
    if (looksLikeOrderLine(repaired)) {
      order = parseOrder(repaired);
      orderIdx = i;
      break;
    }
  }

  // 2) Title + key — the most Hangul-heavy heading line above the order line.
  const headEnd = orderIdx >= 0 ? orderIdx : Math.min(lines.length, 3);
  let title: string | undefined;
  let key: string | undefined;
  let titleIdx = -1;
  let bestHangul = 0;
  for (let i = 0; i < headEnd; i++) {
    const line = lines[i];
    if (toPartLabel(line)) continue;
    const h = hangulCount(line);
    if (h > bestHangul) {
      bestHangul = h;
      titleIdx = i;
    }
  }
  if (titleIdx >= 0) {
    const line = lines[titleIdx];
    key = extractKey(line);
    // Drop a trailing "(E)" / key so it doesn't bleed into the title.
    title = line
      .replace(/[([]?\s*[A-G](?:#|♯|b|♭)?m?\s*[)\]]?\s*$/, '')
      .replace(/[:\-–—]\s*$/, '')
      .trim();
    if (!title) title = undefined;
  }

  // 3) Sections. Consider only the lines after the heading/order as lyric body.
  const bodyStart = Math.max(orderIdx, titleIdx) + 1;
  const body = lines.slice(bodyStart >= 0 ? bodyStart : 0);
  const lyricLines = body.filter((l) => hangulCount(l) >= 2);

  let sections = sectionsFromLabels(body);

  if (!sections || sections.length === 0) {
    // No printed labels: scaffold the parts named in the order and seed the
    // recognized lyric text into the first one for the user to redistribute
    // while looking at the score.
    const parts = uniqueParts(order);
    const labels = parts.length > 0 ? parts : ['V1', 'C'];
    sections = labels.map((label, i) => ({
      label,
      lines: i === 0 ? lyricLines : [],
    }));
  }

  return { title, key, order, sections };
}
