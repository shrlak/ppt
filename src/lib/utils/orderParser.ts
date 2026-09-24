// Parses user-entered song play orders like "I-V1-V2-PC-Cx2, 간주 C"
// into normalized token arrays like ["I","V1","V2","PC","C","C","I","C"].

/** Korean words / synonyms that map to canonical section tokens. Keys are compared after uppercasing. */
const SYNONYMS: Record<string, string> = {
  간주: 'I',
  전주: 'I',
  INTRO: 'I',
  INTERLUDE: 'I',
  INT: 'I',
  아웃트로: 'O',
  OUTRO: 'O',
  후렴: 'C',
  브릿지: 'B',
  BRIDGE: 'B',
};

/**
 * Normalize a single order token: trim, uppercase ASCII, and map Korean/
 * English synonyms (간주 → "I", 브릿지 → "B", …). Unknown tokens are kept
 * as-is (uppercased) — the slide planner decides what to skip.
 */
export function normalizeToken(raw: string): string {
  const up = raw.trim().toUpperCase();
  return SYNONYMS[up] ?? up;
}

/** Matches a standalone repeat marker like "x2" / "X2" / "*2" applying to the previous token. */
const STANDALONE_REPEAT = /^[xX*×](\d+)$/;
/** Matches a token with an attached repeat multiplier like "Cx2" / "C*2" / "CX2". */
const SUFFIX_REPEAT = /^(.+?)[xX*×](\d+)$/;

/**
 * Parse a free-form order string into normalized tokens.
 * Splits on -, –, —, ~, →, comma, slash and whitespace; expands repeat
 * multipliers ("Cx2" → C C; a standalone "x2" repeats the previous token).
 */
export function parseOrder(input: string): string[] {
  const parts = input.split(/[-–—~→,/\s]+/);
  const out: string[] = [];
  for (const part of parts) {
    if (!part) continue;

    const standalone = STANDALONE_REPEAT.exec(part);
    if (standalone) {
      const n = parseInt(standalone[1], 10);
      const last = out[out.length - 1];
      if (last !== undefined) {
        for (let k = 1; k < n; k++) out.push(last);
      }
      continue;
    }

    const suffixed = SUFFIX_REPEAT.exec(part);
    if (suffixed) {
      const token = normalizeToken(suffixed[1]);
      const n = Math.max(1, parseInt(suffixed[2], 10));
      if (token) {
        for (let k = 0; k < n; k++) out.push(token);
      }
      continue;
    }

    const token = normalizeToken(part);
    if (token) out.push(token);
  }
  return out;
}

/** Format a token array back into the canonical dash-separated string. */
export function formatOrder(order: string[]): string {
  return order.join('-');
}

/** One part token as a conti writes it: V1, PC, C, B, I, 간주, 후렴, Cx2… */
const PART_TOKEN = String.raw`(?:PC\d?|TAG|V\d?|C\d?|B\d?|I|O|T|간주|전주|후렴|브릿지)(?:\s*[xX×*]\s*\d)?`;
/**
 * A 진행 순서 inside running text: three or more part tokens joined by dashes
 * or arrows. Requiring the joiners (and at least three tokens) is what keeps
 * ordinary prose — "C 코드로", "B 파트" — from reading as an order.
 */
const ORDER_RUN = new RegExp(
  String.raw`(?<![0-9A-Za-z가-힣])(${PART_TOKEN}(?:\s*[-–—~→]\s*${PART_TOKEN}){2,})(?![0-9A-Za-z가-힣])`,
  'i',
);

/**
 * Find the 진행 순서 a conti wrote for a song, anywhere in a line of text —
 * "주님의 사랑 (E): I-V1-C-V2-C-B-C 로 부릅니다" gives
 * ["I","V1","C","V2","C","B","C"]. Undefined when the text carries none.
 */
export function extractPartOrder(text: string | undefined): string[] | undefined {
  if (!text) return undefined;
  const match = ORDER_RUN.exec(text);
  if (!match) return undefined;
  const order = parseOrder(match[1]);
  return order.length >= 3 ? order : undefined;
}
