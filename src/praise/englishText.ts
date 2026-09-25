// Getting English into the slides by hand: one text box per Korean slide, or
// the whole song's English pasted at once and dealt out across the slides.
import type { PraiseLyricSlide } from './planner';

/** Textarea text → lines, dropping blank lines (the slide break is the box itself). */
export function linesFromText(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

/** Paragraphs separated by one or more blank lines. */
function stanzas(text: string): string[][] {
  return text
    .split(/\r?\n\s*\r?\n/)
    .map(linesFromText)
    .filter((stanza) => stanza.length > 0);
}

/**
 * Deal a whole song's pasted English out across its Korean slides.
 *
 * When the paste has one paragraph per slide (the usual way lyrics are
 * written out), paragraph N goes under slide N. Otherwise the lines are
 * shared out in order, each slide taking a share proportional to its number
 * of Korean lines — close enough to fix by hand, and never out of order.
 */
export function distributeEnglish(text: string, slides: PraiseLyricSlide[]): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  if (slides.length === 0) return result;
  const blocks = stanzas(text);
  if (blocks.length === slides.length) {
    slides.forEach((slide, index) => {
      result[slide.key] = blocks[index];
    });
    return result;
  }

  const all = blocks.flat();
  const weights = slides.map((slide) => Math.max(1, slide.lines.length));
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  let consumed = 0;
  let cumulative = 0;
  slides.forEach((slide, index) => {
    cumulative += weights[index];
    const end = index === slides.length - 1 ? all.length : Math.round((cumulative / total) * all.length);
    result[slide.key] = all.slice(consumed, Math.max(consumed, end));
    consumed = Math.max(consumed, end);
  });
  return result;
}
