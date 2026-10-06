// English the conti prints itself. A 찬양집회 conti may give a song's 악보
// twice — once in Korean, once in English — and the English page is read
// along with the Korean one (scorePages.ts) and handed here, to go under the
// Korean slides in the English lyrics step.
//
// Both pages were read with the same part labels, so each Korean part first
// takes the English part of the same name (V ← V, C ← C, B ← B); failing
// that, the part its length fits, as for English found on the web printed on
// its own (englishWeb.ts). It is this song's own English, so when neither
// fits it still goes in — in order, slide by slide — as a draft to check
// rather than being left out. Only slides with no English yet are filled.
import type { Song } from '../lib/utils/types';
import type { ScoreEnglish } from '../lib/utils/scorePages';
import { alignEnglishByLabels, alignEnglishOnly, type WebEnglishBlock } from './englishWeb';
import { distributeEnglish } from './englishText';
import { hasHangul, planPraiseSong } from './planner';
import type { PraiseEnglish } from './types';

export interface ScoreEnglishFill {
  english: PraiseEnglish;
  /** Korean slides that gained English. */
  filled: number;
  titleFilled: boolean;
  /** Laid in order only — neither the part names nor the lengths placed it. */
  guessed: boolean;
}

/** The English page's parts, as one text to read or paste: each part a paragraph. */
export function scoreEnglishText(page: ScoreEnglish): string {
  return page.sections
    .map((section) => section.lines.filter((line) => line.trim()).join('\n'))
    .filter(Boolean)
    .join('\n\n');
}

export function englishFromScore(song: Song, english: PraiseEnglish, page: ScoreEnglish): ScoreEnglishFill {
  const next: PraiseEnglish = { title: english.title, slides: { ...english.slides } };
  let titleFilled = false;
  const pageTitle = page.title?.trim();
  if (!next.title.trim() && pageTitle && !hasHangul(pageTitle)) {
    next.title = pageTitle;
    titleFilled = true;
  }
  const plan = planPraiseSong(song, { english: next });
  const stanzas = page.sections.map((section) => section.lines.filter((line) => line.trim())).filter((lines) => lines.length > 0);
  if (plan.englishOnly || plan.slides.length === 0 || stanzas.length === 0) {
    return { english: next, filled: 0, titleFilled, guessed: false };
  }

  const blocks: WebEnglishBlock[] = page.sections
    .filter((section) => section.lines.some((line) => line.trim()))
    .map((section) => ({ lang: 'en', lines: section.lines.filter((line) => line.trim()), label: section.label }));
  let aligned = alignEnglishByLabels(song, blocks) ?? alignEnglishOnly(song, stanzas);
  const guessed = !aligned;
  aligned ??= distributeEnglish(scoreEnglishText(page), plan.slides);

  let filled = 0;
  for (const slide of plan.slides) {
    if (slide.english.length > 0 || !aligned[slide.key]?.length) continue;
    next.slides[slide.key] = aligned[slide.key];
    filled += 1;
  }
  return { english: next, filled, titleFilled, guessed: guessed && filled > 0 };
}
