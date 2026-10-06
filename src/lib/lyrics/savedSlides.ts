// A 찬양집회 deck is saved slide by slide: every slide it projected comes
// back as a part named by its number — 1, 2, 3… — so the English under it
// returns exactly as projected (see praise/englishLibrary.ts). That keeps a
// song's words but not its parts: which lines are the verse and which the
// chorus, and the 진행 that repeats them. A song saved that way is read again
// from its 악보 for its parts, and its saved words are still the best reading
// of those parts when the web has no page to give.
import type { Section } from '../utils/types';
import { partSimilarity } from './mergeWebLyrics';
import { lineKey } from './textSimilarity';

/**
 * How alike a part read off the 악보 and a stretch of the saved lyrics must
 * be, as character-pair overlap, for the saved words to be that part's.
 * Stricter than a web page's match: the saved stretches all come from the
 * same song, so a part the deck never projected still shares a good many
 * pairs with some stretch of it.
 */
const SAME_WORDS_THRESHOLD = 0.4;

/** True when a song's only parts are its saved slides, numbered 1, 2, 3… */
export function hasSlideNumberParts(sections: Pick<Section, 'label'>[]): boolean {
  return sections.length > 0 && sections.every((section) => /^\d+$/.test(section.label.trim()));
}

interface Stretch {
  part: number;
  start: number;
  end: number;
  score: number;
}

/**
 * Every run of saved lines about as long as `part` — half to twice its
 * letters, so the 악보 may break its lines anywhere — that reads like it.
 */
function stretchesFor(part: Section, index: number, saved: string[]): Stretch[] {
  const wanted = part.lines.map(lineKey).join('').length;
  if (wanted === 0) return [];
  const found: Stretch[] = [];
  for (let start = 0; start < saved.length; start++) {
    let length = 0;
    for (let end = start + 1; end <= saved.length; end++) {
      length += lineKey(saved[end - 1]).length;
      if (length > wanted * 2 + 4) break;
      if (length * 2 + 4 < wanted) continue;
      const score = partSimilarity(part, { label: '', lines: saved.slice(start, end) });
      if (score >= SAME_WORDS_THRESHOLD) found.push({ part: index, start, end, score });
    }
  }
  return found;
}

/**
 * Lay a song's saved words over the parts read off its 악보. Each part takes
 * the stretch of the saved lyrics that reads most like it — the saved words,
 * in the saved line breaks — and keeps its own label. The closest pairs are
 * settled first and no two parts share a line, so two verses that read
 * alike cannot both take the same one. A part the saved lyrics have nothing
 * like (a verse the deck never projected) keeps its own reading. `matched`
 * counts the parts that took saved words.
 */
export function savedWordsInParts(parts: Section[], saved: Section[]): { sections: Section[]; matched: number } {
  const lines = saved.flatMap((section) => section.lines.map((line) => line.trim()).filter(Boolean));
  const candidates = parts
    .flatMap((part, index) => stretchesFor(part, index, lines))
    // Best first; between equals, the earlier part and the earlier stretch.
    .sort((a, b) => b.score - a.score || a.part - b.part || a.start - b.start);
  const chosen = new Map<number, Stretch>();
  const taken = new Set<number>();
  for (const candidate of candidates) {
    if (chosen.has(candidate.part)) continue;
    let free = true;
    for (let line = candidate.start; line < candidate.end && free; line++) free = !taken.has(line);
    if (!free) continue;
    chosen.set(candidate.part, candidate);
    for (let line = candidate.start; line < candidate.end; line++) taken.add(line);
  }
  const sections = parts.map((part, index) => {
    const stretch = chosen.get(index);
    return { label: part.label, lines: stretch ? lines.slice(stretch.start, stretch.end) : [...part.lines] };
  });
  return { sections, matched: chosen.size };
}
