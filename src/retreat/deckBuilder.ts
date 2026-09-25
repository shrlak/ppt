// Assembles one 수련회 session's deck out of public/retreat-template.pptx.
//
// Every slide is one of the template's 13 designs cloned and filled in (see
// template.ts), so the deck keeps the retreat's own photos, master and
// fonts. Text that would not fit its box is shrunk on the slide itself —
// never left to PowerPoint's autofit, which a projector's viewer may ignore.
import JSZip from 'jszip';
import { assertPptxIntegrity } from '../lib/pptx/pptxPackage';
import { ensureDefaultExtension, removeContentTypeOverridesWhere, setContentTypeOverride } from '../lib/pptx/contentTypes';
import { xmlEscape } from '../lib/pptx/pptxBuilder';
import { fitBodyFontSize } from '../lib/pptx/textFit';
import { containRect } from '../lib/pptx/imageDeckBuilder';
import type { DeckOverviewItem } from '../lib/utils/deckOverview';
import { planRetreatSession, quotedSermonTitle, titleLines, type RetreatSlidePlan } from './planner';
import type { RetreatPassage } from './scripture';
import { RETREAT_SLIDES, RETREAT_TOKENS } from './template';
import type { PosterImage, RetreatInfo, RetreatSession } from './types';

const SLIDE_REL_TYPE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide';
const SLIDE_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.presentationml.slide+xml';
const IMAGE_REL_TYPE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image';
const SLIDE_WIDTH = 9144000;
const SLIDE_HEIGHT = 6858000;

export interface RetreatDeckInput {
  template: ArrayBuffer | Uint8Array;
  info: RetreatInfo;
  session: RetreatSession;
  /** Each scripture block's resolved verses, by block id. */
  passages?: Record<string, RetreatPassage | null | undefined>;
}

export interface RetreatDeckResult {
  deck: Uint8Array;
  overview: DeckOverviewItem[];
}

// ---- XML helpers ----------------------------------------------------------------

function fill(xml: string, token: string, value: string): string {
  return xml.split(token).join(xmlEscape(value));
}

interface Span {
  start: number;
  end: number;
  xml: string;
}

function shapeHolding(xml: string, needle: string): Span {
  for (const match of xml.matchAll(/<p:sp>[\s\S]*?<\/p:sp>/g)) {
    if (match[0].includes(needle)) return { start: match.index!, end: match.index! + match[0].length, xml: match[0] };
  }
  throw new Error(`수련회 템플릿에서 ${needle} 도형을 찾지 못했습니다.`);
}

function paragraphHolding(xml: string, needle: string): Span {
  for (const match of xml.matchAll(/<a:p>[\s\S]*?<\/a:p>/g)) {
    if (match[0].includes(needle)) return { start: match.index!, end: match.index! + match[0].length, xml: match[0] };
  }
  throw new Error(`수련회 템플릿에서 ${needle} 문단을 찾지 못했습니다.`);
}

function replaceSpan(xml: string, span: Span, value: string): string {
  return xml.slice(0, span.start) + value + xml.slice(span.end);
}

/** Every run size inside a shape set to `sz`, and PowerPoint's own shrink turned off. */
function sized(shapeXml: string, sz: number): string {
  return shapeXml
    .replace(/\bsz="\d+"/g, `sz="${sz}"`)
    .replace(/<a:normAutofit\b[^>]*\/>/g, '<a:normAutofit/>');
}

/**
 * One paragraph per line, cloned from the paragraph holding `token` in the
 * shape holding it, at the largest size (≤ the template's) that fits.
 */
function fillLines(xml: string, token: string, lines: string[], minSz: number): string {
  const shape = shapeHolding(xml, token);
  const paragraph = paragraphHolding(shape.xml, token);
  const baseSz = Number(paragraph.xml.match(/\bsz="(\d+)"/)?.[1] ?? 3200);
  const sz = fitBodyFontSize(shape.xml, lines.length > 0 ? lines : [''], baseSz, minSz);
  const paragraphs = (lines.length > 0 ? lines : ['']).map((line) => fill(paragraph.xml, token, line)).join('');
  return replaceSpan(xml, shape, sized(replaceSpan(shape.xml, paragraph, paragraphs), sz));
}

/** A single-run text box, shrunk when the text would not fit it. */
function fillFitted(xml: string, token: string, value: string, minSz: number): string {
  const shape = shapeHolding(xml, token);
  const baseSz = Number(shape.xml.match(/\bsz="(\d+)"/)?.[1] ?? 3200);
  const sz = fitBodyFontSize(shape.xml, [value], baseSz, minSz);
  return replaceSpan(xml, shape, sized(fill(shape.xml, token, value), sz));
}

// ---- slides -------------------------------------------------------------------

