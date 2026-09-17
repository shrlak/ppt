// Picks a font size at which generated text fits the shape it is written
// into, by reading the shape's own extent, insets and line spacing out of its
// XML. Two builders need this — the 광고 item slides and the 수요예배 말씀
// 본문 slides — and both clone a template shape whose box is fixed, so the
// text has to shrink rather than the box grow.
//
// PowerPoint's own autofit is not an option: it is resolved at render time by
// the application, and a deck generated here may be projected from a viewer
// that never recalculates it.

const EMU_PER_POINT = 12700;

/** Approximate rendered width of a line in em units at 1em per full-width glyph. */
export function textWidthEm(line: string): number {
  let em = 0;
  for (const ch of line) {
    // Hangul/CJK glyphs are full-width (~1em); Latin letters, digits and
    // punctuation average a bit over half an em in the deck's fonts.
    em += /[ᄀ-ᇿ⺀-꓏가-힣豈-﫿＀-￯]/.test(ch) ? 1 : 0.55;
  }
  return em;
}

/** Fallback when the shape's box cannot be read: scale down by line count alone. */
export function shrinkForLineCount(
  baseSz: number,
  fitLines: number,
  actualLines: number,
  minSz: number,
): number {
  if (actualLines <= fitLines) return baseSz;
  return Math.max(minSz, Math.round((baseSz * fitLines) / actualLines / 100) * 100);
}

/**
 * Pick the largest font size (1/100 pt steps of 100) at which the body text —
 * including soft-wrapped long lines — fits the shape. Reads the shape's
 * extent, insets and line spacing from its own XML so it tracks the template.
 */
export function fitBodyFontSize(
  bodyShapeXml: string,
  lines: string[],
  baseSz: number,
  minSz: number,
): number {
  const ext = bodyShapeXml.match(/<a:ext cx="(\d+)" cy="(\d+)"\/>/);
  if (!ext) return shrinkForLineCount(baseSz, 5, lines.length, minSz);

  const bodyPr = bodyShapeXml.match(/<a:bodyPr\b[^>]*/)?.[0] ?? '';
  const inset = (name: string, fallback: number) =>
    Number(bodyPr.match(new RegExp(`\\b${name}="(\\d+)"`))?.[1] ?? fallback);
  const widthPt = (Number(ext[1]) - inset('lIns', 91440) - inset('rIns', 91440)) / EMU_PER_POINT;
  const heightPt = (Number(ext[2]) - inset('tIns', 45720) - inset('bIns', 45720)) / EMU_PER_POINT;
  const spacing = Number(bodyShapeXml.match(/<a:lnSpc><a:spcPct val="(\d+)"\/>/)?.[1] ?? 100000) / 100000;

  for (let sz = baseSz; sz >= minSz; sz -= 100) {
    const fontPt = sz / 100;
    // ~1.2 × font size is the single-line box PowerPoint spaces by spcPct.
    const lineHeightPt = fontPt * 1.2 * spacing;
    const emPerLine = Math.max(1, widthPt / fontPt);
    let wrappedLines = 0;
    for (const line of lines) {
      wrappedLines += Math.max(1, Math.ceil(textWidthEm(line) / emPerLine));
    }
    if (wrappedLines * lineHeightPt <= heightPt) return sz;
  }
  return minSz;
}
