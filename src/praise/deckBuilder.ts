// Assembles the 찬양집회 deck out of public/praise-template.pptx.
//
// The template holds last year's six designs (see template.ts): every slide
// of the generated deck is one of them cloned and filled in, so the whole
// deck keeps that night's background photos, master and embedded Nanum
// Gothic fonts. The one exception is the poster, which last year's deck did
// not have: it is drawn on the template's blank layout (see poster.ts).
// 추가 자료 files (a sermon PPT, 말씀 slides, images, PDFs) are spliced in
// afterwards at the positions the plan gives them.
import JSZip from 'jszip';
import { assertPptxIntegrity } from '../lib/pptx/pptxPackage';
import { mergePptxDecks } from '../lib/pptx/pptxMerge';
import { readSlideSize, rescaleDeckToSize } from '../lib/pptx/slideGeometry';
import { removeContentTypeOverridesWhere, setContentTypeOverride, ensureDefaultExtension } from '../lib/pptx/contentTypes';
import { xmlEscape } from '../lib/pptx/pptxBuilder';
import { fitBodyFontSize, fitTitleFontSize, singleLineBody, withFontSize } from '../lib/pptx/textFit';
import type { AdditionalFile } from '../lib/additionalFiles/types';
import type { DeckOverviewItem } from '../lib/utils/deckOverview';
import type { Song } from '../lib/utils/types';
import { planPraiseDeck, topicsFontSize, type PlacedAdditional, type PraiseSlidePlan } from './planner';
import { buildPosterSlide } from './poster';
import {
  PRAISE_COVER_SHAPES,
  PRAISE_HEADER_BASE_SZ,
  PRAISE_HEADER_BOX,
  PRAISE_HEADER_MIN_SZ,
  PRAISE_LYRICS_BASE_SZ,
  PRAISE_LYRICS_BODY,
  PRAISE_LYRICS_MIN_SZ,
  PRAISE_PASSAGE_BASE_SZ,
  PRAISE_PASSAGE_BOX,
  PRAISE_PASSAGE_MIN_SZ,
  PRAISE_PRAYER_TITLE_BASE_SZ,
  PRAISE_PRAYER_TITLE_BOX,
  PRAISE_PRAYER_TITLE_MIN_SZ,
  PRAISE_SLIDES,
  PRAISE_TITLE_BASE_SZ,
  PRAISE_TITLE_BOX,
  PRAISE_TITLE_MIN_SZ,
  PRAISE_TOKENS,
  PRAISE_TOPICS_BODY,
  PRAISE_VERSE_BASE_SZ,
  PRAISE_VERSE_EN_BOX,
  PRAISE_VERSE_KO_BOX,
  PRAISE_VERSE_MIN_SZ,
  verseTextBox,
} from './template';
import type { PraiseCoverImage, PraisePoster, PraisePrayer, PraiseSongExtras, PraiseVerse } from './types';

const SLIDE_REL_TYPE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide';
const SLIDE_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.presentationml.slide+xml';
const IMAGE_REL_TYPE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image';
const LAYOUT_REL_TYPE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout';


export interface PraiseDeckInput {
  /** public/praise-template.pptx. */
  template: ArrayBuffer | Uint8Array;
  songs: Song[];
  extras: Record<string, PraiseSongExtras>;
  /** The night's 기도, put after the checked songs in order (see prayers.ts). */
  prayers?: PraisePrayer[];
  /** Event date, `YYYY-MM-DD`; printed on the cover as MM/DD/YYYY. */
  date: string;
  /** A new cover picture replaces last year's (and its date box) entirely. */
  coverImage?: PraiseCoverImage | null;
  /** The night's poster: the first slide, ahead of the cover, when it is switched on and has something on it. */
  poster?: PraisePoster | null;
  additionalFiles?: AdditionalFile[];
  placements?: PlacedAdditional[];
  /**
   * Turns a non-PPTX 추가 자료 file into slides. Injected because rendering a
   * PDF or measuring an image needs the browser; tests pass a stub.
   */
  convertAdditional?: (file: AdditionalFile) => Promise<{ deck: Uint8Array; slideCount: number }>;
}

