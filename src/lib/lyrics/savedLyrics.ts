// Saved lyrics that are not organized by part. Two kinds reach the 찬양
// 라이브러리:
//
//   · Slide by slide — a 찬양집회 or 수련회 deck is saved as the slides it
//     projected, each a part named by its number (1, 2, 3…), so they come
//     back exactly as projected (see praise/englishLibrary.ts).
//   · In one block — a web page read before its stanza breaks were kept was
//     auto-saved as a draft holding the whole song as one part.
//
// Either keeps a song's words but not its parts: which lines are the verse
// and which the chorus, and the 진행 that repeats them. Such a song is read
// again from its 악보 for its parts when the conti has it, and its saved words
// are still the best reading of those parts when the web has no page to give.
// Without a 악보, the lyrics are organized by what they show themselves.
import type { LibraryEntry, Section } from '../utils/types';
import { isGroundTruth } from '../storage/library';
import { partSimilarity } from './mergeWebLyrics';
import { parsePartHeading, structureScrapedSong } from './lyricsStructure';
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

/**
 * Lines a song saved as a single part may hold and still be that one part.
 * Past two slides' worth it is the whole song in one block (the limit
 * structureScrapedSong also keeps a block whole to).
 */
const ONE_PART_LINES = 8;

/**
 * True when a saved song's lyrics are not organized by part: saved slide by
 * slide (1, 2, 3…), or — a draft nobody confirmed — the whole song in one
 * block. A song somebody saved as one part is taken at their word.
 */
export function lacksParts(entry: Pick<LibraryEntry, 'sections' | 'verification'>): boolean {
  if (hasSlideNumberParts(entry.sections)) return true;
  if (entry.sections.length !== 1 || isGroundTruth(entry as LibraryEntry)) return false;
  return entry.sections[0].lines.filter((line) => line.trim()).length > ONE_PART_LINES;
}

/**
 * Saved lyrics organized by what they show themselves: the part headings
 * they carry (`후렴`, `[Bridge]`), or the lines they print again — the chorus,
 * with the lines that always lead into it as the pre-chorus and the
 * stretches between as verses or the bridge (see structureScrapedSong). The
 * chorus is kept once and the order sings it again. Saved slides are read as
 * stanzas. Null when the lyrics show neither: then nothing is guessed, and
 * they stay as saved.
 */
export function partsFromLyrics(sections: Section[]): { sections: Section[]; order: string[] } | null {
  const lines = sections.flatMap((section, index) => [...(index > 0 ? [''] : []), ...section.lines]);
  const headed = lines.some((line) => parsePartHeading(line.trim()) !== null);
  const song = structureScrapedSong(lines);
  const sung = song.order.filter((token) => token !== 'I');
  const repeated = new Set(sung).size < sung.length;
  if ((!headed && !repeated) || song.sections.length < 2) return null;
  return song;
}

/**
 * A saved song as it loads: organized by part when it was saved without
 * parts and its lyrics show them (see partsFromLyrics), else as saved.
 */
export function organizeSavedEntry<T extends Pick<LibraryEntry, 'sections' | 'order' | 'verification'>>(entry: T): T {
  if (!lacksParts(entry)) return entry;
  const parts = partsFromLyrics(entry.sections);
  return parts ? { ...entry, sections: parts.sections, order: parts.order } : entry;
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
