// Builds the output .pptx by cloning slides from the bundled template
// (a Google-Slides-exported deck: title slides + 4-line lyrics slides).
import JSZip from 'jszip';
import type { Song, SlidePlan } from '../utils/types';
import { planAllSlides } from '../utils/slidePlanner';
import { removeContentTypeOverridesWhere, setContentTypeOverride } from './contentTypes';
import { fitTitleFontSize, singleLineBody, withFontSize } from './textFit';

const SLIDE_REL_TYPE =
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide';
const SLIDE_CONTENT_TYPE =
  'application/vnd.openxmlformats-officedocument.presentationml.slide+xml';
const RELS_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const LAYOUT_REL_TYPE =
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout';
const IMAGE_REL_TYPE =
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image';

// XML 1.0 cannot represent most control characters at all — not even as
// entity references. Real-world input carries them anyway: OCR emits form
// feeds, and text pasted from Word uses vertical tabs for soft line breaks.
// PowerPoint refuses to open a deck containing one ("needs repair").
const XML_ILLEGAL =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

export function xmlEscape(s: string): string {
  return s
    .replace(/[\u000B\u000C\u0085]/g, ' ') // VT/FF/NEL usually meant a line break — keep a gap
    .replace(XML_ILLEGAL, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function parseLocalDate(value?: string): Date | null {
  if (!value) return null;

  const normalized = value.trim();
  const yearFirst = normalized.match(/^(\d{4})\s*[./-]\s*(\d{1,2})\s*[./-]\s*(\d{1,2})$/);
  const yearLast = normalized.match(/^(\d{1,2})\s*[./-]\s*(\d{1,2})\s*[./-]\s*(\d{2}|\d{4})$/);
  const korean = normalized.match(/^(\d{4})\s*년\s*(\d{1,2})\s*월\s*(\d{1,2})\s*일?$/);

  const parts = yearFirst
    ? { year: Number(yearFirst[1]), month: Number(yearFirst[2]), day: Number(yearFirst[3]) }
    : yearLast
      ? {
          year: yearLast[3].length === 2 ? 2000 + Number(yearLast[3]) : Number(yearLast[3]),
          month: Number(yearLast[1]),
          day: Number(yearLast[2]),
        }
      : korean
        ? { year: Number(korean[1]), month: Number(korean[2]), day: Number(korean[3]) }
        : null;

  if (!parts) return null;
  const parsed = new Date(parts.year, parts.month - 1, parts.day);
  if (
    parsed.getFullYear() !== parts.year ||
    parsed.getMonth() !== parts.month - 1 ||
    parsed.getDate() !== parts.day
  ) {
    return null;
  }
  return parsed;
}

function sundayOnOrAfter(date: Date): Date {
  const sunday = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  sunday.setDate(sunday.getDate() + ((7 - sunday.getDay()) % 7));
  return sunday;
}

/** "7/11/26" (Saturday) → "0712.pptx" (that week's Sunday). */
export function suggestFileName(date?: string, today = new Date()): string {
  const sourceDate = parseLocalDate(date) ?? today;
  const sunday = sundayOnOrAfter(sourceDate);
  const month = String(sunday.getMonth() + 1).padStart(2, '0');
  const day = String(sunday.getDate()).padStart(2, '0');
  return `${month}${day}.pptx`;
}

function setTextOfFirstRun(xml: string, from: number, text: string): string {
  const open = xml.indexOf('<a:t>', from);
  const close = xml.indexOf('</a:t>', open);
  if (open === -1 || close === -1) {
    throw new Error('템플릿 슬라이드에서 텍스트 요소를 찾지 못했습니다.');
  }
  return xml.slice(0, open + 5) + text + xml.slice(close);
}

/** The smallest a song title is drawn at before it would take a second line. */
const TITLE_MIN_SZ = 1800;
const LABEL_MIN_SZ = 1000;

/**
 * Put `title` in the first run at or after `from`, and keep the shape holding
 * it to ONE line: a song title never wraps. It keeps the template's size
 * when it fits the box on one line and shrinks just enough when it does not,
 * and the box is set not to wrap at all.
 */
function setSingleLineTitle(xml: string, from: number, title: string): string {
  const at = xml.indexOf('<a:t>', from);
  const start = xml.lastIndexOf('<p:sp>', at);
  const end = xml.indexOf('</p:sp>', at);
  if (at === -1 || start === -1 || end === -1) return setTextOfFirstRun(xml, from, xmlEscape(title));
  const shape = xml.slice(start, end + '</p:sp>'.length);
  const baseSz = Number(shape.match(/<a:rPr\b[^>]*\bsz="(\d+)"/)?.[1] ?? 0);
  let filled = setTextOfFirstRun(shape, 0, xmlEscape(title));
  if (baseSz > 0) {
    const minSz = baseSz >= 4000 ? TITLE_MIN_SZ : LABEL_MIN_SZ;
    filled = withFontSize(filled, fitTitleFontSize(shape, title, baseSz, Math.min(minSz, baseSz)));
  }
  return xml.slice(0, start) + singleLineBody(filled) + xml.slice(end + '</p:sp>'.length);
}

/** Build one title slide from the template title slide (slide1): the title
 * at the template's own size (sz="5000") whenever it fits on one line, and
 * only as much smaller as it takes to stay on one line when it does not. */
function buildTitleSlide(titleTpl: string, title: string): string {
  return setSingleLineTitle(titleTpl, 0, title);
}

/** Build one lyrics slide from the template lyrics slide (slide2). */
function buildLyricsSlide(lyricsTpl: string, title: string, lines: string[]): string {
  const bodyStart = lyricsTpl.indexOf('<p:txBody>');
  const bodyEnd = lyricsTpl.indexOf('</p:txBody>', bodyStart);
  if (bodyStart === -1 || bodyEnd === -1) {
    throw new Error('템플릿 가사 슬라이드에서 본문 텍스트 상자를 찾지 못했습니다.');
  }
  const body = lyricsTpl.slice(bodyStart, bodyEnd);
  const firstP = body.indexOf('<a:p>');
  const lastP = body.lastIndexOf('</a:p>');
  if (firstP === -1 || lastP === -1) {
    throw new Error('템플릿 가사 슬라이드에서 문단을 찾지 못했습니다.');
  }
  const paraTpl = body.slice(firstP, body.indexOf('</a:p>', firstP) + '</a:p>'.length);

  // Every lyrics slide keeps the template's own font size (sz="4100") —
  // never shrunk to fit longer lines — so the text size matches across
  // every 찬양 가사 slide regardless of how much a given slide holds.
  const paragraphs = lines
    .map((line) => {
      let p = paraTpl;
      // 1.25 line spacing between lyric lines (template ships with 1.15).
      p = p.replace(/<a:lnSpc><a:spcPct val="\d+"\/><\/a:lnSpc>/g, '<a:lnSpc><a:spcPct val="125000"/></a:lnSpc>');
      p = setTextOfFirstRun(p, 0, xmlEscape(line));
      return p;
    })
    .join('');

  const newBody = body.slice(0, firstP) + paragraphs + body.slice(lastP + '</a:p>'.length);
  let xml = lyricsTpl.slice(0, bodyStart) + newBody + lyricsTpl.slice(bodyEnd);

  // Second shape holds the corner label with the song title — on one line.
  const labelBody = xml.indexOf('<p:txBody>', bodyStart + newBody.length);
  if (labelBody === -1) {
    throw new Error('템플릿 가사 슬라이드에서 제목 라벨을 찾지 못했습니다.');
  }
  xml = setSingleLineTitle(xml, labelBody, title);
  return xml;
}

function slideRels(plan: SlidePlan): string {
  const layout = plan.kind === 'title' ? 'slideLayout2.xml' : 'slideLayout1.xml';
  const rels = [
    `<Relationship Id="rId1" Type="${LAYOUT_REL_TYPE}" Target="../slideLayouts/${layout}"/>`,
  ];
  if (plan.kind === 'title') {
    rels.push(`<Relationship Id="rId3" Type="${IMAGE_REL_TYPE}" Target="../media/image2.png"/>`);
  }
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="${RELS_NS}">${rels.join('')}</Relationships>`
  );
}

/**
 * Generate the deck: clone the template's title/lyrics slides per the planned
 * slide list, and rewrite the presentation part lists accordingly.
 */
export async function buildPptx(
  templateData: ArrayBuffer | Uint8Array,
  songs: Song[],
): Promise<Uint8Array> {
  const plans = planAllSlides(songs);
  if (plans.length === 0) {
    throw new Error('생성할 슬라이드가 없습니다. 찬양과 가사를 입력해 주세요.');
  }

  const zip = await JSZip.loadAsync(templateData);
  const read = async (path: string): Promise<string> => {
    const file = zip.file(path);
    if (!file) throw new Error(`템플릿에서 ${path} 파일을 찾지 못했습니다.`);
    return file.async('string');
  };

  const titleTpl = await read('ppt/slides/slide1.xml');
  const lyricsTpl = await read('ppt/slides/slide2.xml');
  let presentation = await read('ppt/presentation.xml');
  let presRels = await read('ppt/_rels/presentation.xml.rels');
  let contentTypes = await read('[Content_Types].xml');

  // Drop the template's slides, notes slides and Google metadata part.
  const toRemove: string[] = [];
  zip.forEach((path) => {
    if (
      /^ppt\/slides\//.test(path) ||
      /^ppt\/notesSlides\//.test(path) ||
      path === 'ppt/metadata'
    ) {
      toRemove.push(path);
    }
  });
  for (const path of toRemove) zip.remove(path);

  // New slides.
  plans.forEach((plan, idx) => {
    const n = idx + 1;
    const xml =
      plan.kind === 'title'
        ? buildTitleSlide(titleTpl, plan.title)
        : buildLyricsSlide(lyricsTpl, plan.title, plan.lines ?? []);
    zip.file(`ppt/slides/slide${n}.xml`, xml);
    zip.file(`ppt/slides/_rels/slide${n}.xml.rels`, slideRels(plan));
  });

  // presentation.xml: new sldIdLst; drop the Google roundtrip ext (references removed metadata).
  const sldIds = plans
    .map((_, idx) => `<p:sldId id="${256 + idx}" r:id="rId${101 + idx}"/>`)
    .join('');
  presentation = presentation.replace(
    /<p:sldIdLst>[\s\S]*?<\/p:sldIdLst>/,
    `<p:sldIdLst>${sldIds}</p:sldIdLst>`,
  );
  presentation = presentation.replace(
    /<p:ext uri="GoogleSlidesCustomDataVersion2">[\s\S]*?<\/p:ext>/,
    '',
  );

  // presentation.xml.rels: drop old slide rels + metadata rel, add ours.
  presRels = presRels.replace(
    new RegExp(`<Relationship [^>]*Type="${SLIDE_REL_TYPE}"[^>]*/>`, 'g'),
    '',
  );
  presRels = presRels.replace(
    /<Relationship [^>]*Type="[^"]*presentationmetadata"[^>]*\/>/g,
    '',
  );
  const newRels = plans
    .map(
      (_, idx) =>
        `<Relationship Id="rId${101 + idx}" Type="${SLIDE_REL_TYPE}" Target="slides/slide${idx + 1}.xml"/>`,
    )
    .join('');
  presRels = presRels.replace('</Relationships>', `${newRels}</Relationships>`);

  // [Content_Types].xml: drop old slide/notesSlide/metadata overrides, add ours.
  contentTypes = removeContentTypeOverridesWhere(contentTypes, (partName) =>
    /^\/ppt\/(?:slides|notesSlides)\/|^\/ppt\/metadata$/.test(partName),
  );
  plans.forEach((_, idx) => {
    contentTypes = setContentTypeOverride(contentTypes, `ppt/slides/slide${idx + 1}.xml`, SLIDE_CONTENT_TYPE);
  });

  zip.file('ppt/presentation.xml', presentation);
  zip.file('ppt/_rels/presentation.xml.rels', presRels);
  zip.file('[Content_Types].xml', contentTypes);

  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
}