export interface PraiseDeckResult {
  deck: Uint8Array;
  overview: DeckOverviewItem[];
  warnings: string[];
}

/** "2026-09-26" → "09/26/2026", the way the cover prints it. */
export function formatCoverDate(date: string): string {
  const match = date.trim().match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (!match) return '';
  return `${match[2].padStart(2, '0')}/${match[3].padStart(2, '0')}/${match[1]}`;
}

/**
 * A conti's printed date ("9/26/26", "2026.9.26", "2026년 9월 26일") as the
 * date input's `YYYY-MM-DD`, or '' when it cannot be read.
 */
export function isoDateFromConti(value: string | undefined): string {
  const text = (value ?? '').trim();
  const yearFirst = text.match(/^(\d{4})\s*[./-]\s*(\d{1,2})\s*[./-]\s*(\d{1,2})/);
  const yearLast = text.match(/^(\d{1,2})\s*[./-]\s*(\d{1,2})\s*[./-]\s*(\d{4}|\d{2})\b/);
  const korean = text.match(/^(\d{4})\s*년\s*(\d{1,2})\s*월\s*(\d{1,2})\s*일?/);
  const parts = yearFirst
    ? [yearFirst[1], yearFirst[2], yearFirst[3]]
    : yearLast
      ? [yearLast[3].length === 2 ? `20${yearLast[3]}` : yearLast[3], yearLast[1], yearLast[2]]
      : korean
        ? [korean[1], korean[2], korean[3]]
        : null;
  if (!parts) return '';
  const [year, month, day] = parts.map(Number);
  const date = new Date(year, month - 1, day);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return '';
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * "2026-09-26" → "0926_PraiseNight.pptx". Kept to ASCII: Chromium drops a
 * download name with Hangul in it and saves the file as bare "download".
 */
export function suggestPraiseFileName(date: string, today = new Date()): string {
  const match = date.trim().match(/^\d{4}-(\d{1,2})-(\d{1,2})$/);
  const month = match ? match[1].padStart(2, '0') : String(today.getMonth() + 1).padStart(2, '0');
  const day = match ? match[2].padStart(2, '0') : String(today.getDate()).padStart(2, '0');
  return `${month}${day}_PraiseNight.pptx`;
}

// ---- slide XML --------------------------------------------------------------

const PARAGRAPH = /<a:p>[\s\S]*?<\/a:p>/g;

/** The whole `<a:p>` that holds `token`. */
function paragraphHolding(xml: string, token: string): { start: number; end: number; xml: string } {
  for (const match of xml.matchAll(PARAGRAPH)) {
    if (match[0].includes(token)) {
      return { start: match.index!, end: match.index! + match[0].length, xml: match[0] };
    }
  }
  throw new Error(`찬양집회 템플릿에서 ${token} 문단을 찾지 못했습니다.`);
}

/** The whole `<p:sp>` that holds `needle`. */
function shapeHolding(xml: string, needle: string): { start: number; end: number; xml: string } {
  for (const match of xml.matchAll(/<p:sp>[\s\S]*?<\/p:sp>/g)) {
    if (match[0].includes(needle)) {
      return { start: match.index!, end: match.index! + match[0].length, xml: match[0] };
    }
  }
  throw new Error(`찬양집회 템플릿에서 ${needle} 도형을 찾지 못했습니다.`);
}

function replaceToken(xml: string, token: string, value: string): string {
  return xml.split(token).join(xmlEscape(value));
}

/** One run of text in the lyric paragraph's formatting, at `sz`. */
function lyricParagraph(template: string, line: string, sz: number): string {
  // An empty spacer keeps the run (for its size) with no text in it.
  return replaceToken(template, PRAISE_TOKENS.line, line).replace(/\bsz="\d+"/g, `sz="${sz}"`);
}

export function buildCoverSlide(xml: string, date: string, customCover: boolean): string {
  if (customCover) {
    // A new cover picture carries its own date (or none); last year's mask
    // over the old date would only put a dark bar across it.
    let out = xml;
    for (const name of [PRAISE_COVER_SHAPES.dateMask, PRAISE_COVER_SHAPES.date]) {
      const shape = shapeHolding(out, `name="${name}"`);
      out = out.slice(0, shape.start) + out.slice(shape.end);
    }
    return out;
  }
  return replaceToken(xml, PRAISE_TOKENS.coverDate, formatCoverDate(date));
}

/** A shape moved sideways to `x` and made `cx` wide; its height and top stay. */
function withHorizontalBox(shapeXml: string, box: { x: number; cx: number }): string {
  return shapeXml.replace(
    /<a:off x="\d+" y="(\d+)"\/><a:ext cx="\d+" cy="(\d+)"\/>/,
    `<a:off x="${box.x}" y="$1"/><a:ext cx="${box.cx}" cy="$2"/>`,
  );
}

/** A shape put at `box` with its text anchored to the box's vertical middle. */
function centredIn(shapeXml: string, box: { x: number; y: number; cx: number; cy: number }): string {
  return shapeXml
    .replace(
      /<a:off x="\d+" y="\d+"\/><a:ext cx="\d+" cy="\d+"\/>/,
      `<a:off x="${box.x}" y="${box.y}"/><a:ext cx="${box.cx}" cy="${box.cy}"/>`,
    )
    .replace(/(<a:bodyPr\b[^>]*?)\s+anchor="[^"]*"/, '$1')
    .replace(/<a:bodyPr\b/, '<a:bodyPr anchor="ctr"');
}

/** Replace a span of `xml` with `value`. */
function splice(xml: string, span: { start: number; end: number }, value: string): string {
  return xml.slice(0, span.start) + value + xml.slice(span.end);
}

/**
 * The paragraph holding `token` in `shapeXml`, filled with `value` at the
 * largest size (up to `baseSz`) that keeps it on one line of that shape.
 */
function fillTitleParagraph(shapeXml: string, token: string, value: string, baseSz: number, minSz: number): string {
  const paragraph = paragraphHolding(shapeXml, token);
  const sz = fitTitleFontSize(shapeXml, value, baseSz, minSz);
  return splice(shapeXml, paragraph, withFontSize(replaceToken(paragraph.xml, token, value), sz));
}

/**
 * Korean title over English title, each on ONE line: a title never wraps —
 * it shrinks just enough to fit the (widened) box instead, the Korean and
 * the English each on its own, and the box is set not to wrap at all.
 */
export function buildTitleSlide(xml: string, titleKo: string, titleEn: string): string {
  const shape = shapeHolding(xml, PRAISE_TOKENS.titleKo);
  let box = singleLineBody(withHorizontalBox(shape.xml, PRAISE_TITLE_BOX));
  box = fillTitleParagraph(box, PRAISE_TOKENS.titleKo, titleKo, PRAISE_TITLE_BASE_SZ, PRAISE_TITLE_MIN_SZ);
  if (titleEn) {
    box = fillTitleParagraph(box, PRAISE_TOKENS.titleEn, titleEn, PRAISE_TITLE_BASE_SZ, PRAISE_TITLE_MIN_SZ);
  } else {
    // One title: drop the English line so the Korean stays centred on its own.
    box = splice(box, paragraphHolding(box, PRAISE_TOKENS.titleEn), '');
  }
  return splice(xml, shape, box);
}

/**
 * The corner label — "한글 | English" — on one line across the top of the
 * slide, then the lyrics: Korean lines, a blank line, then the English (last
 * year's layout) in a box centred on the slide, anchored to its middle, so
 * the lyrics always sit in the centre of the screen however many lines a
 * slide has. The font starts at the template's size and shrinks only when
 * the slide holds more than the box can show (the planner has already split
 * any slide that would need to shrink past readable), so nothing runs off
 * the screen.
 */
export function buildLyricsSlide(xml: string, header: string, lines: string[], english: string[]): string {
  const label = shapeHolding(xml, PRAISE_TOKENS.header);
  let labelXml = singleLineBody(withHorizontalBox(label.xml, PRAISE_HEADER_BOX));
  labelXml = fillTitleParagraph(labelXml, PRAISE_TOKENS.header, header, PRAISE_HEADER_BASE_SZ, PRAISE_HEADER_MIN_SZ);
  let out = splice(xml, label, labelXml);

  const body = shapeHolding(out, PRAISE_TOKENS.line);
  const bodyXml = centredIn(body.xml, PRAISE_LYRICS_BODY);
  const paragraph = paragraphHolding(bodyXml, PRAISE_TOKENS.line);
  const rendered = english.length > 0 && lines.length > 0 ? [...lines, '', ...english] : [...lines, ...english];
  const sz = fitBodyFontSize(bodyXml, rendered, PRAISE_LYRICS_BASE_SZ, PRAISE_LYRICS_MIN_SZ);
  const paragraphs = rendered.map((line) => lyricParagraph(paragraph.xml, line, sz)).join('');
  out = splice(out, body, splice(bodyXml, paragraph, paragraphs));
  return out;
}

/** A shape moved to `box` (its text keeps its own anchoring) and drawn at exactly that size. */
function placedAt(shapeXml: string, box: { x: number; y: number; cx: number; cy: number }): string {
  return shapeXml
    .replace(
      /<a:off x="\d+" y="\d+"\/><a:ext cx="\d+" cy="\d+"\/>/,
      `<a:off x="${box.x}" y="${box.y}"/><a:ext cx="${box.cx}" cy="${box.cy}"/>`,
    )
    .replace(/<a:spAutoFit\/>/g, '<a:noAutofit/>');
}

/** The paragraphs of a shape, in order. */
function paragraphsOf(shapeXml: string): { start: number; end: number; xml: string }[] {
  return [...shapeXml.matchAll(PARAGRAPH)].map((match) => ({
    start: match.index!,
    end: match.index! + match[0].length,
    xml: match[0],
  }));
}

/**
 * Two lines that belong together (Korean over English) at ONE size: the
 * largest at which each stays on a single line of the shape.
 */
function pairSize(shapeXml: string, lines: string[], baseSz: number, minSz: number): number {
  return Math.min(baseSz, ...lines.filter(Boolean).map((line) => fitTitleFontSize(shapeXml, line, baseSz, minSz)));
}

/**
 * 기도 / Prayer — or 통성기도 / Corporate Prayer, 축도 / Benediction… —
 * Korean over English in last year's 기도 design, both lines on one line
 * each at one size, in a box widened to the right so a longer title keeps
 * its size, its text centred on the box's height. A title with only one of
 * the two languages prints just that line.
 */
export function buildPrayerSlide(xml: string, ko: string, en: string): string {
  const shape = shapeHolding(xml, PRAISE_TOKENS.prayerKo);
  let box = singleLineBody(withHorizontalBox(shape.xml, PRAISE_PRAYER_TITLE_BOX))
    .replace(/(<a:bodyPr\b[^>]*?)\s+anchor="[^"]*"/, '$1')
    .replace(/<a:bodyPr\b/, '<a:bodyPr anchor="ctr"');
  const sz = pairSize(box, [ko, en], PRAISE_PRAYER_TITLE_BASE_SZ, PRAISE_PRAYER_TITLE_MIN_SZ);
  // Korean, the spacer between, English — from the bottom up, so each
  // splice leaves the earlier positions where they were.
  const [koPara, spacer, enPara] = paragraphsOf(box);
  if (en) box = splice(box, enPara, withFontSize(replaceToken(enPara.xml, PRAISE_TOKENS.prayerEn, en), sz));
  else box = splice(box, { start: spacer.start, end: enPara.end }, '');
  if (ko) box = splice(box, koPara, withFontSize(replaceToken(koPara.xml, PRAISE_TOKENS.prayerKo, ko), sz));
  else box = splice(box, { start: koPara.start, end: en ? spacer.end : koPara.end }, '');
  return splice(xml, shape, box);
}

/** "1. …", "2) …", "① …": a topic that brings its own number needs no bullet in front of it. */
function isNumbered(topic: string): boolean {
  return /^(\d+[.)]|[①-⑳])\s*/.test(topic);
}

