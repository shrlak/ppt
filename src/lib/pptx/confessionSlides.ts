// Rewrites the 공동체 고백송 block that lives inside the fixed back-slides
// deck, so the song printed there is the one 관리자 설정 currently names.
//
// The block is found by content rather than by slide number: the first slide
// whose text says "공동체 고백" is the marker (it prints the song's name in
// quotes), and the lyric slides that follow it are the ones still carrying
// that name — the slide after them (송별, Happy Lord's Day, …) does not, and
// ends the block. That way an administrator can replace back-slides.pptx with
// their own file and this keeps working, as long as the block still reads the
// way the supplied deck's does.
//
// The rewrite happens IN PLACE: the block's own lyric slide is the template
// every new lyric slide is cloned from, so the replacement keeps the back
// deck's design, fonts and background exactly. Nothing else in the deck is
// touched, and the deck's masters/layouts/media are never duplicated (which
// splitting it apart and merging it back would do — the back deck is ~3 MB,
// mostly media).
import JSZip from 'jszip';
import type { Song } from '../utils/types';
import { planSlides } from '../utils/slidePlanner';
import { removeContentTypeOverride, setContentTypeOverride } from './contentTypes';
import { stripNonVisualParts } from './pptxPackage';
import { xmlEscape } from './pptxBuilder';
import { slideOrderOf } from './pptxSlices';

const SLIDE_CONTENT_TYPE =
  'application/vnd.openxmlformats-officedocument.presentationml.slide+xml';
const SLIDE_REL_TYPE =
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide';

/** Marker text that names the block, however it is spaced or suffixed. */
const CONFESSION_MARKER = '공동체고백';

/** Quote characters a deck may print the song's name in. */
const QUOTES = '"\'“”‘’«»「」';

/** Compare titles the way the rest of the app does: spacing/case-insensitively. */
function normalize(text: string): string {
  return text.replace(/\s+/g, '').toLowerCase();
}

