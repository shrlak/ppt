// Matching for the administrator-managed excluded-title list (공동체 고백송,
// 예배 전 준비 찬양 등): songs whose recognized title matches an entry are
// dropped from 찬양 편집 instead of becoming lyric cards.
import { normalizeTitle } from '../storage/library';

/**
 * True when `title` matches one of the excluded entries. Matching is
 * normalized (case/spacing/punctuation-insensitive): a title matches when it
 * equals or CONTAINS an excluded entry, so "공동체 고백송" also catches
 * "공동체 고백송 - 주만 바라볼지라". The reverse direction is deliberately
 * not matched — a short ordinary title must not disappear just because it
 * happens to be a fragment of a longer excluded entry. Entries shorter than
 * 2 normalized characters are ignored to avoid accidental matches.
 */
export function isExcludedTitle(title: string, excludedTitles: string[]): boolean {
  const want = normalizeTitle(title);
  if (want.length < 2) return false;
  return excludedTitles.some((entry) => {
    const excluded = normalizeTitle(entry);
    return excluded.length >= 2 && want.includes(excluded);
  });
}