export function buildCoverSlide(xml: string, poster: PosterImage): string {
  const box = containRect(poster.width, poster.height, SLIDE_WIDTH, SLIDE_HEIGHT);
  return xml
    .replace(/<a:srgbClr val="[0-9A-Fa-f]{6}"\/>/, `<a:srgbClr val="${poster.background}"/>`)
    .replace(/<a:srcRect\b[^>]*\/>/, '')
    .replace(
      /(<p:pic>[\s\S]*?<a:xfrm>)<a:off x="\d+" y="\d+"\/><a:ext cx="\d+" cy="\d+"\/>/,
      `$1<a:off x="${box.x}" y="${box.y}"/><a:ext cx="${box.cx}" cy="${box.cy}"/>`,
    );
}

function slideXml(plan: RetreatSlidePlan, templates: Record<number, string>, info: RetreatInfo): string {
  switch (plan.kind) {
    case 'cover':
      return templates[RETREAT_SLIDES.cover];
    case 'title': {
      const [line1, line2] = titleLines(info);
      let xml = fill(templates[RETREAT_SLIDES.title], RETREAT_TOKENS.titleLine1, line1);
      xml = fill(xml, RETREAT_TOKENS.titleLine2, line2);
      return fill(xml, RETREAT_TOKENS.subtitle, info.subtitle.trim());
    }
    case 'section':
      return fill(templates[RETREAT_SLIDES.section], RETREAT_TOKENS.section, plan.label);
    case 'songTitle':
      return fillFitted(templates[RETREAT_SLIDES.songTitle], RETREAT_TOKENS.songTitle, plan.title, 3200);
    case 'lyrics': {
      const xml = fillLines(templates[RETREAT_SLIDES.lyrics], RETREAT_TOKENS.line, plan.lines, 2800);
      return fillFitted(xml, RETREAT_TOKENS.songTitle, plan.title, 1600);
    }
    case 'passage':
      return fill(templates[RETREAT_SLIDES.passage], RETREAT_TOKENS.passageKo, plan.passageKo);
    case 'verse': {
      let xml = templates[RETREAT_SLIDES.verse];
      // The Korean verse is one paragraph of two runs (절 번호 + 본문); size
      // them together so the number never outgrows its verse.
      const ko = shapeHolding(xml, RETREAT_TOKENS.verseKo);
      const koSz = fitBodyFontSize(ko.xml, [`${plan.verseNo} ${plan.ko}`], 3150, 1800);
      const koFilled = fill(fill(ko.xml, RETREAT_TOKENS.verseNo, plan.verseNo), RETREAT_TOKENS.verseKo, plan.ko);
      xml = replaceSpan(xml, ko, sized(koFilled, koSz));
      xml = fillFitted(xml, RETREAT_TOKENS.verseEn, plan.en, 1800);
      xml = fill(xml, RETREAT_TOKENS.passageKo, plan.passageKo);
      return fill(xml, RETREAT_TOKENS.passageEn, plan.passageEn);
    }
    case 'sermon':
      return fillFitted(templates[RETREAT_SLIDES.sermon], RETREAT_TOKENS.sermonTitle, quotedSermonTitle(plan.title), 2000);
    case 'blank':
      return templates[RETREAT_SLIDES.blank];
    case 'prayer':
      return fill(templates[RETREAT_SLIDES.prayer], RETREAT_TOKENS.label, plan.label);
    case 'benediction':
      return fill(templates[RETREAT_SLIDES.benediction], RETREAT_TOKENS.label, plan.label);
    case 'announcementDivider':
      return fill(templates[RETREAT_SLIDES.announcementDivider], RETREAT_TOKENS.label, plan.label);
    case 'announcement': {
      let xml = fillFitted(templates[RETREAT_SLIDES.announcement], RETREAT_TOKENS.announcementTitle, plan.title, 2400);
      xml = fillLines(xml, RETREAT_TOKENS.announcementLine, plan.lines, 1600);
      xml = fill(xml, RETREAT_TOKENS.footerTitle, info.title.trim());
      return fill(xml, RETREAT_TOKENS.footerTheme, info.theme.trim());
    }
  }
}

function templateFor(plan: RetreatSlidePlan): number {
  switch (plan.kind) {
    case 'cover':
      return RETREAT_SLIDES.cover;
    case 'title':
      return RETREAT_SLIDES.title;
    case 'section':
      return RETREAT_SLIDES.section;
    case 'songTitle':
      return RETREAT_SLIDES.songTitle;
    case 'lyrics':
      return RETREAT_SLIDES.lyrics;
    case 'passage':
      return RETREAT_SLIDES.passage;
    case 'verse':
      return RETREAT_SLIDES.verse;
    case 'sermon':
      return RETREAT_SLIDES.sermon;
    case 'blank':
      return RETREAT_SLIDES.blank;
    case 'prayer':
      return RETREAT_SLIDES.prayer;
    case 'benediction':
      return RETREAT_SLIDES.benediction;
    case 'announcementDivider':
      return RETREAT_SLIDES.announcementDivider;
    case 'announcement':
      return RETREAT_SLIDES.announcement;
  }
}

