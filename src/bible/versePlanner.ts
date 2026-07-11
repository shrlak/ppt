// Turns parsed BibleRef entries + loaded translations into the flat slide-data
// list consumed by pptxBuilder.ts. Ported from kccp-bible-slide's
// src/app/api/generate/route.ts (steps 1-3 of the POST handler).
import { getVerseRange } from './bibleData';
import type { BibleRef, BookChapters, Verse, VerseSlideData } from './types';

function formatRange(ko: string, en: string, first: Verse, last: Verse) {
  if (first.chapter === last.chapter && first.verse === last.verse) {
    return { rangeKo: `${ko} ${first.chapter}:${first.verse}`, rangeEn: `${en} ${first.chapter}:${first.verse}` };
  }
  if (first.chapter === last.chapter) {
    return {
      rangeKo: `${ko} ${first.chapter}:${first.verse}-${last.verse}`,
      rangeEn: `${en} ${first.chapter}:${first.verse}-${last.verse}`,
    };
  }
  return {
    rangeKo: `${ko} ${first.chapter}:${first.verse}-${last.chapter}:${last.verse}`,
    rangeEn: `${en} ${first.chapter}:${first.verse}-${last.chapter}:${last.verse}`,
  };
}

export interface VerseSlidePlan {
  globalData: VerseSlideData;
  verseSlides: VerseSlideData[];
}

/**
 * Build the slide-data plan for a set of refs.
 * @param translations ordered list of translation ids; translations[0] drives which verses exist (chapter/verse bounds)
 * @param bibles loaded translation data, keyed by translation id (see bibleData.loadTranslation)
 */
export function buildVerseSlidePlan(
  refs: BibleRef[],
  translations: string[],
  bibles: Map<string, Map<number, BookChapters>>,
  sermonTitle: string,
  versesPerSlide: number,
): VerseSlidePlan {
  if (refs.length === 0) throw new Error('구절을 파싱할 수 없습니다.');
  const primary = bibles.get(translations[0]);
  if (!primary) throw new Error('기준 번역본을 불러오지 못했습니다.');

  const allVerses: Verse[] = [];
  for (const ref of refs) {
    allVerses.push(...getVerseRange(primary, ref.bookId, ref.startChapter, ref.startVerse, ref.endChapter, ref.endVerse));
  }
  if (allVerses.length === 0) throw new Error('해당 구절을 찾을 수 없습니다.');

  const first = refs[0];
  const globalFirst = allVerses[0];
  const globalLast = allVerses[allVerses.length - 1];
  const { rangeKo, rangeEn } = formatRange(first.ko, first.en, globalFirst, globalLast);

  const verseSlides: VerseSlideData[] = [];
  const perSlide = Math.max(1, versesPerSlide);
  for (const ref of refs) {
    const verses = getVerseRange(primary, ref.bookId, ref.startChapter, ref.startVerse, ref.endChapter, ref.endVerse);
    for (let i = 0; i < verses.length; i += perSlide) {
      const group = verses.slice(i, i + perSlide);
      if (group.length === 0) continue;
      const f = group[0];
      const l = group[group.length - 1];
      const verseLabel = group.length === 1 ? String(f.verse) : `${f.verse}-${l.verse}`;
      const slide: VerseSlideData = {
        title: ref.ko,
        etitle: ref.en,
        chapter: String(f.chapter),
        verse: verseLabel,
        rangeKo,
        rangeEn,
        body: group.map((v) => v.text).join(' '),
        body1: group.map((v) => v.text).join(' '),
        // The template's verse slide always has {{BODY2}}/{{BODY3}} slots for a
        // 2nd/3rd translation; default them to '' so deselecting a translation
        // clears the placeholder instead of leaving it literal on the slide.
        body2: '',
        body3: '',
      };
      for (let t = 1; t < translations.length; t++) {
        const other = bibles.get(translations[t]);
        if (!other) continue;
        const otherVerses = getVerseRange(other, ref.bookId, f.chapter, f.verse, l.chapter, l.verse);
        slide[`body${t + 1}`] = otherVerses.map((v) => v.text).join(' ');
      }
      verseSlides.push(slide);
    }
  }
  if (verseSlides.length === 0) throw new Error('생성할 슬라이드가 없습니다.');

  const globalData: VerseSlideData = {
    title: first.ko,
    etitle: first.en,
    rangeKo,
    rangeEn,
    sermonTitle: sermonTitle || '',
  };

  return { globalData, verseSlides };
}