/**
 * 기도제목: last year's heading ("기도제목 | Prayer Prompt", kept to one line)
 * over the topics, one bulleted paragraph
 * each, hung from the top of a box that runs down the slide; the topics
 * shrink together from 26pt only as far as they must to fit (the planner has
 * already moved the rest on to another slide).
 */
export function buildPrayerTopicsSlide(xml: string, heading: string, topics: string[]): string {
  const headingShape = shapeHolding(xml, PRAISE_TOKENS.prayerHeading);
  let headingXml = singleLineBody(
    withHorizontalBox(headingShape.xml, { x: PRAISE_TOPICS_BODY.x, cx: PRAISE_TOPICS_BODY.cx }),
  );
  headingXml = fillTitleParagraph(headingXml, PRAISE_TOKENS.prayerHeading, heading, 4400, 2400);
  let out = splice(xml, headingShape, headingXml);

  const body = shapeHolding(out, PRAISE_TOKENS.prayerTopic);
  const bodyXml = placedAt(body.xml, PRAISE_TOPICS_BODY);
  const paragraph = paragraphHolding(bodyXml, PRAISE_TOKENS.prayerTopic);
  const sz = topicsFontSize(topics);
  const paragraphs = topics
    .map((topic) => {
      let topicXml = withFontSize(replaceToken(paragraph.xml, PRAISE_TOKENS.prayerTopic, topic), sz).replace(
        /<a:buSzPts val="\d+"\/>/,
        `<a:buSzPts val="${sz}"/>`,
      );
      if (isNumbered(topic)) topicXml = topicXml.replace(/<a:buChar\b[^>]*\/>/, '<a:buNone/>');
      return topicXml;
    })
    .join('');
  out = splice(out, body, splice(bodyXml, paragraph, paragraphs));
  return out;
}

