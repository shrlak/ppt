// Writes the week's 기도제목 into the 기도 준비 slide of the front deck
// ("지금은 기도로 예배를 준비하는 시간입니다."), copying that slide when the
// topics need more than one (see utils/prayerTopics.ts for how they are
// shared out).
//
// The slide is found by its 기도제목 text box — named "기도제목" in the
// bundled public/front-slides.pptx, and still holding "기도제목 1" in a deck
// someone re-saved without the name — so a front deck replaced in 관리자 설정
// is filled the same way, and one without that box is left exactly as it is.
// Each copy keeps the slide's own heading, background and box; only the
// box's paragraphs are rewritten, from the box's own first paragraph and run,
// and the box is run down to just above the slide's bottom edge so the
// topics have the room the slide has.
import JSZip from 'jszip';
import { xmlEscape } from './pptxBuilder';
import { extractSlideSubset, slideOrderOf } from './pptxSlices';
import { readSlideSizeOf } from './slideGeometry';
import {
  DEFAULT_TOPIC_BOX,
  LONE_TITLE_AFTER_EM,
  POINT_AFTER_EM,
  TITLE_AFTER_EM,
  TOPIC_GAP_EM,
  hasPoints,
  planPrayerTopicPages,
  type PrayerTopic,
  type PrayerTopicBox,
  type PrayerTopicPage,
} from '../utils/prayerTopics';

const EMU_PER_POINT = 12700;
/** The box is run down to this far above the slide's bottom edge. */
const BOTTOM_MARGIN_EMU = 365760; // 0.4"
const DEFAULT_POINT_MARGIN = 457200;
const DEFAULT_POINT_INDENT = -381000;

const SHAPE = /<p:sp>[\s\S]*?<\/p:sp>/g;

/** True for the 기도제목 box: by its name, or by the "기도제목 1" it was shipped with. */
function isTopicsShape(shapeXml: string): boolean {
  if (/<p:cNvPr\b[^>]*\bname="기도제목"/.test(shapeXml)) return true;
  const text = [...shapeXml.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((m) => m[1]).join('');
  return /^\s*기도제목\s*1/.test(text);
}

function topicsShapeOf(slideXml: string): { start: number; xml: string } | null {
  for (const match of slideXml.matchAll(SHAPE)) {
    if (isTopicsShape(match[0])) return { start: match.index!, xml: match[0] };
  }
  return null;
}

function attr(tag: string, name: string): string | undefined {
  return tag.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1];
}

interface BoxGeometry {
  /** The `<a:xfrm>` the box is written with: its own, run down to the bottom margin. */
  xfrm: string;
  box: PrayerTopicBox;
}

function boxGeometry(shapeXml: string, slideHeight: number, pointMargin: number): BoxGeometry | null {
  const xfrm = shapeXml.match(/<a:xfrm\b[^>]*>[\s\S]*?<\/a:xfrm>/)?.[0];
  const off = xfrm?.match(/<a:off x="(-?\d+)" y="(-?\d+)"\/>/);
  const ext = xfrm?.match(/<a:ext cx="(\d+)" cy="(\d+)"\/>/);
  if (!xfrm || !off || !ext) return null;
  const y = Number(off[2]);
  const cx = Number(ext[1]);
  const cy = Math.max(Number(ext[2]), slideHeight - BOTTOM_MARGIN_EMU - y);
  const bodyPr = shapeXml.match(/<a:bodyPr\b[^>]*/)?.[0] ?? '';
  const inset = (name: string, fallback: number) => Number(attr(bodyPr, name) ?? fallback);
  return {
    xfrm: xfrm.replace(/<a:ext cx="\d+" cy="\d+"\/>/, `<a:ext cx="${cx}" cy="${cy}"/>`),
    box: {
      widthPt: (cx - inset('lIns', 91440) - inset('rIns', 91440)) / EMU_PER_POINT,
      heightPt: (cy - inset('tIns', 45720) - inset('bIns', 45720)) / EMU_PER_POINT,
      pointIndentPt: pointMargin / EMU_PER_POINT,
    },
  };
}

/** What the box's own first paragraph says about how its lines look. */
interface ParagraphStyle {
  algn: string;
  pointMargin: number;
  pointIndent: number;
  /** The bullet's colour, size slot, font and character, in the order `<a:pPr>` takes them. */
  bullet: string;
  /** The first run's `<a:rPr>`: colour, typeface, language. */
  rPr: string;
}

