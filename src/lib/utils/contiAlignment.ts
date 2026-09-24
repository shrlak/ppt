// Put each song on the conti its own 악보 page.
//
// The cover lists the songs in the order they are sung, but a scanned score
// page has no text layer to match a title against — so matchSongsToPages can
// only hand the pages out in PDF order. That is right until it isn't: a score
// printed over two pages, or pages scanned in another order, shifts every song
// after it onto its neighbour's page. Once the models have read the title off
// each page, the pages can be paired back with the songs they belong to, and
// the cards keep the conti's order with the right score behind each one.
import { normalizeTitle } from '../storage/library';

/** How alike two titles must read to be the same song (0–1). */
export const SAME_TITLE_THRESHOLD = 0.6;

/** A placeholder the conti gave a page nobody has named yet. */
export function isPlaceholderTitle(title: string | undefined): boolean {
  const trimmed = title?.trim() ?? '';
  return !trimmed || /^새 찬양/.test(trimmed);
}

function pairs(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (let i = 0; i < text.length - 1; i += 1) {
    const pair = text.slice(i, i + 2);
    counts.set(pair, (counts.get(pair) ?? 0) + 1);
  }
  return counts;
}

/**
 * How alike two song titles read, ignoring spacing, case and punctuation.
 * One title containing the other ("시선" / "내게로부터 눈을 들어 (시선)")
 * counts as a strong match; otherwise character-pair overlap decides, which
 * forgives the odd misread syllable.
 */
export function titleSimilarity(a: string | undefined, b: string | undefined): number {
  const left = normalizeTitle(a ?? '');
  const right = normalizeTitle(b ?? '');
  if (!left || !right) return 0;
  if (left === right) return 1;
  if (Math.min(left.length, right.length) >= 2 && (left.includes(right) || right.includes(left))) return 0.9;
  const l = pairs(left);
  const r = pairs(right);
  let shared = 0;
  for (const [pair, count] of l) shared += Math.min(count, r.get(pair) ?? 0);
  const total = Math.max(1, left.length - 1 + right.length - 1);
  return (2 * shared) / total;
}

/**
 * Which page each song should take, given the titles read off the pages.
 *
 * `songTitles[i]` is the title the conti printed for the song currently on
 * page slot `i` (a placeholder for a page the cover never named), and
 * `pageTitles[i]` is the title the models read off that page. Returns
 * `slots` where song `i` should take page slot `slots[i]` — always a
 * permutation, so no page is dropped and none is shared.
 *
 * A song already on a page that reads as its title stays there. The rest are
 * paired best match first; a song nothing matches (or a placeholder) takes
 * whatever pages are left, in page order. When the titles say nothing, the
 * answer is the identity and the conti's pairing stands.
 */
export function alignPagesToConti(
  songTitles: string[],
  pageTitles: (string | undefined)[],
): number[] {
  const count = songTitles.length;
  const slots: (number | undefined)[] = new Array(count).fill(undefined);
  const taken = new Set<number>();
  const named = (i: number) => !isPlaceholderTitle(songTitles[i]);

  for (let i = 0; i < count; i += 1) {
    if (named(i) && titleSimilarity(songTitles[i], pageTitles[i]) >= SAME_TITLE_THRESHOLD) {
      slots[i] = i;
      taken.add(i);
    }
  }

  const candidates: { score: number; song: number; slot: number }[] = [];
  for (let song = 0; song < count; song += 1) {
    if (slots[song] !== undefined || !named(song)) continue;
    for (let slot = 0; slot < count; slot += 1) {
      if (taken.has(slot)) continue;
      const score = titleSimilarity(songTitles[song], pageTitles[slot]);
      if (score >= SAME_TITLE_THRESHOLD) candidates.push({ score, song, slot });
    }
  }
  candidates.sort((a, b) => b.score - a.score || a.slot - b.slot);
  for (const { song, slot } of candidates) {
    if (slots[song] !== undefined || taken.has(slot)) continue;
    slots[song] = slot;
    taken.add(slot);
  }

  // Unmatched songs keep their own page when it is still free, so a pairing
  // the titles cannot improve on is left exactly as the conti made it.
  for (let song = 0; song < count; song += 1) {
    if (slots[song] === undefined && !taken.has(song)) {
      slots[song] = song;
      taken.add(song);
    }
  }
  const free = [...Array(count).keys()].filter((slot) => !taken.has(slot));
  return slots.map((slot) => slot ?? (free.shift() as number));
}

/**
 * The title to look a song's lyrics up by on the web. The conti's printed
 * title is text out of the PDF, not a reading of pixels, so it wins; the
 * title read off the 악보 only stands in for a page the cover never named.
 */
export function lyricsLookupTitle(printed: string | undefined, recognized: string | undefined): string {
  if (!isPlaceholderTitle(printed)) return (printed as string).trim();
  return recognized?.trim() || printed?.trim() || '';
}
