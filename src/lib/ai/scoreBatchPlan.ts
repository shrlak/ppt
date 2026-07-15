import { findEntry } from '../storage/library';
import type { LibraryEntry } from '../utils/types';
import type { ParsedScore } from './scoreParser';

export interface ScoreBatchPlan {
  /** Saved entry for each page, aligned to the title-recognition results. */
  libraryMatches: (LibraryEntry | undefined)[];
  /** Only these page indexes still need the expensive full-lyrics pass. */
  lyricIndexes: number[];
}

/**
 * Decide which score pages can stop after title recognition. A recognized
 * title takes priority; the title already parsed from the conti is the fallback.
 */
export function planScoreBatch(
  identities: ParsedScore[],
  fallbackTitles: string[],
  library: LibraryEntry[],
): ScoreBatchPlan {
  const count = Math.max(identities.length, fallbackTitles.length);
  const libraryMatches: (LibraryEntry | undefined)[] = [];
  const lyricIndexes: number[] = [];

  for (let index = 0; index < count; index++) {
    const title = identities[index]?.title?.trim() || fallbackTitles[index]?.trim() || '';
    const match = title ? findEntry(library, title) : undefined;
    libraryMatches.push(match);
    if (!match) lyricIndexes.push(index);
  }

  return { libraryMatches, lyricIndexes };
}