function paragraphStyle(shapeXml: string): ParagraphStyle {
  const paragraph = shapeXml.match(/<a:p>[\s\S]*?<\/a:p>/)?.[0] ?? '';
  const pPr = paragraph.match(/<a:pPr\b[^>]*?(?:\/>|>[\s\S]*?<\/a:pPr>)/)?.[0] ?? '';
  const pPrTag = pPr.match(/<a:pPr\b[^>]*/)?.[0] ?? '';
  const bulletPart = (name: string) =>
    pPr.match(new RegExp(`<a:${name}\\b[^>]*?(?:/>|>[\\s\\S]*?</a:${name}>)`))?.[0] ?? '';
  const char = pPr.match(/<a:buChar\b[^>]*\/>/)?.[0] ?? '<a:buChar char="●"/>';
  const margin = Number(attr(pPrTag, 'marL'));
  const indent = Number(attr(pPrTag, 'indent'));
  const rPr =
    paragraph.match(/<a:rPr\b[^>]*?(?:\/>|>[\s\S]*?<\/a:rPr>)/)?.[0] ??
    '<a:rPr lang="ko-KR" sz="2000"><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill></a:rPr>';
  return {
    algn: attr(pPrTag, 'algn') ?? 'l',
    pointMargin: Number.isFinite(margin) && margin > 0 ? margin : DEFAULT_POINT_MARGIN,
    pointIndent: Number.isFinite(indent) && indent < 0 ? indent : DEFAULT_POINT_INDENT,
    bullet: `${bulletPart('buClr')}{{BU_SZ}}${bulletPart('buFont')}${char}`,
    rPr,
  };
}

/** `<a:rPr>` at `sz`, bold or not; a self-closing one stays self-closing. */
function runProperties(rPr: string, sz: number, bold: boolean): string {
  const open = rPr.match(/<a:rPr\b[^>]*?(?=\/?>)/)![0];
  let tag = open.replace(/\s+(?:sz|b)="[^"]*"/g, '');
  tag = `${tag} sz="${sz}" b="${bold ? 1 : 0}"`;
  return rPr.replace(open, tag);
}

function spacing(name: 'spcBef' | 'spcAft', pt: number): string {
  return `<a:${name}><a:spcPts val="${Math.max(0, Math.round(pt * 100))}"/></a:${name}>`;
}

function paragraph(
  style: ParagraphStyle,
  text: string,
  sz: number,
  options: { bulleted: boolean; bold: boolean; before: number; after: number },
): string {
  const margin = options.bulleted ? style.pointMargin : 0;
  const indent = options.bulleted ? style.pointIndent : 0;
  const bullet = options.bulleted ? style.bullet.replace('{{BU_SZ}}', `<a:buSzPts val="${sz}"/>`) : '<a:buNone/>';
  return (
    `<a:p><a:pPr marL="${margin}" lvl="0" indent="${indent}" algn="${style.algn}" rtl="0">` +
    `<a:lnSpc><a:spcPct val="100000"/></a:lnSpc>${spacing('spcBef', options.before)}${spacing('spcAft', options.after)}` +
    `${bullet}</a:pPr><a:r>${runProperties(style.rPr, sz, options.bold)}<a:t>${xmlEscape(text)}</a:t></a:r></a:p>`
  );
}

/** The paragraphs of one slide's topics, laid out as prayerTopics.ts measures them. */
function pageParagraphs(style: ParagraphStyle, page: PrayerTopicPage, structured: boolean): string {
  const fontPt = page.sz / 100;
  return page.blocks
    .map((block, index) => {
      const last = index === page.blocks.length - 1;
      if (!structured) {
        return paragraph(style, block.title, page.sz, {
          bulleted: true,
          bold: false,
          before: 0,
          after: last ? 0 : LONE_TITLE_AFTER_EM * fontPt,
        });
      }
      const title = paragraph(style, `${block.number}. ${block.title}`, page.sz, {
        bulleted: false,
        bold: true,
        before: index > 0 ? TOPIC_GAP_EM * fontPt : 0,
        after: block.points.length > 0 ? TITLE_AFTER_EM * fontPt : 0,
      });
      const points = block.points.map((point, pointIndex) =>
        paragraph(style, point, page.sz, {
          bulleted: true,
          bold: false,
          before: 0,
          after: pointIndex < block.points.length - 1 ? POINT_AFTER_EM * fontPt : 0,
        }),
      );
      return title + points.join('');
    })
    .join('');
}