/** One verse half of the 말씀 slide: its reference, then its text, fitted to the half it has. */
function fillVerse(
  xml: string,
  tokens: { ref: string; text: string },
  box: { x: number; y: number; cx: number; cy: number },
  ref: string,
  text: string,
): string {
  const shape = shapeHolding(xml, tokens.text);
  let shapeXml = placedAt(shape.xml, box);
  const paragraph = paragraphHolding(shapeXml, tokens.text);
  const sz = fitBodyFontSize(verseTextBox(box), [text], PRAISE_VERSE_BASE_SZ, PRAISE_VERSE_MIN_SZ);
  shapeXml = splice(shapeXml, paragraph, withFontSize(replaceToken(paragraph.xml, tokens.text, text), sz));
  shapeXml = replaceToken(shapeXml, tokens.ref, ref);
  return splice(xml, shape, shapeXml);
}

/**
 * 말씀: last year's design — the passage in the corner ("사도행전 1장 3-5, 8절"
 * over "Acts 1:3-5, 8", one line each), then the verse in 개역개정 under its
 * reference and the same verse in English under its own. A long verse
 * shrinks within its half of the slide, so the two never run into each other.
 */
export function buildScriptureSlide(xml: string, passageKo: string, passageEn: string, verse: PraiseVerse): string {
  const header = shapeHolding(xml, PRAISE_TOKENS.passageKo);
  let headerXml = singleLineBody(withHorizontalBox(header.xml, PRAISE_PASSAGE_BOX));
  const sz = pairSize(headerXml, [passageKo, passageEn], PRAISE_PASSAGE_BASE_SZ, PRAISE_PASSAGE_MIN_SZ);
  headerXml = withFontSize(
    replaceToken(replaceToken(headerXml, PRAISE_TOKENS.passageKo, passageKo), PRAISE_TOKENS.passageEn, passageEn),
    sz,
  );
  let out = splice(xml, header, headerXml);
  out = fillVerse(out, { ref: PRAISE_TOKENS.verseRefKo, text: PRAISE_TOKENS.verseKo }, PRAISE_VERSE_KO_BOX, verse.refKo, verse.ko);
  out = fillVerse(out, { ref: PRAISE_TOKENS.verseRefEn, text: PRAISE_TOKENS.verseEn }, PRAISE_VERSE_EN_BOX, verse.refEn, verse.en);
  return out;
}

