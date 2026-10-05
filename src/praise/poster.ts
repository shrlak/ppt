// The poster slide: the 찬양집회 deck's very first slide, ahead of the 표지,
// when the night has one.
//
// Unlike every other slide of the deck it is not cloned from last year's
// template — that deck had no poster — but drawn here, on the template's
// BLANK layout: a solid background, the poster picture as an ordinary
// picture, and its words as one ordinary text box. Nothing is baked into a
// background image, so the picture can still be moved, resized or swapped
// and the words retyped in PowerPoint.
//
// posterLayout() is the one answer to where everything goes and how large
// the words are: the slide is built from it, and so is the page's live
// preview of the poster.
import { containRect } from '../lib/pptx/imageDeckBuilder';
import { xmlEscape } from '../lib/pptx/pptxBuilder';
import { fitTitleFontSize } from '../lib/pptx/textFit';
import { PRAISE_SLIDE_SIZE } from './template';
import { DEFAULT_POSTER_BACKGROUND, DEFAULT_POSTER_TEXT_COLOR, type PraisePoster } from './types';

export interface PosterRect {
  x: number;
  y: number;
  cx: number;
  cy: number;
}

export type PosterLineRole = 'title' | 'subtitle' | 'detail';

export interface PosterParagraph {
  role: PosterLineRole;
  text: string;
  /** 1/100 pt. */
  sz: number;
  /** Space above the line, 1/100 pt. */
  spaceBefore: number;
}

export interface PosterLayout {
  /** `RRGGBB`. */
  background: string;
  /** Where the picture is drawn, in EMU; with `cover` it runs past the slide's edges. */
  picture: PosterRect | null;
  text: {
    box: PosterRect;
    /** `RRGGBB`. */
    color: string;
    /** Words over a picture get a soft shadow, so they read over any part of it. */
    shadow: boolean;
    paragraphs: PosterParagraph[];
  } | null;
}

/** The words' box: the slide less half an inch all round, the text centred in it. */
export const POSTER_TEXT_BOX: PosterRect = {
  x: 457200,
  y: 457200,
  cx: PRAISE_SLIDE_SIZE.cx - 2 * 457200,
  cy: PRAISE_SLIDE_SIZE.cy - 2 * 457200,
};
const TEXT_INSETS = { l: 91440, r: 91440, t: 45720, b: 45720 };
/** The box as fitTitleFontSize reads it. */
const POSTER_TEXT_BOX_XML =
  `<a:ext cx="${POSTER_TEXT_BOX.cx}" cy="${POSTER_TEXT_BOX.cy}"/>` +
  `<a:bodyPr lIns="${TEXT_INSETS.l}" rIns="${TEXT_INSETS.r}" tIns="${TEXT_INSETS.t}" bIns="${TEXT_INSETS.b}"/>`;

/** Each line's largest and smallest size (1/100 pt): a line shrinks only to stay on one line. */
export const POSTER_SIZES: Record<PosterLineRole, { base: number; min: number }> = {
  title: { base: 6000, min: 2000 },
  subtitle: { base: 3200, min: 1400 },
  detail: { base: 2400, min: 1200 },
};
/** No line is drawn smaller than this, however many lines a poster has. */
const POSTER_FLOOR_SZ = 1000;

/** The fonts the deck already embeds (Nanum Gothic), so the poster looks the same on any projector PC. */
export const POSTER_FONTS: Record<PosterLineRole, { typeface: string; bold: boolean }> = {
  title: { typeface: 'NanumGothicExtraBold', bold: false },
  subtitle: { typeface: 'Nanum Gothic', bold: true },
  detail: { typeface: 'Nanum Gothic', bold: false },
};

const EMU_PER_POINT = 12700;