function rewriteShape(shapeXml: string, geometry: BoxGeometry, paragraphs: string): string {
  const withBox = shapeXml.replace(/<a:xfrm\b[^>]*>[\s\S]*?<\/a:xfrm>/, geometry.xfrm);
  const bodyStart = withBox.indexOf('<p:txBody>');
  const bodyEnd = withBox.indexOf('</p:txBody>', bodyStart);
  const body = withBox.slice(bodyStart, bodyEnd);
  const firstP = body.search(/<a:p[>\s/]/);
  const head = (firstP === -1 ? body : body.slice(0, firstP))
    // The size is chosen here; PowerPoint must not rescale it on open.
    .replace(/<a:normAutofit\b[^>]*\/>|<a:spAutoFit\/>/g, '<a:noAutofit/>');
  return withBox.slice(0, bodyStart) + head + paragraphs + withBox.slice(bodyEnd);
}

export interface PrayerTopicsResult {
  /** The front deck with the topics written in, or the deck as it came when nothing was. */
  data: ArrayBuffer | Uint8Array;
  /** 기도 준비 slides the topics fill (0 when none were written). */
  pages: number;
  /** 1-based position of the first of them in the returned deck (0 when none were written). */
  firstSlide: number;
  /** False when there were no topics, or the deck has no 기도제목 box to write them into. */
  applied: boolean;
}

/**
 * The front deck with `topics` written into its 기도 준비 slide, copied
 * right after itself as many times as the topics need. With no topics, or
 * no 기도제목 box in the deck, the deck comes back untouched.
 */
export async function applyPrayerTopics(
  frontDeck: ArrayBuffer | Uint8Array,
  topics: PrayerTopic[],
): Promise<PrayerTopicsResult> {
  const untouched: PrayerTopicsResult = { data: frontDeck, pages: 0, firstSlide: 0, applied: false };
  if (topics.length === 0) return untouched;

  const source = await JSZip.loadAsync(frontDeck);
  const names = await slideOrderOf(source);
  let slot = -1;
  let shape: { start: number; xml: string } | null = null;
  for (const [index, name] of names.entries()) {
    const xml = await source.file(`ppt/slides/${name}`)?.async('string');
    shape = xml ? topicsShapeOf(xml) : null;
    if (shape) {
      slot = index;
      break;
    }
  }
  if (!shape) return untouched;

  const slideSize = readSlideSizeOf(await source.file('ppt/presentation.xml')!.async('string'));
  const style = paragraphStyle(shape.xml);
  const geometry = boxGeometry(shape.xml, slideSize.cy, style.pointMargin) ?? {
    xfrm: shape.xml.match(/<a:xfrm\b[^>]*>[\s\S]*?<\/a:xfrm>/)?.[0] ?? '',
    box: DEFAULT_TOPIC_BOX,
  };
  const pages = planPrayerTopicPages(topics, geometry.box);
  const structured = hasPoints(topics);

  // The 기도 준비 slide once per page, in its own place; every other slide as it was.
  const order = names.flatMap((_, index) =>
    index === slot ? Array.from({ length: pages.length }, () => slot + 1) : [index + 1],
  );
  const zip = await JSZip.loadAsync(await extractSlideSubset(frontDeck, order, 'STORE'));
  for (const [i, page] of pages.entries()) {
    const path = `ppt/slides/slide${slot + 1 + i}.xml`;
    const xml = await zip.file(path)!.async('string');
    const found = topicsShapeOf(xml)!;
    const rewritten = rewriteShape(found.xml, geometry, pageParagraphs(style, page, structured));
    zip.file(path, xml.slice(0, found.start) + rewritten + xml.slice(found.start + found.xml.length));
  }
  return {
    data: await zip.generateAsync({ type: 'uint8array', compression: 'STORE' }),
    pages: pages.length,
    firstSlide: slot + 1,
    applied: true,
  };
}
