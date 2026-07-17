// Turns the raw OCR text of a scanned 악보 (sheet-music) page into a draft song:
// title, musical key, play order, and lyric sections. Everything here is a pure,
// deterministic function of the OCR string so it can be unit-tested without a
// browser or the OCR engine. Scanned scores are noisy, so this is best-effort:
// the order line at the top and any printed part labels are the strongest
// signals; the result is always meant to be reviewed against the score image.
import type { Section } from '../utils/types';
import { normalizeToken, parseOrder } from '../utils/orderParser';

export interface ParsedScore {
  /** Visual page classification performed before lyric extraction. */
  pageType?: 'score' | 'non_score';
  /** Sermon title read from a page without sheet music. */
  sermonTitle?: string;
  /** Scripture reference (본문) read from a page without sheet music. */
  scripture?: string;
  title?: string;
  key?: string;
  /** Normalized play-order tokens, e.g. ["I","V1","V2","PC","C","C"] */
  order: string[];
  sections: Section[];
}

/** Batch recognition depth: quick title/key identification, or full lyrics. */
export type BatchRecognitionMode = 'titles' | 'full';

interface SectionLike {
  label?: unknown;
  lines?: unknown;
}

/**
 * Coerce a model's parsed JSON payload into a ParsedScore, defensively. All
 * vision engines (Gemini, OpenRouter, Hugging Face) answer with the same shape,
 * so they share this one normalizer: labels are canonicalized (후렴→C, …) to
 * line up with the order tokens the slide planner matches against, and lyric
 * lines get their note-split hyphens joined back into words.
 */
export function coerceParsedScore(payload: unknown): ParsedScore {
  const obj = (payload ?? {}) as Record<string, unknown>;

  const rawPageType = typeof obj.pageType === 'string' ? obj.pageType.trim().toLowerCase() : '';
  const pageType =
    rawPageType === 'score' || rawPageType === 'music' || rawPageType === 'music_score'
      ? 'score'
      : rawPageType === 'non_score' || rawPageType === 'non-score' || rawPageType === 'info'
        ? 'non_score'
        : undefined;
  const sermonTitle =
    typeof obj.sermonTitle === 'string' && obj.sermonTitle.trim() ? obj.sermonTitle.trim() : undefined;
  const scripture =
    typeof obj.scripture === 'string' && obj.scripture.trim() ? obj.scripture.trim() : undefined;
  const title = typeof obj.title === 'string' && obj.title.trim() ? obj.title.trim() : undefined;
  const key = typeof obj.key === 'string' && obj.key.trim() ? obj.key.trim() : undefined;

  const orderTokens = Array.isArray(obj.order) ? obj.order.filter((t): t is string => typeof t === 'string') : [];
  const order = parseOrder(orderTokens.join('-'));

  const rawSections = Array.isArray(obj.sections) ? (obj.sections as SectionLike[]) : [];
  const sections: Section[] = [];
  for (const s of rawSections) {
    const label = typeof s?.label === 'string' ? normalizeToken(s.label) : '';
    if (!label) continue;
    const lines = Array.isArray(s?.lines)
      ? s.lines
          .filter((l): l is string => typeof l === 'string')
          .map((l) => cleanLyricLine(l))
          .filter((l) => l.length > 0)
      : [];
    sections.push({ label, lines });
  }

  return { pageType, sermonTitle, scripture, title, key, order, sections };
}

/**
 * Normalize a possibly sparse/out-of-order batch response (`{results:[…]}`
 * with per-item imageIndex) back into image order. Missing images become
 * empty ParsedScores so the result stays aligned with the input.
 */
export function coerceParsedScoreBatch(
  payload: unknown,
  imageCount: number,
  mode: BatchRecognitionMode,
): ParsedScore[] {
  const obj = (payload ?? {}) as { results?: unknown };
  const raw = Array.isArray(obj.results) ? obj.results : Array.isArray(payload) ? payload : [];
  const results: ParsedScore[] = Array.from({ length: imageCount }, () => ({ order: [], sections: [] }));
  raw.forEach((item, position) => {
    if (!item || typeof item !== 'object') return;
    const record = item as Record<string, unknown>;
    const imageIndex = Number.isInteger(record.imageIndex) ? Number(record.imageIndex) : position;
    if (imageIndex < 0 || imageIndex >= imageCount) return;
    const score = coerceParsedScore(record);
    results[imageIndex] =
      mode === 'titles'
        ? {
            pageType: score.pageType,
            sermonTitle: score.sermonTitle,
            scripture: score.scripture,
            title: score.title,
            key: score.key,
            order: [],
            sections: [],
          }
        : score;
  });
  return results;
}

/**
 * Parse a model's text answer as JSON, salvaging the outermost object when
 * the model wrapped it in prose or a ```json code fence.
 */
export function parseModelJson(text: string, emptyMessage: string, unparsableMessage: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) throw new Error(emptyMessage);
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start === -1 || end <= start) throw new Error(unparsableMessage);
    return JSON.parse(trimmed.slice(start, end + 1));
  }
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

/**
 * Clean a lyric line so it reads naturally: scores split words across notes with
 * hyphens ("Ce-le-brate", "찬-양-해"), which should be joined back into whole
 * words. Collapses any hyphen (with or without surrounding spaces) that sits
 * between two non-space characters, then squeezes leftover double spaces.
 */
export function cleanLyricLine(line: string): string {
  return line
    // A lookahead keeps the right-hand character unconsumed, so chains of
    // single-syllable splits ("찬-양-해") all collapse in one pass.
    .replace(/(\S)[ \t]*[-–—][ \t]*(?=\S)/g, '$1')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
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

  // Join syllable hyphens so the lyrics read naturally.
  sections = sections.map((s) => ({
    label: s.label,
    lines: s.lines.map(cleanLyricLine).filter((l) => l.length > 0),
  }));

  return { title, key, order, sections };
}