/** A colour as `RRGGBB`, or `fallback` when it is not one. */
export function posterColor(value: string | undefined, fallback: string): string {
  const hex = (value ?? '').trim().replace(/^#/, '');
  return /^[0-9A-Fa-f]{6}$/.test(hex) ? hex.toUpperCase() : fallback;
}

/** The detail lines as printed: one a line, blank lines left out. */
export function posterDetailLines(details: string): string[] {
  return details
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

/** True when the poster has something to show: a picture or any words. */
export function posterHasContent(poster: PraisePoster | null | undefined): boolean {
  if (!poster) return false;
  return Boolean(poster.image) || [poster.title, poster.subtitle, poster.details].some((text) => text.trim());
}

/** True when the deck opens with the poster: it is switched on and has something on it. */
export function posterInDeck(poster: PraisePoster | null | undefined): poster is PraisePoster {
  return Boolean(poster?.enabled) && posterHasContent(poster);
}

/** Where the picture goes: whole on the slide (`contain`) or filling it, edges past the slide (`cover`). */
export function posterPictureRect(width: number, height: number, fit: PraisePoster['fit']): PosterRect {
  const { cx: slideCx, cy: slideCy } = PRAISE_SLIDE_SIZE;
  if (fit === 'contain') return containRect(width, height, slideCx, slideCy);
  const scale = Math.max(slideCx / width, slideCy / height);
  const cx = Math.round(width * scale);
  const cy = Math.round(height * scale);
  return { x: Math.round((slideCx - cx) / 2), y: Math.round((slideCy - cy) / 2), cx, cy };
}

/** A line's height as drawn (single spacing), in pt. */
function lineHeightPt(sz: number): number {
  return (sz / 100) * 1.2;
}

/** Space above a line: a little under the subtitle, more before the details start. */
function spaceBefore(role: PosterLineRole, sz: number, previous: PosterLineRole | null): number {
  if (previous === null) return 0;
  if (role === 'subtitle') return Math.round((sz * 0.4) / 100) * 100;
  if (role === 'detail' && previous !== 'detail') return Math.round((sz * 1.2) / 100) * 100;
  return 0;
}

function paragraphsAt(lines: { role: PosterLineRole; text: string; sz: number }[]): PosterParagraph[] {
  return lines.map((line, index) => ({
    ...line,
    spaceBefore: spaceBefore(line.role, line.sz, index > 0 ? lines[index - 1].role : null),
  }));
}

function textHeightPt(paragraphs: PosterParagraph[]): number {
  return paragraphs.reduce((sum, paragraph) => sum + lineHeightPt(paragraph.sz) + paragraph.spaceBefore / 100, 0);
}

/**
 * The words, each line on ONE line at the largest size that fits the width
 * (the title from 60pt, the subtitle from 32pt, the details from 24pt — the
 * details all at one size), then all of them brought down together if the
 * lines would not fit the height.
 */
export function posterParagraphs(poster: Pick<PraisePoster, 'title' | 'subtitle' | 'details'>): PosterParagraph[] {
  const fit = (role: PosterLineRole, text: string) =>
    fitTitleFontSize(POSTER_TEXT_BOX_XML, text, POSTER_SIZES[role].base, POSTER_SIZES[role].min);
  const lines: { role: PosterLineRole; text: string; sz: number }[] = [];
  const title = poster.title.trim();
  const subtitle = poster.subtitle.trim();
  const details = posterDetailLines(poster.details);
  if (title) lines.push({ role: 'title', text: title, sz: fit('title', title) });
  if (subtitle) lines.push({ role: 'subtitle', text: subtitle, sz: fit('subtitle', subtitle) });
  if (details.length > 0) {
    const sz = Math.min(...details.map((line) => fit('detail', line)));
    for (const line of details) lines.push({ role: 'detail', text: line, sz });
  }
  let paragraphs = paragraphsAt(lines);
  const heightPt = (POSTER_TEXT_BOX.cy - TEXT_INSETS.t - TEXT_INSETS.b) / EMU_PER_POINT;
  const needed = textHeightPt(paragraphs);
  if (needed > heightPt) {
    const scale = heightPt / needed;
    paragraphs = paragraphsAt(
      lines.map((line) => ({ ...line, sz: Math.max(POSTER_FLOOR_SZ, Math.floor((line.sz * scale) / 100) * 100) })),
    );
  }
  return paragraphs;
}

export function posterLayout(poster: PraisePoster): PosterLayout {
  const image = poster.image;
  const picture = image && image.width > 0 && image.height > 0 ? posterPictureRect(image.width, image.height, poster.fit) : null;
  const paragraphs = posterParagraphs(poster);
  return {
    background: posterColor(poster.background, DEFAULT_POSTER_BACKGROUND),
    picture,
    text:
      paragraphs.length > 0
        ? {
            box: POSTER_TEXT_BOX,
            color: posterColor(poster.textColor, DEFAULT_POSTER_TEXT_COLOR),
            shadow: Boolean(picture),
            paragraphs,
          }
        : null,
  };
}

// ---- slide XML --------------------------------------------------------------

const SHADOW =
  '<a:effectLst><a:outerShdw blurRad="76200" dist="25400" dir="5400000" algn="ctr" rotWithShape="0">' +
  '<a:srgbClr val="000000"><a:alpha val="65000"/></a:srgbClr></a:outerShdw></a:effectLst>';

function xfrm(rect: PosterRect): string {
  return `<a:xfrm><a:off x="${rect.x}" y="${rect.y}"/><a:ext cx="${rect.cx}" cy="${rect.cy}"/></a:xfrm>`;
}

function paragraphXml(paragraph: PosterParagraph, color: string, shadow: boolean): string {
  const font = POSTER_FONTS[paragraph.role];
  const spacing = paragraph.spaceBefore > 0 ? `<a:spcBef><a:spcPts val="${paragraph.spaceBefore}"/></a:spcBef>` : '';
  return (
    `<a:p><a:pPr algn="ctr">${spacing}<a:buNone/></a:pPr><a:r>` +
    `<a:rPr lang="ko-KR" altLang="en-US" sz="${paragraph.sz}"${font.bold ? ' b="1"' : ''} dirty="0">` +
    `<a:solidFill><a:srgbClr val="${color}"/></a:solidFill>${shadow ? SHADOW : ''}` +
    `<a:latin typeface="${font.typeface}"/><a:ea typeface="${font.typeface}"/><a:cs typeface="${font.typeface}"/>` +
    `</a:rPr><a:t>${xmlEscape(paragraph.text)}</a:t></a:r></a:p>`
  );
}

/**
 * The poster slide. `imageRelId` is the slide's relationship to the picture
 * (the builder adds it beside the layout's); without a picture none is used.
 */
export function buildPosterSlide(poster: PraisePoster, imageRelId = 'rId2'): string {
  const layout = posterLayout(poster);
  const picture =
    layout.picture && poster.image
      ? '<p:pic><p:nvPicPr>' +
        `<p:cNvPr id="2" name="PraisePosterPicture" descr="${xmlEscape(poster.image.name)}"/>` +
        '<p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr>' +
        `<p:blipFill><a:blip r:embed="${imageRelId}"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>` +
        `<p:spPr>${xfrm(layout.picture)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>`
      : '';
  const text = layout.text
    ? '<p:sp><p:nvSpPr><p:cNvPr id="3" name="PraisePosterText"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>' +
      `<p:spPr>${xfrm(layout.text.box)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr>` +
      `<p:txBody><a:bodyPr wrap="none" lIns="${TEXT_INSETS.l}" tIns="${TEXT_INSETS.t}" rIns="${TEXT_INSETS.r}" bIns="${TEXT_INSETS.b}" anchor="ctr" anchorCtr="0">` +
      '<a:noAutofit/></a:bodyPr><a:lstStyle/>' +
      layout.text.paragraphs.map((paragraph) => paragraphXml(paragraph, layout.text!.color, layout.text!.shadow)).join('') +
      '</p:txBody></p:sp>'
    : '';
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
    'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">' +
    `<p:cSld name="Poster"><p:bg><p:bgPr><a:solidFill><a:srgbClr val="${layout.background}"/></a:solidFill><a:effectLst/></p:bgPr></p:bg>` +
    '<p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>' +
    '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>' +
    picture +
    text +
    '</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>'
  );
}
