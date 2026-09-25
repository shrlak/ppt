import { findLibrarySong } from '../storage/library';
import type { LibraryEntry } from '../utils/types';
import type { ParsedScore } from './scoreParser';

export interface ScoreBatchPlan {
  /**
   * The saved entry that ANSWERS the page, aligned to the title-recognition
   * results. Recognition stops for these pages: the saved lyrics are loaded
   * instead of reading the 악보.
   */
  libraryMatches: (LibraryEntry | undefined)[];
}

/** A placeholder title the conti gave a page nobody has named yet. */
function isStubTitle(title: string): boolean {
  return !title || /^새 찬양/.test(title);
}

/**
 * Decide, from the titles alone, which pages 찬양 라이브러리 already answers.
 *
 * The quick title pass is there to avoid reading a song the app already knows:
 * once a page's title is in the library, reading it for lyrics would spend
 * time and a request to learn what is already saved. So a title the library
 * holds ends the page here, and the lyrics pass never sees it.
 *
 * - The title the CONTI printed is checked first. It is text out of the PDF,
 *   not a reading of pixels. A `새 찬양 (p.3)` placeholder names nothing and
 *   never matches anything.
 * - Otherwise the title the models READ off the 악보 is looked up.
 *
 * Titles must be exactly equal once spacing, case and punctuation are ignored,
 * and known artists must agree (see findLibrarySong).
 */
export function planScoreBatch(
  identities: ParsedScore[],
  fallbackTitles: string[],
  library: LibraryEntry[],
): ScoreBatchPlan {
  const count = Math.max(identities.length, fallbackTitles.length);
  const libraryMatches: (LibraryEntry | undefined)[] = [];

  for (let index = 0; index < count; index++) {
    const recognized = identities[index]?.title?.trim() ?? '';
    const printed = fallbackTitles[index]?.trim() ?? '';
    const artist = identities[index]?.artist?.trim();
    const byPrinted = isStubTitle(printed) ? undefined : findLibrarySong(library, { title: printed });
    const byRecognized = recognized ? findLibrarySong(library, { title: recognized, artist }) : undefined;
    libraryMatches.push(byPrinted ?? byRecognized);
  }

  return { libraryMatches };
}