export function overviewRow(plan: RetreatSlidePlan, index: number, sessionName: string): DeckOverviewItem {
  const id = `retreat-${plan.kind}-${index}`;
  switch (plan.kind) {
    case 'cover':
      return { id, kind: 'front', label: '표지', subtitle: sessionName };
    case 'title':
      return { id, kind: 'front', label: '수련회 제목' };
    case 'section':
      return { id, kind: 'divider', label: plan.label };
    case 'songTitle':
      return { id, kind: 'lyrics-title', label: plan.title, songId: plan.songId };
    case 'lyrics':
      return { id, kind: 'lyrics', label: plan.title, subtitle: plan.lines[0], songId: plan.songId };
    case 'passage':
      return { id, kind: 'divider', label: '설교말씀', subtitle: plan.passageKo };
    case 'verse':
      return { id, kind: 'bible', label: plan.passageKo, subtitle: `${plan.verseNo}절` };
    case 'sermon':
      return { id, kind: 'sermon', label: '설교', subtitle: plan.title || undefined };
    case 'blank':
      return { id, kind: 'divider', label: '빈 화면' };
    case 'prayer':
    case 'benediction':
      return { id, kind: 'prayer', label: plan.label };
    case 'announcementDivider':
      return { id, kind: 'divider', label: plan.label };
    case 'announcement':
      return { id, kind: 'announcement', label: plan.title, subtitle: plan.lines[0] };
  }
}

export async function buildRetreatDeck(input: RetreatDeckInput): Promise<RetreatDeckResult> {
  const plans = planRetreatSession(input.session, input.passages);
  if (plans.length === 0) throw new Error('만들 슬라이드가 없습니다. 순서를 하나 이상 넣어 주세요.');

  const zip = await JSZip.loadAsync(input.template);
  const templates: Record<number, string> = {};
  const rels: Record<number, string> = {};
  for (const position of Object.values(RETREAT_SLIDES)) {
    const xml = await zip.file(`ppt/slides/slide${position}.xml`)?.async('string');
    const rel = await zip.file(`ppt/slides/_rels/slide${position}.xml.rels`)?.async('string');
    if (!xml || !rel) throw new Error(`수련회 템플릿에 ${position}번 슬라이드가 없습니다.`);
    templates[position] = xml;
    rels[position] = rel;
  }
  let presentation = await zip.file('ppt/presentation.xml')!.async('string');
  let presRels = await zip.file('ppt/_rels/presentation.xml.rels')!.async('string');
  let contentTypes = await zip.file('[Content_Types].xml')!.async('string');
  for (const path of Object.keys(zip.files)) {
    if (/^ppt\/slides\//.test(path)) zip.remove(path);
  }

  const poster = input.session.poster;
  if (poster) {
    const extension = poster.mimeType === 'image/png' ? 'png' : 'jpeg';
    zip.file(`ppt/media/retreat-poster.${extension}`, new Uint8Array(poster.data.slice(0)));
    contentTypes = ensureDefaultExtension(contentTypes, extension, poster.mimeType);
    templates[RETREAT_SLIDES.cover] = buildCoverSlide(templates[RETREAT_SLIDES.cover], poster);
    rels[RETREAT_SLIDES.cover] = rels[RETREAT_SLIDES.cover].replace(
      new RegExp(`(<Relationship[^>]*Type="${IMAGE_REL_TYPE}"[^>]*Target=")[^"]*(")`),
      `$1../media/retreat-poster.${extension}$2`,
    );
  }

  plans.forEach((plan, index) => {
    const n = index + 1;
    zip.file(`ppt/slides/slide${n}.xml`, slideXml(plan, templates, input.info));
    zip.file(`ppt/slides/_rels/slide${n}.xml.rels`, rels[templateFor(plan)]);
  });

  presentation = presentation.replace(
    /<p:sldIdLst>[\s\S]*?<\/p:sldIdLst>/,
    `<p:sldIdLst>${plans.map((_, index) => `<p:sldId id="${256 + index}" r:id="rId${3001 + index}"/>`).join('')}</p:sldIdLst>`,
  );
  presRels = presRels
    .replace(new RegExp(`<Relationship [^>]*Type="${SLIDE_REL_TYPE}"[^>]*/>`, 'g'), '')
    .replace(
      '</Relationships>',
      `${plans
        .map((_, index) => `<Relationship Id="rId${3001 + index}" Type="${SLIDE_REL_TYPE}" Target="slides/slide${index + 1}.xml"/>`)
        .join('')}</Relationships>`,
    );
  contentTypes = removeContentTypeOverridesWhere(contentTypes, (partName) => /^\/ppt\/slides\//.test(partName));
  plans.forEach((_, index) => {
    contentTypes = setContentTypeOverride(contentTypes, `ppt/slides/slide${index + 1}.xml`, SLIDE_CONTENT_TYPE);
  });
  zip.file('ppt/presentation.xml', presentation);
  zip.file('ppt/_rels/presentation.xml.rels', presRels);
  zip.file('[Content_Types].xml', contentTypes);

  const deck = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
  await assertPptxIntegrity(deck);
  return { deck, overview: plans.map((plan, index) => overviewRow(plan, index, input.session.name)) };
}
