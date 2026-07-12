// Parses a pasted block of announcement text (numbered items in the form
// "1. <title>\n...body...") into slides, cloning the announcement-item
// slide design from the weekly service template (see pptxSlices.ts for how
// that slide is located). Mirrors the clone-and-substitute technique used
// in lib/pptxBuilder.ts, adapted to this slide's 3-shape layout (fixed
// corner label, single-run title, multi-paragraph body).
import JSZip from 'jszip';
import { xmlEscape } from './pptxBuilder';
import { extractSlideSubset } from './pptxSlices';

export interface AnnouncementItem {
  /** Title text as written between < > in the source text, e.g. "새가족 환영". */
  title: string;
  bodyLines: string[];
}

const ITEM_MARKER = /(\d+)\s*\.\s*<\s*([\s\S]+?)\s*>/g;

/**
 * Parse freeform announcement text into items. Anything before the first
 * "N. <title>" marker (e.g. a "7/5 주일광고:" header line) is discarded —
 * only the numbered items become slides.
 */
export function parseAnnouncements(text: string): AnnouncementItem[] {
  const markers = [...text.matchAll(ITEM_MARKER)];
  if (markers.length === 0) return [];

  const items: AnnouncementItem[] = [];
  for (let i = 0; i < markers.length; i++) {
    const marker = markers[i];
    const title = marker[2].replace(/\s+/g, ' ').trim();
    const start = marker.index! + marker[0].length;
    const end = i + 1 < markers.length ? markers[i + 1].index! : text.length;
    const bodyLines = text
      .slice(start, end)
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    if (title) items.push({ title, bodyLines });
  }
  return items;
}

function setTextOfFirstRun(xml: string, text: string): string {
  const open = xml.indexOf('<a:t>');
  const close = xml.indexOf('</a:t>', open);
  if (open === -1 || close === -1) {
    throw new Error('공지 슬라이드 템플릿에서 텍스트 요소를 찾지 못했습니다.');
  }
  return xml.slice(0, open + 5) + text + xml.slice(close);
}

function shrinkForLineCount(baseSz: number, fitLines: number, actualLines: number, minSz: number): number {
  if (actualLines <= fitLines) return baseSz;
  return Math.max(minSz, Math.round((baseSz * fitLines) / actualLines / 100) * 100);
}

const EMU_PER_POINT = 12700;

/** Approximate rendered width of a line in em units at 1em per full-width glyph. */
function textWidthEm(line: string): number {
  let em = 0;
  for (const ch of line) {
    // Hangul/CJK glyphs are full-width (~1em); Latin letters, digits and
    // punctuation average a bit over half an em in the deck's fonts.
    em += /[ᄀ-ᇿ⺀-꓏가-힣豈-﫿＀-￯]/.test(ch) ? 1 : 0.55;
  }
  return em;
}

/**
 * Pick the largest font size (1/100 pt steps of 100) at which the body text —
 * including soft-wrapped long lines — fits the shape. Reads the shape's
 * extent, insets and line spacing from its own XML so it tracks the template.
 */
function fitBodyFontSize(bodyShapeXml: string, lines: string[], baseSz: number, minSz: number): number {
  const ext = bodyShapeXml.match(/<a:ext cx="(\d+)" cy="(\d+)"\/>/);
  if (!ext) return shrinkForLineCount(baseSz, 5, lines.length, minSz);

  const bodyPr = bodyShapeXml.match(/<a:bodyPr\b[^>]*/)?.[0] ?? '';
  const inset = (name: string, fallback: number) =>
    Number(bodyPr.match(new RegExp(`\\b${name}="(\\d+)"`))?.[1] ?? fallback);
  const widthPt = (Number(ext[1]) - inset('lIns', 91440) - inset('rIns', 91440)) / EMU_PER_POINT;
  const heightPt = (Number(ext[2]) - inset('tIns', 45720) - inset('bIns', 45720)) / EMU_PER_POINT;
  const spacing = Number(bodyShapeXml.match(/<a:lnSpc><a:spcPct val="(\d+)"\/>/)?.[1] ?? 100000) / 100000;

  for (let sz = baseSz; sz >= minSz; sz -= 100) {
    const fontPt = sz / 100;
    // ~1.2 × font size is the single-line box PowerPoint spaces by spcPct.
    const lineHeightPt = fontPt * 1.2 * spacing;
    const emPerLine = Math.max(1, widthPt / fontPt);
    let wrappedLines = 0;
    for (const line of lines) {
      wrappedLines += Math.max(1, Math.ceil(textWidthEm(line) / emPerLine));
    }
    if (wrappedLines * lineHeightPt <= heightPt) return sz;
  }
  return minSz;
}

