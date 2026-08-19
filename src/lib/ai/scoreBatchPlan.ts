import { findReusableEntry } from '../storage/library';
import type { LibraryEntry } from '../utils/types';
import type { ParsedScore } from './scoreParser';

export interface ScoreBatchPlan {
  /**
   * The saved entry each page MIGHT be, aligned to the title-recognition
   * results. A candidate only becomes the page's lyrics once the full pass has
   * read the page and found the same words there.
   */
  libraryCandidates: (LibraryEntry | undefined)[];
}

/**
 * Pair each score page with the saved entry that could stand in for it. A
 * recognized title takes priority; the title already parsed from the conti is
 * the fallback.
 *
 * A candidate never ends a page here. Titles agreeing is not the same as the
 * page carrying those lyrics — two songs share a name, a title is misread, a
 * conti lists last week's arrangement — so every page still goes through the
 * lyrics pass, and the saved copy is used only where the two readings match.
 *
 * Only a saved entry somebody confirmed can be a candidate at all: reusing a
 * draft would make one unchecked reading permanent.
 */
export function planScoreBatch(
  identities: ParsedScore[],
  fallbackTitles: string[],
  library: LibraryEntry[],
): ScoreBatchPlan {
  const count = Math.max(identities.length, fallbackTitles.length);
  const libraryCandidates: (LibraryEntry | undefined)[] = [];

  for (let index = 0; index < count; index++) {
    const title = identities[index]?.title?.trim() || fallbackTitles[index]?.trim() || '';
    const artist = identities[index]?.artist?.trim();
    libraryCandidates.push(title ? findReusableEntry(library, { title, artist }) : undefined);
  }

  return { libraryCandidates };
}
