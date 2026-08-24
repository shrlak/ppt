import { findReusableEntry } from '../storage/library';
import type { LibraryEntry } from '../utils/types';
import type { ParsedScore } from './scoreParser';
import { TITLE_REVIEW_THRESHOLD } from './weightedConsensus';

export interface ScoreBatchPlan {
  /**
   * The saved entry that ANSWERS the page, aligned to the title-recognition
   * results. Recognition stops for these pages: the saved lyrics are loaded
   * instead of reading the 악보.
   */
  libraryMatches: (LibraryEntry | undefined)[];
  /**
   * The saved entry a page MIGHT be, when the title behind the match is not
   * settled. These pages still go through the lyrics pass, and the saved copy
   * is used only where the page turns out to say the same thing.
   */
  libraryCandidates: (LibraryEntry | undefined)[];
}

/** A placeholder title the conti gave a page nobody has named yet. */
function isStubTitle(title: string): boolean {
  return !title || /^새 찬양/.test(title);
}

/**
 * Decide, from the titles alone, which pages the library can already answer.
 *
 * The quick title pass is there to avoid reading a song the app already knows:
 * once the 악보's title is settled and the library holds that exact title,
 * reading the page for lyrics spends a request to learn what is already saved.
 * So a settled match ends the page here, and the lyrics pass never sees it.
 *
 * "Settled" is the whole safeguard, because the saved lyrics are no longer
 * checked against the page:
 * - a title READ off the 악보 counts once the models agree on it
 *   (TITLE_REVIEW_THRESHOLD — the same bar the app uses elsewhere for a title
 *   nobody needs to look at). Models reading different titles is exactly the
 *   case where loading the library copy would put the wrong song on screen, so
 *   that page becomes a candidate instead and is confirmed against its lyrics.
 * - a title the CONTI printed counts as it is. It is text out of the PDF, not
 *   a reading of pixels, and the rest of the pipeline already treats it as
 *   ground truth. A `새 찬양 (p.3)` placeholder names nothing and never
 *   matches anything.
 *
 * Underneath, findReusableEntry still requires the titles to be exactly equal
 * once spacing, case and punctuation are ignored, any known artists to agree,
 * and the entry to be one somebody confirmed — a draft is a machine's guess,
 * and reusing one would make a single bad reading permanent.
 */
export function planScoreBatch(
  identities: ParsedScore[],
  fallbackTitles: string[],
  library: LibraryEntry[],
  /** Per-page agreement on the recognized title (0–1), from the title pass. */
  titleConfidence: number[] = [],
): ScoreBatchPlan {
  const count = Math.max(identities.length, fallbackTitles.length);
  const libraryMatches: (LibraryEntry | undefined)[] = [];
  const libraryCandidates: (LibraryEntry | undefined)[] = [];

  for (let index = 0; index < count; index++) {
    const recognized = identities[index]?.title?.trim() ?? '';
    const printed = fallbackTitles[index]?.trim() ?? '';
    const title = recognized || printed;
    const artist = identities[index]?.artist?.trim();
    const entry = title ? findReusableEntry(library, { title, artist }) : undefined;
    const settled = recognized
      ? (titleConfidence[index] ?? 0) >= TITLE_REVIEW_THRESHOLD
      : !isStubTitle(printed);
    libraryMatches.push(entry && settled ? entry : undefined);
    libraryCandidates.push(entry && !settled ? entry : undefined);
  }

  return { libraryMatches, libraryCandidates };
}