// ---- package ---------------------------------------------------------------

interface TemplateSlide {
  xml: string;
  rels: string;
}

async function readTemplateSlide(zip: JSZip, position: number): Promise<TemplateSlide> {
  const xml = await zip.file(`ppt/slides/slide${position}.xml`)?.async('string');
  const rels = await zip.file(`ppt/slides/_rels/slide${position}.xml.rels`)?.async('string');
  if (!xml || !rels) throw new Error(`찬양집회 템플릿에 ${position}번 슬라이드가 없습니다.`);
  return { xml, rels };
}

/**
 * The layout the poster is drawn on: the template's blank one (no title or
 * body placeholders to show through), else whatever layout the cover uses.
 */
async function posterLayoutTarget(zip: JSZip, coverRels: string): Promise<string> {
  const layouts = Object.keys(zip.files)
    .filter((path) => /^ppt\/slideLayouts\/slideLayout\d+\.xml$/.test(path))
    .sort((a, b) => Number(a.match(/(\d+)\.xml$/)![1]) - Number(b.match(/(\d+)\.xml$/)![1]));
  for (const path of layouts) {
    const xml = await zip.file(path)!.async('string');
    if (/<p:sldLayout\b[^>]*\btype="blank"/.test(xml)) return `../slideLayouts/${path.split('/').pop()}`;
  }
  const cover = coverRels.match(new RegExp(`<Relationship[^>]*Type="${LAYOUT_REL_TYPE}"[^>]*Target="([^"]*)"`));
  const target = cover?.[1] ?? coverRels.match(/Target="(\.\.\/slideLayouts\/[^"]*)"/)?.[1];
  if (!target) throw new Error('찬양집회 템플릿에서 포스터에 쓸 레이아웃을 찾지 못했습니다.');
  return target;
}

