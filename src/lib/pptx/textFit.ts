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

// ---- song titles: one line, always ------------------------------------------
//
// A song title is never allowed to wrap onto a second line, on any slide of
// any deck. fitBodyFontSize above is happy to wrap a line when the box is
// tall enough for two, so titles are sized by width alone, against a
// deliberately generous estimate of how wide the title will draw — and the
// box is also told not to wrap at all, so even a font wider than the estimate
// can never push a word onto a second line.

/**
 * Width of a title in em, estimated on the wide side: bold Arial / Nanum
 * Gothic / Calibri capitals, lowercase and Hangul all come in under these,
 * so a title fitted with this never needs more room than it was given.
 */
export function titleWidthEm(text: string): number {
  let em = 0;
  for (const ch of text) {
    if (/[ᄀ-ᇿ⺀-꓏가-힣豈-﫿＀-￯]/.test(ch)) em += 1;
    else if (/\s/.test(ch)) em += 0.3;
    else if (/[A-Z]/.test(ch)) em += 0.74;
    else if (/[a-z0-9]/.test(ch)) em += 0.6;
    else if (/[.,:;'’|!ilI()[\]]/.test(ch)) em += 0.34;
    else em += 0.62;
  }
  return em * 1.04;
}

/** The inner width (pt) of a shape's text box: its extent less the left/right insets. */
function boxWidthPt(shapeXml: string): number | null {
  const ext = shapeXml.match(/<a:ext cx="(\d+)" cy="\d+"\/>/);
  if (!ext) return null;
  const bodyPr = shapeXml.match(/<a:bodyPr\b[^>]*/)?.[0] ?? '';
  const inset = (name: string) => Number(bodyPr.match(new RegExp(`\\b${name}="(\\d+)"`))?.[1] ?? 91440);
  return (Number(ext[1]) - inset('lIns') - inset('rIns')) / EMU_PER_POINT;
}

/**
 * The largest font size (1/100 pt, steps of 100, at most `baseSz`) at which
 * `text` fits the shape's width on ONE line. Never below `minSz`; a title so
 * long it would need less still stays on one line (see singleLineBody).
 */
export function fitTitleFontSize(shapeXml: string, text: string, baseSz: number, minSz: number): number {
  const widthPt = boxWidthPt(shapeXml);
  const em = titleWidthEm(text.trim());
  if (widthPt === null || em === 0) return baseSz;
  for (let sz = baseSz; sz >= minSz; sz -= 100) {
    if ((em * sz) / 100 <= widthPt) return sz;
  }
  return minSz;
}

/**
 * A text shape told never to wrap: `wrap="none"` on its body, and any
 * PowerPoint autofit that would re-flow or rescale it switched off. The
 * size fitTitleFontSize picked is then the size that is drawn.
 */
export function singleLineBody(shapeXml: string): string {
  return shapeXml
    .replace(/<a:bodyPr\b[^>]*?(\/?)>/, (tag, selfClosing: string) => {
      const open = tag.slice(0, tag.length - (selfClosing ? 2 : 1)).replace(/\s+wrap="[^"]*"/, '');
      return `${open} wrap="none"${selfClosing ? '/>' : '>'}`;
    })
    .replace(/<a:normAutofit\b[^>]*\/>|<a:spAutoFit\/>/g, '<a:noAutofit/>');
}

/** Every run size in one paragraph (or shape) set to `sz`. */
export function withFontSize(xml: string, sz: number): string {
  return xml.replace(/\bsz="\d+"/g, `sz="${sz}"`);
}
