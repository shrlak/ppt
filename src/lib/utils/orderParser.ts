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