/** Build one announcement slide's XML from the template item-slide XML. */
function buildAnnouncementSlideXml(templateXml: string, index: number, item: AnnouncementItem): string {
  const shapes = [...templateXml.matchAll(/<p:sp>[\s\S]*?<\/p:sp>/g)];
  if (shapes.length < 3) {
    throw new Error('공지 슬라이드 템플릿의 구조가 예상과 다릅니다 (도형 3개 필요).');
  }
  const [, titleShape, bodyShape] = shapes;

  const newTitleShape = setTextOfFirstRun(titleShape[0], xmlEscape(`${index + 1}. <${item.title}>`));

  const bodyStart = bodyShape[0].indexOf('<p:txBody>');
  const bodyEnd = bodyShape[0].indexOf('</p:txBody>', bodyStart);
  const body = bodyShape[0].slice(bodyStart, bodyEnd);
  const firstP = body.indexOf('<a:p>');
  const lastP = body.lastIndexOf('</a:p>');
  if (firstP === -1 || lastP === -1) {
    throw new Error('공지 슬라이드 템플릿에서 본문 문단을 찾지 못했습니다.');
  }
  const paraTpl = body.slice(firstP, body.indexOf('</a:p>', firstP) + '</a:p>'.length);

  const lines = item.bodyLines.length > 0 ? item.bodyLines : [''];
  const sz = fitBodyFontSize(bodyShape[0], lines, 2500, 1200);
  const paragraphs = lines
    .map((line) => {
      const withSize = paraTpl.replace(/sz="\d+"/g, `sz="${sz}"`);
      return setTextOfFirstRun(withSize, xmlEscape(line));
    })
    .join('');
  const newBody = body.slice(0, firstP) + paragraphs + body.slice(lastP + '</a:p>'.length);
  const newBodyShape = bodyShape[0].slice(0, bodyStart) + newBody + bodyShape[0].slice(bodyEnd);

  let out = templateXml;
  // Replace body first (later in the string) so the title shape's offset stays valid.
  out = out.slice(0, bodyShape.index!) + newBodyShape + out.slice(bodyShape.index! + bodyShape[0].length);
  out = out.slice(0, titleShape.index!) + newTitleShape + out.slice(titleShape.index! + titleShape[0].length);
  return out;
}

/**
 * Build a standalone deck with one slide per announcement item, cloning
 * `itemSlideNumber`'s design (1-based position in `templateData`'s
 * presentation order) and reusing its layout/master/theme/media unchanged.
 */
export async function buildAnnouncementDeck(
  templateData: ArrayBuffer | Uint8Array,
  itemSlideNumber: number,
  items: AnnouncementItem[],
): Promise<Uint8Array> {
  if (items.length === 0) throw new Error('생성할 공지 항목이 없습니다.');

  // Reuse extractSlideSubset's single-slide extraction to get a standalone
  // mini-deck carrying the item slide's own layout/master/theme, then swap
  // in N generated copies of that one slide.
  const singleSlideDeck = await extractSlideSubset(templateData, [itemSlideNumber]);
  const zip = await JSZip.loadAsync(singleSlideDeck);
  const templateXml = await zip.file('ppt/slides/slide1.xml')!.async('string');
  const templateRels = await zip.file('ppt/slides/_rels/slide1.xml.rels')!.async('string');

  let contentTypes = await zip.file('[Content_Types].xml')!.async('string');
  contentTypes = contentTypes.replace(/<Override PartName="\/ppt\/slides\/slide1\.xml"[^>]*\/>/, '');
  zip.remove('ppt/slides/slide1.xml');
  zip.remove('ppt/slides/_rels/slide1.xml.rels');

  items.forEach((item, i) => {
    const n = i + 1;
    zip.file(`ppt/slides/slide${n}.xml`, buildAnnouncementSlideXml(templateXml, i, item));
    zip.file(`ppt/slides/_rels/slide${n}.xml.rels`, templateRels);
    contentTypes = contentTypes.replace(
      '</Types>',
      `<Override PartName="/ppt/slides/slide${n}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/></Types>`,
    );
  });

  const presentationOrig = await zip.file('ppt/presentation.xml')!.async('string');
  let presRels = (await zip.file('ppt/_rels/presentation.xml.rels')!.async('string')).replace(
    /<Relationship[^>]*Type="[^"]*\/relationships\/slide"[^>]*\/>/g,
    '',
  );
  const sldIds: string[] = [];
  items.forEach((_, i) => {
    const n = i + 1;
    const rid = `rIdAnn${n}`;
    presRels = presRels.replace(
      '</Relationships>',
      `<Relationship Id="${rid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${n}.xml"/></Relationships>`,
    );
    sldIds.push(`<p:sldId id="${800000 + n}" r:id="${rid}"/>`);
  });
  const presentation = presentationOrig.replace(
    /<p:sldIdLst>[\s\S]*?<\/p:sldIdLst>/,
    `<p:sldIdLst>${sldIds.join('')}</p:sldIdLst>`,
  );

  zip.file('[Content_Types].xml', contentTypes);
  zip.file('ppt/presentation.xml', presentation);
  zip.file('ppt/_rels/presentation.xml.rels', presRels);

  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
}
