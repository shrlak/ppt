// Builds the 수요예배 말씀 본문 slides.
//
// The Sunday deck puts one 개역개정 verse group into a {{BODY}} placeholder as
// a single run (see bible/pptxBuilder.ts). The Wednesday design is different:
// each verse is its own paragraph, prefixed with its verse number, with an
// empty paragraph between verses for air. So this clones the template's two
// prototype paragraphs — one verse, one spacer — rather than substituting a
// string, and shrinks the font when a group runs long.
import { fitBodyFontSize } from '../lib/pptx/textFit';
import { lastVerseOf } from '../bible/bibleData';
import type { Verse } from '../bible/types';
import { substituteTokens, xmlEscape } from './fields';
import { WEDNESDAY_TOKENS } from './template';

/** The slide's own font size, and how far it may shrink to fit the box. */
const BASE_FONT_SZ = 3800;
const MIN_FONT_SZ = 2000;

const PARAGRAPH = /<a:p>[\s\S]*?<\/a:p>|<a:p\/>/g;

/** Split a passage into one group per slide. */
export function groupVerses(verses: Verse[], versesPerSlide: number): Verse[][] {
  const perSlide = Math.max(1, Math.floor(versesPerSlide) || 1);
  const groups: Verse[][] = [];
  for (let i = 0; i < verses.length; i += perSlide) {
    groups.push(verses.slice(i, i + perSlide));
  }
  return groups;
}

/** How one verse reads on the slide: "7 이에 땅이 진동하고…", or "18-19 여호와께서…" for a joined pair. */
export function verseLine(verse: Verse): string {
  const last = lastVerseOf(verse);
  const number = last === verse.verse ? `${verse.verse}` : `${verse.verse}-${last}`;
  return `${number} ${verse.text}`.trim();
}

function setParagraphText(paragraphXml: string, text: string): string {
  const open = paragraphXml.indexOf('<a:t>');
  const close = paragraphXml.indexOf('</a:t>', open);
  if (open === -1 || close === -1) {
    throw new Error('말씀 본문 템플릿에서 텍스트 요소를 찾지 못했습니다.');
  }
  return paragraphXml.slice(0, open + '<a:t>'.length) + xmlEscape(text) + paragraphXml.slice(close);
}

function withFontSize(paragraphXml: string, sz: number): string {
  return paragraphXml.replace(/\bsz="\d+"/g, `sz="${sz}"`);
}

/**
 * Fill one 말씀 본문 slide with a verse group.
 *
 * `templateSlideXml` is the template's 말씀 본문 slide, whose body shape holds
 * exactly two paragraphs: the verse prototype (carrying {{BODY}}) and the
 * empty spacer that follows it.
 */
export function buildWednesdayVerseSlide(
  templateSlideXml: string,
  verses: Verse[],
  rangeKo: string,
): string {
  if (verses.length === 0) throw new Error('말씀 본문 슬라이드에 넣을 절이 없습니다.');

  const shapes = [...templateSlideXml.matchAll(/<p:sp>[\s\S]*?<\/p:sp>/g)];
  const bodyShape = shapes.find((shape) => shape[0].includes(WEDNESDAY_TOKENS.body));
  if (!bodyShape) {
    throw new Error('말씀 본문 템플릿에서 본문 상자를 찾지 못했습니다.');
  }

  const paragraphs = [...bodyShape[0].matchAll(PARAGRAPH)];
  if (paragraphs.length === 0) {
    throw new Error('말씀 본문 템플릿에서 본문 문단을 찾지 못했습니다.');
  }
  const versePrototype = paragraphs[0][0];
  // Without a spacer prototype the verses still render, just tighter together.
  const spacerPrototype = paragraphs[1]?.[0] ?? '';

  const lines = verses.map(verseLine);
  // Each spacer takes a line's height too, so it counts toward the fit.
  const measured = lines.flatMap((line, index) => (index === 0 ? [line] : ['', line]));
  const sz = fitBodyFontSize(bodyShape[0], measured, BASE_FONT_SZ, MIN_FONT_SZ);

  const rebuilt = lines
    .map((line) => withFontSize(setParagraphText(versePrototype, line), sz))
    .join(spacerPrototype);

  const first = paragraphs[0].index!;
  const last = paragraphs[paragraphs.length - 1];
  const newBodyShape =
    bodyShape[0].slice(0, first) + rebuilt + bodyShape[0].slice(last.index! + last[0].length);

  const slideXml =
    templateSlideXml.slice(0, bodyShape.index!) +
    newBodyShape +
    templateSlideXml.slice(bodyShape.index! + bodyShape[0].length);

  return substituteTokens(slideXml, { RANGE_KO: rangeKo });
}