function decodeXmlText(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/** Every `<a:t>` run's text on a slide, in document order, entity-decoded. */
function runTexts(xml: string): string[] {
  return [...xml.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((match) => decodeXmlText(match[1]));
}

interface ShapeSpan {
  start: number;
  end: number;
  xml: string;
}

/**
 * The slide's top-level shapes. `<p:sp>` never nests inside another `<p:sp>`,
 * so a non-greedy scan is exact (a shape inside a group is still found, which
 * is what we want — it is a text box like any other).
 */
function shapesOf(xml: string): ShapeSpan[] {
  return [...xml.matchAll(/<p:sp(?:\s[^>]*)?>[\s\S]*?<\/p:sp>/g)].map((match) => ({
    start: match.index!,
    end: match.index! + match[0].length,
    xml: match[0],
  }));
}

/** A shape's own box area (EMU²), used to tell the lyric body from the labels. */
function shapeArea(shapeXml: string): number {
  const ext = shapeXml.match(/<a:ext\s+cx="(\d+)"\s+cy="(\d+)"\s*\/>/);
  return ext ? Number(ext[1]) * Number(ext[2]) : 0;
}

/** Replace the text of the first `<a:t>` run at or after `from`. */
function setFirstRunText(xml: string, from: number, text: string): string {
  const open = xml.indexOf('<a:t>', from);
  if (open === -1) throw new Error('슬라이드에서 텍스트 요소를 찾지 못했습니다.');
  const close = xml.indexOf('</a:t>', open);
  if (close === -1) throw new Error('슬라이드에서 텍스트 요소를 찾지 못했습니다.');
  return xml.slice(0, open + '<a:t>'.length) + text + xml.slice(close);
}

/**
 * Rewrite a text shape's body so it holds exactly `lines`, one paragraph per
 * line, each keeping the shape's own paragraph formatting (its first
 * paragraph is the template). The template's font size is left untouched, so
 * every lyric slide in the block renders at the size the deck was designed at.
 */
function setShapeLines(shapeXml: string, lines: string[]): string {
  const bodyStart = shapeXml.indexOf('<p:txBody>');
  const bodyEnd = shapeXml.indexOf('</p:txBody>', bodyStart);
  if (bodyStart === -1 || bodyEnd === -1) {
    throw new Error('가사 슬라이드에서 본문 텍스트 상자를 찾지 못했습니다.');
  }
  const body = shapeXml.slice(bodyStart, bodyEnd);
  const firstP = body.indexOf('<a:p>');
  const lastP = body.lastIndexOf('</a:p>');
  if (firstP === -1 || lastP === -1) {
    throw new Error('가사 슬라이드에서 문단을 찾지 못했습니다.');
  }
  const paragraphTemplate = body.slice(firstP, body.indexOf('</a:p>', firstP) + '</a:p>'.length);
  const paragraphs = lines
    .map((line) => setFirstRunText(paragraphTemplate, 0, xmlEscape(line)))
    .join('');
  const newBody = body.slice(0, firstP) + paragraphs + body.slice(lastP + '</a:p>'.length);
  return shapeXml.slice(0, bodyStart) + newBody + shapeXml.slice(bodyEnd);
}

function replaceSpan(xml: string, span: ShapeSpan, replacement: string): string {
  return xml.slice(0, span.start) + replacement + xml.slice(span.end);
}

/**
 * Put `text` in a paragraph that currently reads `title`, wherever that title
 * is written in the XML.
 *
 * PowerPoint and Google Slides both split one visible line into several runs
 * whenever the formatting changes mid-line, and an author who bolded half a
 * song's name leaves it spread across two `<a:t>` elements. So the match is
 * made on the paragraph's whole text, and the replacement puts everything in
 * its first run and empties the others — the paragraph then reads exactly the
 * new title, with the first run's formatting.
 *
 * Any quote characters around the old title are kept around the new one, so a
 * deck that prints “Celebrate the Light” keeps printing the name in quotes.
 */
function retitleParagraphs(xml: string, oldTitle: string, title: string): string {
  const wanted = normalize(oldTitle);
  if (wanted.length < 2) return xml;
  return xml.replace(/<a:p>[\s\S]*?<\/a:p>/g, (paragraph) => {
    const text = runTexts(paragraph).join('').trim();
    const quoted = text.match(new RegExp(`^([${QUOTES}])\\s*([\\s\\S]+?)\\s*([${QUOTES}])$`));
    const bare = quoted ? quoted[2] : text;
    if (normalize(bare) !== wanted) return paragraph;
    const replacement = quoted ? `${quoted[1]}${title}${quoted[3]}` : title;
    let first = true;
    return paragraph.replace(/<a:t>[\s\S]*?<\/a:t>/g, () => {
      const run = first ? `<a:t>${xmlEscape(replacement)}</a:t>` : '<a:t></a:t>';
      first = false;
      return run;
    });
  });
}

export interface ConfessionBlock {
  /** 0-based position of the "공동체 고백" marker slide in presentation order. */
  markerIndex: number;
  /** Slide part names (e.g. "slide2.xml") of the marker's lyric slides. */
  lyricSlides: string[];
  /** Song name currently printed on the marker slide. */
  currentTitle: string;
}

/** Each `<a:p>` paragraph's text, in document order — one visible line each. */
function paragraphTexts(xml: string): string[] {
  return [...xml.matchAll(/<a:p>[\s\S]*?<\/a:p>/g)].map((match) =>
    runTexts(match[0]).join('').trim(),
  );
}

/**
 * The song name the marker slide prints: the line wrapped in quotes, else the
 * first line after the one that says 공동체 고백.
 */
function titleOnMarker(markerXml: string): string {
  const lines = paragraphTexts(markerXml);
  for (const line of lines) {
    const quoted = line.match(new RegExp(`^[${QUOTES}]\\s*([\\s\\S]+?)\\s*[${QUOTES}]$`));
    if (quoted && quoted[1].trim()) return quoted[1].trim();
  }
  const markerAt = lines.findIndex((line) => normalize(line).includes(CONFESSION_MARKER));
  for (const line of lines.slice(markerAt + 1)) {
    if (line) return line;
  }
  return '';
}

/**
 * Locate the 공동체 고백 block, or null when this deck has none (an
 * administrator-supplied back deck that does not carry the confession song).
 */
export async function findConfessionBlock(zip: JSZip): Promise<ConfessionBlock | null> {
  const names = await slideOrderOf(zip);
  const texts: string[] = [];
  for (const name of names) {
    const file = zip.file(`ppt/slides/${name}`);
    texts.push(file ? await file.async('string') : '');
  }

  const markerIndex = texts.findIndex((xml) =>
    normalize(runTexts(xml).join('')).includes(CONFESSION_MARKER),
  );
  if (markerIndex === -1) return null;

  const currentTitle = titleOnMarker(texts[markerIndex]);
  const wanted = normalize(currentTitle);
  const lyricSlides: string[] = [];
  if (wanted.length >= 2) {
    for (let i = markerIndex + 1; i < names.length; i++) {
      if (!normalize(runTexts(texts[i]).join('')).includes(wanted)) break;
      lyricSlides.push(names[i]);
    }
  }
  return { markerIndex, lyricSlides, currentTitle };
}

/** Lyric line groups for a song, one group per slide (no title slide). */
function lyricGroups(song: Song): string[][] {
  return planSlides(song)
    .filter((plan) => plan.kind === 'lyrics')
    .map((plan) => (plan.lines ?? []).filter((line) => line.trim().length > 0))
    .filter((lines) => lines.length > 0);
}

/**
 * One lyric slide, cloned from the block's own: the biggest text box holds the
 * lyrics, and any box that printed the old song's name now prints the new one.
 */
function buildLyricSlide(template: string, lines: string[], title: string, oldTitle: string): string {
  const shapes = shapesOf(template).filter((shape) => shape.xml.includes('<a:t>'));
  if (shapes.length === 0) throw new Error('가사 슬라이드에서 텍스트 상자를 찾지 못했습니다.');
  const body = shapes.reduce((biggest, shape) =>
    shapeArea(shape.xml) > shapeArea(biggest.xml) ? shape : biggest,
  );

  // The body is rewritten as a shape (its paragraph list changes); every other
  // box that named the old song — the corner label — is retitled in place.
  const xml = replaceSpan(template, body, setShapeLines(body.xml, lines));
  return retitleParagraphs(xml, oldTitle, title);
}

function maxSlideNumber(zip: JSZip): number {
  let max = 0;
  for (const path of Object.keys(zip.files)) {
    const match = path.match(/^ppt\/slides\/slide(\d+)\.xml$/);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return max;
}

export interface ConfessionResult {
  /** The deck — rewritten when `applied`, byte-for-byte the original when not. */
  data: Uint8Array;
  applied: boolean;
  /** Why the block was left alone, for the caller to surface or ignore. */
  reason?: 'no-block' | 'no-lyrics' | 'already-current' | 'failed';
  /** Song name the deck printed before the rewrite. */
  previousTitle?: string;
  /** How many lyric slides the block holds afterwards. */
  slideCount?: number;
}

/**
 * Print `song` in the back deck's 공동체 고백 block.
 *
 * The deck comes back untouched — never half-rewritten — when it has no such
 * block, when the song carries no lyrics, when the block already names this
 * song (the common case: the bundled deck and the default setting agree, so a
 * normal download is byte-identical to what it always was), and when the
 * block is written in some way this cannot follow. That last case is why the
 * work is wrapped: a back deck the rewrite chokes on must still go out with
 * its own confession slides rather than failing the week's PPT.
 */
export async function applyConfessionSong(
  deck: ArrayBuffer | Uint8Array,
  song: Song,
): Promise<ConfessionResult> {
  const original = deck instanceof Uint8Array ? deck : new Uint8Array(deck);
  try {
    return await rewriteConfessionBlock(original, song);
  } catch {
    return { data: original, applied: false, reason: 'failed' };
  }
}

async function rewriteConfessionBlock(original: Uint8Array, song: Song): Promise<ConfessionResult> {
  const groups = lyricGroups(song);
  if (!song.title.trim() || groups.length === 0) {
    return { data: original, applied: false, reason: 'no-lyrics' };
  }

  const zip = await JSZip.loadAsync(original);
  // Notes and comments never reach the projected deck (mergePptxDecks drops
  // them too), and dropping them here means a cloned slide's relationships
  // are just its layout — nothing that would have to be duplicated per slide.
  await stripNonVisualParts(zip);

  const block = await findConfessionBlock(zip);
  if (!block) return { data: original, applied: false, reason: 'no-block' };
  if (normalize(block.currentTitle) === normalize(song.title)) {
    return {
      data: original,
      applied: false,
      reason: 'already-current',
      previousTitle: block.currentTitle,
      slideCount: block.lyricSlides.length,
    };
  }
  if (block.lyricSlides.length === 0) {
    // No lyric slide to clone: rename the block and leave it at that rather
    // than inventing a slide design the deck never had.
    const names = await slideOrderOf(zip);
    const markerPath = `ppt/slides/${names[block.markerIndex]}`;
    const markerXml = await zip.file(markerPath)!.async('string');
    zip.file(markerPath, retitleParagraphs(markerXml, block.currentTitle, song.title));
    return {
      data: await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' }),
      applied: true,
      previousTitle: block.currentTitle,
      slideCount: 0,
    };
  }

  const names = await slideOrderOf(zip);
  const markerName = names[block.markerIndex];
  const templateName = block.lyricSlides[0];
  const templateXml = await zip.file(`ppt/slides/${templateName}`)!.async('string');
  const templateRelsFile = zip.file(`ppt/slides/_rels/${templateName}.rels`);
  const templateRels = templateRelsFile ? await templateRelsFile.async('string') : null;

  const slides = groups.map((lines) =>
    buildLyricSlide(templateXml, lines, song.title, block.currentTitle),
  );

  // Reuse the block's existing slide parts for as many slides as they cover,
  // so a deck whose confession song has the same slide count keeps exactly
  // the parts (and part names) it always had.
  const reused = Math.min(block.lyricSlides.length, slides.length);
  for (let i = 0; i < reused; i++) {
    zip.file(`ppt/slides/${block.lyricSlides[i]}`, slides[i]);
  }

  let contentTypes = await zip.file('[Content_Types].xml')!.async('string');
  let nextNumber = maxSlideNumber(zip) + 1;
  const addedNames: string[] = [];
  for (let i = reused; i < slides.length; i++) {
    const name = `slide${nextNumber++}.xml`;
    zip.file(`ppt/slides/${name}`, slides[i]);
    if (templateRels) zip.file(`ppt/slides/_rels/${name}.rels`, templateRels);
    contentTypes = setContentTypeOverride(contentTypes, `ppt/slides/${name}`, SLIDE_CONTENT_TYPE);
    addedNames.push(name);
  }
  const removedNames = block.lyricSlides.slice(slides.length);
  for (const name of removedNames) {
    zip.remove(`ppt/slides/${name}`);
    zip.remove(`ppt/slides/_rels/${name}.rels`);
    contentTypes = removeContentTypeOverride(contentTypes, `ppt/slides/${name}`);
  }

  const markerPath = `ppt/slides/${markerName}`;
  const markerXml = await zip.file(markerPath)!.async('string');
  zip.file(markerPath, retitleParagraphs(markerXml, block.currentTitle, song.title));

  const finalOrder = [
    ...names.slice(0, block.markerIndex + 1),
    ...block.lyricSlides.slice(0, reused),
    ...addedNames,
    ...names.slice(block.markerIndex + 1 + block.lyricSlides.length),
  ];

  const presentationPath = 'ppt/presentation.xml';
  const relsPath = 'ppt/_rels/presentation.xml.rels';
  let presentation = await zip.file(presentationPath)!.async('string');
  let presRels = await zip.file(relsPath)!.async('string');

  // Which relationship points at which slide, and which sldId each carries —
  // both are kept for every slide that survives, so nothing outside the block
  // sees its id change.
  const relIdOf = new Map<string, string>();
  for (const match of presRels.matchAll(/<Relationship\b[^>]*\/>/g)) {
    const id = match[0].match(/\sId="([^"]+)"/)?.[1];
    const target = match[0].match(/\sTarget="slides\/(slide\d+\.xml)"/)?.[1];
    if (id && target) relIdOf.set(target, id);
  }
  const sldIdOf = new Map<string, string>();
  let maxSldId = 255;
  const listSection = presentation.match(/<p:sldIdLst>([\s\S]*?)<\/p:sldIdLst>/);
  for (const match of (listSection?.[1] ?? '').matchAll(/<p:sldId\b[^>]*\/>/g)) {
    const id = match[0].match(/\sid="(\d+)"/)?.[1];
    const rid = match[0].match(/r:id="([^"]+)"/)?.[1];
    if (!id || !rid) continue;
    maxSldId = Math.max(maxSldId, Number(id));
    for (const [name, relId] of relIdOf) {
      if (relId === rid) sldIdOf.set(name, id);
    }
  }

  let maxRelNumber = 0;
  for (const match of presRels.matchAll(/\sId="rId(\d+)"/g)) {
    maxRelNumber = Math.max(maxRelNumber, Number(match[1]));
  }
  const newRels: string[] = [];
  for (const name of addedNames) {
    const relId = `rId${++maxRelNumber}`;
    relIdOf.set(name, relId);
    newRels.push(
      `<Relationship Id="${relId}" Type="${SLIDE_REL_TYPE}" Target="slides/${name}"/>`,
    );
  }
  for (const name of removedNames) {
    const relId = relIdOf.get(name);
    if (!relId) continue;
    presRels = presRels.replace(
      new RegExp(`<Relationship\\b[^>]*\\sId="${relId}"[^>]*/>`, 'g'),
      '',
    );
    relIdOf.delete(name);
  }
  if (newRels.length > 0) {
    presRels = presRels.replace('</Relationships>', `${newRels.join('')}</Relationships>`);
  }

  const sldIds = finalOrder
    .map((name) => {
      const relId = relIdOf.get(name);
      if (!relId) return '';
      const id = sldIdOf.get(name) ?? String(++maxSldId);
      return `<p:sldId id="${id}" r:id="${relId}"/>`;
    })
    .join('');
  presentation = presentation.replace(
    /<p:sldIdLst>[\s\S]*?<\/p:sldIdLst>/,
    `<p:sldIdLst>${sldIds}</p:sldIdLst>`,
  );

  zip.file(presentationPath, presentation);
  zip.file(relsPath, presRels);
  zip.file('[Content_Types].xml', contentTypes);

  return {
    data: await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' }),
    applied: true,
    previousTitle: block.currentTitle,
    slideCount: slides.length,
  };
}
