// Prints the service date into the fixed front-slides deck. Its 2nd slide
// (welcome · Happy Lord's Day) signs off with 빛주사랑 대학청년부 and that
// Sunday's date, which otherwise has to be edited by hand every week.
//
// The date is found by content rather than by slide number: any paragraph of
// the deck whose whole text is a M/D/YYYY date. That way an administrator's
// own front deck (관리자 설정) gets its date rewritten too, as long as it
// prints the date on a line of its own; a deck with no such line goes out
// untouched.
//
// The bundled deck splits the date across several runs ("0" "7" "/" "12"
// "/2026"), so the paragraph is rewritten as one: the first run keeps its
// formatting and takes the whole date, and the rest of the runs are dropped.
import JSZip from 'jszip';
import { slideOrderOf } from './pptxSlices';

/** A line that is nothing but a date: "07/12/2026", "7/9/2023", "7/12/26". */
const DATE_LINE = /^\s*\d{1,2}\s*\/\s*\d{1,2}\s*\/\s*(?:\d{4}|\d{2})\s*$/;

/** 2026-07-12 → "07/12/2026", the way the front slide prints it. */
export function formatFrontSlideDate(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${month}/${day}/${date.getFullYear()}`;
}

/** `xml` with every date-only paragraph reading `text` instead. */
export function rewriteDateParagraphs(xml: string, text: string): string {
  return xml.replace(/<a:p>[\s\S]*?<\/a:p>/g, (paragraph) => {
    // A field or a line break means the paragraph is more than a plain date.
    if (/<a:fld\b|<a:br\b/.test(paragraph)) return paragraph;
    const runs = [...paragraph.matchAll(/<a:r>[\s\S]*?<\/a:r>/g)];
    if (runs.length === 0) return paragraph;
    const current = runs.map((run) => run[0].match(/<a:t>([^<]*)<\/a:t>/)?.[1] ?? '').join('');
    if (!DATE_LINE.test(current) || current === text) return paragraph;
    const first = runs[0];
    const last = runs[runs.length - 1];
    const dated = first[0].includes('<a:t>')
      ? first[0].replace(/<a:t>[^<]*<\/a:t>/, `<a:t>${text}</a:t>`)
      : first[0].replace('</a:r>', `<a:t>${text}</a:t></a:r>`);
    return paragraph.slice(0, first.index!) + dated + paragraph.slice(last.index! + last[0].length);
  });
}

export interface FrontDateResult {
  /** The deck — rewritten when `applied`, byte-for-byte the original when not. */
  data: Uint8Array;
  applied: boolean;
}

/**
 * Print `date` on the front deck's date line(s).
 *
 * The deck comes back untouched when it has no date line, when it already
 * reads `date`, and when it is written in some way this cannot read — a front
 * deck the rewrite chokes on must still go out rather than fail the week's PPT.
 */
export async function applyFrontSlideDate(
  deck: ArrayBuffer | Uint8Array,
  date: Date,
): Promise<FrontDateResult> {
  const original = deck instanceof Uint8Array ? deck : new Uint8Array(deck);
  try {
    const text = formatFrontSlideDate(date);
    const zip = await JSZip.loadAsync(original);
    let applied = false;
    for (const name of await slideOrderOf(zip)) {
      const path = `ppt/slides/${name}`;
      const xml = await zip.file(path)?.async('string');
      if (xml === undefined) continue;
      const rewritten = rewriteDateParagraphs(xml, text);
      if (rewritten === xml) continue;
      zip.file(path, rewritten);
      applied = true;
    }
    if (!applied) return { data: original, applied: false };
    // Merging re-zips the deck anyway, so there is nothing to gain from deflating it here.
    return { data: await zip.generateAsync({ type: 'uint8array', compression: 'STORE' }), applied: true };
  } catch {
    return { data: original, applied: false };
  }
}