/** The poster slide's relationships: its layout, and its picture when it has one. */
function posterRels(layoutTarget: string, imageTarget: string | null): string {
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    `<Relationship Id="rId1" Type="${LAYOUT_REL_TYPE}" Target="${layoutTarget}"/>` +
    (imageTarget ? `<Relationship Id="rId2" Type="${IMAGE_REL_TYPE}" Target="${imageTarget}"/>` : '') +
    '</Relationships>'
  );
}

/** Cover, songs and 기도 slides as one package — everything but 추가 자료. */
async function buildBaseDeck(
  input: PraiseDeckInput,
  plans: Exclude<PraiseSlidePlan, { kind: 'additional' }>[],
  compression: 'STORE' | 'DEFLATE',
): Promise<Uint8Array> {
  const zip = await JSZip.loadAsync(input.template);
  const [cover, title, lyrics, prayer, topics, scripture] = await Promise.all([
    readTemplateSlide(zip, PRAISE_SLIDES.cover),
    readTemplateSlide(zip, PRAISE_SLIDES.songTitle),
    readTemplateSlide(zip, PRAISE_SLIDES.lyrics),
    readTemplateSlide(zip, PRAISE_SLIDES.prayer),
    readTemplateSlide(zip, PRAISE_SLIDES.prayerTopics),
    readTemplateSlide(zip, PRAISE_SLIDES.scripture),
  ]);
  let presentation = await zip.file('ppt/presentation.xml')!.async('string');
  let presRels = await zip.file('ppt/_rels/presentation.xml.rels')!.async('string');
  let contentTypes = await zip.file('[Content_Types].xml')!.async('string');

  for (const path of Object.keys(zip.files)) {
    if (/^ppt\/slides\//.test(path)) zip.remove(path);
  }

  let coverRels = cover.rels;
  const customCover = Boolean(input.coverImage);
  if (input.coverImage) {
    const extension = input.coverImage.mimeType === 'image/png' ? 'png' : 'jpeg';
    const mediaPath = `ppt/media/praise-cover.${extension}`;
    zip.file(mediaPath, new Uint8Array(input.coverImage.data.slice(0)));
    contentTypes = ensureDefaultExtension(contentTypes, extension, input.coverImage.mimeType);
    // The cover's background is its one image relationship.
    coverRels = coverRels.replace(
      new RegExp(`(<Relationship[^>]*Type="${IMAGE_REL_TYPE}"[^>]*Target=")[^"]*(")`),
      `$1../media/praise-cover.${extension}$2`,
    );
  }

  let posterSlide: TemplateSlide | null = null;
  if (input.poster && plans.some((plan) => plan.kind === 'poster')) {
    let imageTarget: string | null = null;
    if (input.poster.image) {
      const extension = input.poster.image.mimeType === 'image/png' ? 'png' : 'jpeg';
      zip.file(`ppt/media/praise-poster.${extension}`, new Uint8Array(input.poster.image.data.slice(0)));
      contentTypes = ensureDefaultExtension(contentTypes, extension, input.poster.image.mimeType);
      imageTarget = `../media/praise-poster.${extension}`;
    }
    posterSlide = {
      xml: buildPosterSlide(input.poster, 'rId2'),
      rels: posterRels(await posterLayoutTarget(zip, cover.rels), imageTarget),
    };
  }

  plans.forEach((plan, index) => {
    const n = index + 1;
    let xml: string;
    let rels: string;
    switch (plan.kind) {
      case 'poster':
        xml = posterSlide!.xml;
        rels = posterSlide!.rels;
        break;
      case 'cover':
        xml = buildCoverSlide(cover.xml, input.date, customCover);
        rels = coverRels;
        break;
      case 'title':
        xml = buildTitleSlide(title.xml, plan.titleKo, plan.titleEn);
        rels = title.rels;
        break;
      case 'lyrics':
        xml = buildLyricsSlide(lyrics.xml, plan.header, plan.lines, plan.english);
        rels = lyrics.rels;
        break;
      case 'prayer-topics':
        xml = buildPrayerTopicsSlide(topics.xml, plan.heading, plan.topics);
        rels = topics.rels;
        break;
      case 'scripture':
        xml = buildScriptureSlide(scripture.xml, plan.passageKo, plan.passageEn, plan.verse);
        rels = scripture.rels;
        break;
      case 'prayer':
      default:
        xml = buildPrayerSlide(prayer.xml, plan.ko, plan.en);
        rels = prayer.rels;
        break;
    }
    zip.file(`ppt/slides/slide${n}.xml`, xml);
    zip.file(`ppt/slides/_rels/slide${n}.xml.rels`, rels);
  });

  presentation = presentation.replace(
    /<p:sldIdLst>[\s\S]*?<\/p:sldIdLst>/,
    `<p:sldIdLst>${plans.map((_, index) => `<p:sldId id="${256 + index}" r:id="rId${2001 + index}"/>`).join('')}</p:sldIdLst>`,
  );
  presRels = presRels
    .replace(new RegExp(`<Relationship [^>]*Type="${SLIDE_REL_TYPE}"[^>]*/>`, 'g'), '')
    .replace(
      '</Relationships>',
      `${plans
        .map((_, index) => `<Relationship Id="rId${2001 + index}" Type="${SLIDE_REL_TYPE}" Target="slides/slide${index + 1}.xml"/>`)
        .join('')}</Relationships>`,
    );
  contentTypes = removeContentTypeOverridesWhere(contentTypes, (partName) => /^\/ppt\/slides\//.test(partName));
  plans.forEach((_, index) => {
    contentTypes = setContentTypeOverride(contentTypes, `ppt/slides/slide${index + 1}.xml`, SLIDE_CONTENT_TYPE);
  });

  zip.file('ppt/presentation.xml', presentation);
  zip.file('ppt/_rels/presentation.xml.rels', presRels);
  zip.file('[Content_Types].xml', contentTypes);
  return zip.generateAsync({ type: 'uint8array', compression });
}

function overviewRow(plan: PraiseSlidePlan, index: number, songs: Song[]): DeckOverviewItem {
  const id = `praise-${plan.kind}-${index}`;
  switch (plan.kind) {
    case 'poster':
      return { id, kind: 'front', label: '포스터' };
    case 'cover':
      return { id, kind: 'front', label: '표지' };
    case 'title':
      return {
        id,
        kind: 'lyrics-title',
        label: plan.titleKo || '(제목 없음)',
        subtitle: plan.titleEn || undefined,
        songId: plan.songId,
      };
    case 'lyrics':
      return {
        id,
        kind: 'lyrics',
        label: songs.find((song) => song.id === plan.songId)?.title || '(제목 없음)',
        subtitle: [plan.lines[0], plan.english[0]].filter(Boolean).join(' / ') || undefined,
        songId: plan.songId,
      };
    case 'prayer':
      return {
        id,
        kind: 'prayer',
        label: [plan.ko, plan.en].filter(Boolean).join(' / '),
        subtitle: `기도 ${plan.prayerNumber}`,
      };
    case 'prayer-topics':
      return {
        id,
        kind: 'prayer',
        label: plan.heading || '기도제목',
        subtitle: [`기도 ${plan.prayerNumber}`, plan.topics[0]].join(' · '),
      };
    case 'scripture':
      return {
        id,
        kind: 'bible',
        label: plan.verse.refKo,
        subtitle: `기도 ${plan.prayerNumber} · ${plan.verse.refEn}`,
      };
    default:
      return { id, kind: 'additional', label: '추가 자료' };
  }
}

export async function buildPraiseDeck(input: PraiseDeckInput): Promise<PraiseDeckResult> {
  const files = input.additionalFiles ?? [];
  const placements = (input.placements ?? []).filter((item) => files.some((file) => file.id === item.fileId));
  // A file with no placement recorded goes at the end, like the Sunday deck's 추가 자료.
  for (const file of files) {
    if (!placements.some((item) => item.fileId === file.id)) placements.push({ fileId: file.id, placement: 'end' });
  }
  const plans = planPraiseDeck(input.songs, input.extras, placements, input.prayers ?? [], input.poster ?? null);
  const base = plans.filter((plan): plan is Exclude<PraiseSlidePlan, { kind: 'additional' }> => plan.kind !== 'additional');
  const inserts = plans.flatMap((plan, index) =>
    plan.kind === 'additional'
      ? [{ fileId: plan.fileId, at: plans.slice(0, index).filter((p) => p.kind !== 'additional').length }]
      : [],
  );

  let deck = await buildBaseDeck(input, base, inserts.length > 0 ? 'STORE' : 'DEFLATE');
  const size = await readSlideSize(deck);
  const warnings: string[] = [];
  const slideCounts = new Map<string, number>();

  // Back to front: each insertion leaves the earlier insertion points where
  // the base deck put them, and files sharing a point keep their order.
  for (let index = inserts.length - 1; index >= 0; index--) {
    const { fileId, at } = inserts[index];
    const file = files.find((candidate) => candidate.id === fileId)!;
    let converted: { deck: Uint8Array; slideCount: number };
    if (file.kind === 'pptx') {
      const rescaled = await rescaleDeckToSize(file.data, size, 'STORE');
      if (rescaled.rescaled) {
        warnings.push(`'${file.name}'은(는) 슬라이드 크기가 달라 찬양집회 PPT 크기(4:3)에 맞게 줄였습니다.`);
      }
      converted = { deck: rescaled.data, slideCount: file.slideCount };
    } else if (input.convertAdditional) {
      converted = await input.convertAdditional(file);
    } else {
      throw new Error(`'${file.name}'을(를) 슬라이드로 바꿀 수 없습니다.`);
    }
    slideCounts.set(fileId, converted.slideCount);
    deck = await mergePptxDecks(deck, converted.deck, {
      insertAt: at,
      compression: index === 0 ? 'DEFLATE' : 'STORE',
    });
  }

  await assertPptxIntegrity(deck);

  const overview: DeckOverviewItem[] = [];
  plans.forEach((plan, index) => {
    if (plan.kind !== 'additional') {
      overview.push(overviewRow(plan, index, input.songs));
      return;
    }
    const file = files.find((candidate) => candidate.id === plan.fileId)!;
    const count = slideCounts.get(plan.fileId) ?? file.slideCount;
    for (let slide = 0; slide < count; slide++) {
      overview.push({ id: `praise-additional-${file.id}-${slide}`, kind: 'additional', label: file.name, subtitle: `${slide + 1}/${count}` });
    }
  });

  return { deck, overview, warnings };
}
