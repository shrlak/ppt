// Assembles the 찬양집회 deck out of public/praise-template.pptx.
//
// The template holds last year's four designs (see template.ts): every slide
// of the generated deck is one of them cloned and filled in, so the whole
// deck keeps that night's background photos, master and embedded Nanum
// Gothic fonts. 추가 자료 files (a sermon PPT, 말씀 slides, images, PDFs)
// are spliced in afterwards at the positions the plan gives them.
import JSZip from 'jszip';
import { assertPptxIntegrity } from '../lib/pptx/pptxPackage';
import { mergePptxDecks } from '../lib/pptx/pptxMerge';
import { readSlideSize, rescaleDeckToSize } from '../lib/pptx/slideGeometry';
import { removeContentTypeOverridesWhere, setContentTypeOverride, ensureDefaultExtension } from '../lib/pptx/contentTypes';
import { xmlEscape } from '../lib/pptx/pptxBuilder';
import { fitBodyFontSize } from '../lib/pptx/textFit';
import type { AdditionalFile } from '../lib/additionalFiles/types';
import type { DeckOverviewItem } from '../lib/utils/deckOverview';
import type { Song } from '../lib/utils/types';
import { planPraiseDeck, type PlacedAdditional, type PraiseSlidePlan } from './planner';
import {
  PRAISE_COVER_SHAPES,
  PRAISE_LYRICS_BASE_SZ,
  PRAISE_LYRICS_MIN_SZ,
  PRAISE_SLIDES,
  PRAISE_TOKENS,
} from './template';
import type { PraiseCoverImage, PraiseSongExtras } from './types';

const SLIDE_REL_TYPE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide';
const SLIDE_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.presentationml.slide+xml';
const IMAGE_REL_TYPE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image';


export interface PraiseDeckInput {
  /** public/praise-template.pptx. */
  template: ArrayBuffer | Uint8Array;
  songs: Song[];
  extras: Record<string, PraiseSongExtras>;
  /** Event date, `YYYY-MM-DD`; printed on the cover as MM/DD/YYYY. */
  date: string;
  /** A new cover picture replaces last year's (and its date box) entirely. */
  coverImage?: PraiseCoverImage | null;
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

export function buildTitleSlide(xml: string, titleKo: string, titleEn: string): string {
  let out = replaceToken(xml, PRAISE_TOKENS.titleKo, titleKo);
  if (titleEn) return replaceToken(out, PRAISE_TOKENS.titleEn, titleEn);
  // One title: drop the English line so the Korean stays centred on its own.
  const paragraph = paragraphHolding(out, PRAISE_TOKENS.titleEn);
  out = out.slice(0, paragraph.start) + out.slice(paragraph.end);
  return out;
}

/**
 * Korean lines, a blank line, then the English — last year's layout. The
 * font starts at the template's size and shrinks only when the slide holds
 * more than the box can show (the planner has already split any slide that
 * would need to shrink past readable), so nothing runs off the screen.
 */
export function buildLyricsSlide(xml: string, header: string, lines: string[], english: string[]): string {
  let out = replaceToken(xml, PRAISE_TOKENS.header, header);
  const body = shapeHolding(out, PRAISE_TOKENS.line);
  const paragraph = paragraphHolding(body.xml, PRAISE_TOKENS.line);
  const rendered = english.length > 0 && lines.length > 0 ? [...lines, '', ...english] : [...lines, ...english];
  const sz = fitBodyFontSize(body.xml, rendered, PRAISE_LYRICS_BASE_SZ, PRAISE_LYRICS_MIN_SZ);
  const paragraphs = rendered.map((line) => lyricParagraph(paragraph.xml, line, sz)).join('');
  const newBody = body.xml.slice(0, paragraph.start) + paragraphs + body.xml.slice(paragraph.end);
  out = out.slice(0, body.start) + newBody + out.slice(body.end);
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

/** Cover, songs and 기도 slides as one package — everything but 추가 자료. */
async function buildBaseDeck(
  input: PraiseDeckInput,
  plans: Exclude<PraiseSlidePlan, { kind: 'additional' }>[],
  compression: 'STORE' | 'DEFLATE',
): Promise<Uint8Array> {
  const zip = await JSZip.loadAsync(input.template);
  const [cover, title, lyrics, prayer] = await Promise.all([
    readTemplateSlide(zip, PRAISE_SLIDES.cover),
    readTemplateSlide(zip, PRAISE_SLIDES.songTitle),
    readTemplateSlide(zip, PRAISE_SLIDES.lyrics),
    readTemplateSlide(zip, PRAISE_SLIDES.prayer),
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

  plans.forEach((plan, index) => {
    const n = index + 1;
    let xml: string;
    let rels: string;
    switch (plan.kind) {
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
      case 'prayer':
      default:
        xml = prayer.xml;
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
      return { id, kind: 'prayer', label: '기도 / Prayer' };
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
  const plans = planPraiseDeck(input.songs, input.extras, placements);
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
