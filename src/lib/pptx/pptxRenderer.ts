// Renders the ACTUAL slides of a generated .pptx into lightweight preview
// data — real shape positions, text, and images extracted straight from the
// OOXML, not an approximation built from app state. Used by the 편집기 view
// so what's shown on the left is exactly what the download will contain.
//
// This is a from-scratch, narrowly-scoped OOXML reader (JSZip + DOMParser,
// both already relied on / built into the browser) rather than a third-party
// pptx-rendering package: every such package found was single-maintainer and
// days old with no track record, which is not something to add to a
// production dependency tree sight-unseen. A generic renderer only needs
// enough of DrawingML to cover text boxes and pictures, which is what every
// slide this app produces (and most uploaded sermon decks) actually use.
import JSZip from 'jszip';

const EMU_PER_POINT = 12700;

export interface RenderedRun {
  text: string;
  sizePt?: number;
  bold?: boolean;
  italic?: boolean;
  color?: string; // CSS color, e.g. "#112233"
}

export interface RenderedParagraph {
  align?: 'l' | 'ctr' | 'r';
  runs: RenderedRun[];
}

interface ShapeBase {
  xEmu: number;
  yEmu: number;
  wEmu: number;
  hEmu: number;
}

export interface RenderedTextShape extends ShapeBase {
  kind: 'text';
  fill?: string;
  paragraphs: RenderedParagraph[];
}

export interface RenderedPictureShape extends ShapeBase {
  kind: 'picture';
  imageUrl: string;
}

export type RenderedShape = RenderedTextShape | RenderedPictureShape;

export interface RenderedSlide {
  index: number;
  widthEmu: number;
  heightEmu: number;
  background?: string;
  shapes: RenderedShape[];
}

/** Rough, non-authoritative theme-color fallback — real fidelity would need
 * to resolve each slide's actual theme; this keeps common cases readable. */
const SCHEME_COLOR_FALLBACK: Record<string, string> = {
  bg1: '#ffffff',
  lt1: '#ffffff',
  tx1: '#000000',
  dk1: '#000000',
  bg2: '#eeeeee',
  lt2: '#eeeeee',
  tx2: '#333333',
  dk2: '#333333',
  accent1: '#4f46e5',
  accent2: '#2563eb',
  accent3: '#0891b2',
  accent4: '#059669',
  accent5: '#d97706',
  accent6: '#dc2626',
};

function firstEl(parent: Element | Document, tag: string): Element | null {
  return parent.getElementsByTagName(tag)[0] ?? null;
}

function allEls(parent: Element | Document, tag: string): Element[] {
  return Array.from(parent.getElementsByTagName(tag));
}

function parseXml(text: string): Document {
  return new DOMParser().parseFromString(text, 'application/xml');
}

/** Read a shape's <a:solidFill> as a CSS color, from srgbClr or (approximately) schemeClr. */
function readSolidFill(container: Element | null): string | undefined {
  const fill = container && firstEl(container, 'a:solidFill');
  if (!fill) return undefined;
  const srgb = firstEl(fill, 'a:srgbClr');
  if (srgb) {
    const val = srgb.getAttribute('val');
    return val ? `#${val}` : undefined;
  }
  const scheme = firstEl(fill, 'a:schemeClr');
  const val = scheme?.getAttribute('val');
  return val ? SCHEME_COLOR_FALLBACK[val] : undefined;
}

function readXfrm(spPr: Element | null): ShapeBase | null {
  const xfrm = spPr && firstEl(spPr, 'a:xfrm');
  if (!xfrm) return null;
  const off = firstEl(xfrm, 'a:off');
  const ext = firstEl(xfrm, 'a:ext');
  if (!off || !ext) return null;
  const xEmu = Number(off.getAttribute('x'));
  const yEmu = Number(off.getAttribute('y'));
  const wEmu = Number(ext.getAttribute('cx'));
  const hEmu = Number(ext.getAttribute('cy'));
  if (![xEmu, yEmu, wEmu, hEmu].every(Number.isFinite)) return null;
  return { xEmu, yEmu, wEmu, hEmu };
}

function readAlign(pPr: Element | null): RenderedParagraph['align'] {
  const algn = pPr?.getAttribute('algn');
  if (algn === 'ctr' || algn === 'r' || algn === 'l') return algn;
  return undefined;
}

function readTextShape(sp: Element, box: ShapeBase): RenderedTextShape | null {
  const spPr = firstEl(sp, 'p:spPr');
  const txBody = firstEl(sp, 'p:txBody');
  const fill = readSolidFill(spPr);
  if (!txBody) return fill ? { kind: 'text', ...box, fill, paragraphs: [] } : null;

  const paragraphs: RenderedParagraph[] = [];
  for (const p of allEls(txBody, 'a:p')) {
    const align = readAlign(firstEl(p, 'a:pPr'));
    const runs: RenderedRun[] = [];
    for (const r of allEls(p, 'a:r')) {
      const t = firstEl(r, 'a:t');
      const text = t?.textContent ?? '';
      if (!text) continue;
      const rPr = firstEl(r, 'a:rPr');
      const szAttr = rPr?.getAttribute('sz');
      runs.push({
        text,
        sizePt: szAttr ? Number(szAttr) / 100 : undefined,
        bold: rPr?.getAttribute('b') === '1',
        italic: rPr?.getAttribute('i') === '1',
        color: readSolidFill(rPr),
      });
    }
    if (runs.length > 0 || paragraphs.length > 0) paragraphs.push({ align, runs });
  }
  if (paragraphs.length === 0 && !fill) return null;
  return { kind: 'text', ...box, fill, paragraphs };
}

/** Map a slide's r:embed relationship id to the actual (possibly renamed) media part path. */
function readSlideRelTargets(relsXml: string | null): Map<string, string> {
  const map = new Map<string, string>();
  if (!relsXml) return map;
  const doc = parseXml(relsXml);
  for (const rel of allEls(doc.documentElement, 'Relationship')) {
    const id = rel.getAttribute('Id');
    const target = rel.getAttribute('Target');
    if (id && target) map.set(id, target);
  }
  return map;
}

async function readPictureShape(
  pic: Element,
  box: ShapeBase,
  zip: JSZip,
  relTargets: Map<string, string>,
  urlCache: Map<string, string>,
): Promise<RenderedPictureShape | null> {
  const blip = firstEl(pic, 'a:blip');
  const rEmbed = blip?.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'embed');
  if (!rEmbed) return null;
  const target = relTargets.get(rEmbed);
  if (!target) return null;
  const mediaPath = target.startsWith('/') ? target.slice(1) : `ppt/${target.replace(/^\.\.\//, '')}`;
  let url = urlCache.get(mediaPath);
  if (!url) {
    const file = zip.file(mediaPath);
    if (!file) return null;
    const bytes = await file.async('blob');
    url = URL.createObjectURL(bytes);
    urlCache.set(mediaPath, url);
  }
  return { kind: 'picture', ...box, imageUrl: url };
}

/** Resolve a deck's slide part paths in presentation display order via sldIdLst + rels. */
function slideOrderPaths(presentationXml: string, presentationRels: string): string[] {
  const presDoc = parseXml(presentationXml);
  const relsDoc = parseXml(presentationRels);
  const relTargets = new Map<string, string>();
  for (const rel of allEls(relsDoc.documentElement, 'Relationship')) {
    const id = rel.getAttribute('Id');
    const target = rel.getAttribute('Target');
    if (id && target) relTargets.set(id, target);
  }
  const sldIdLst = firstEl(presDoc.documentElement, 'p:sldIdLst');
  if (!sldIdLst) return [];
  const paths: string[] = [];
  for (const sldId of allEls(sldIdLst, 'p:sldId')) {
    const rId = sldId.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id');
    const target = rId ? relTargets.get(rId) : null;
    if (target) paths.push(`ppt/${target.replace(/^\.\.\//, '')}`);
  }
  return paths;
}

/**
 * Parse a generated .pptx and return real per-slide preview data: exact
 * shape positions/sizes, text runs, and embedded images, straight from the
 * bytes that will actually be downloaded.
 *
 * Object URLs created for embedded images are cached per call and must be
 * released by the caller (via `revokeRenderedSlides`) once no longer shown.
 */
export async function renderPptxSlides(data: ArrayBuffer | Uint8Array): Promise<RenderedSlide[]> {
  const zip = await JSZip.loadAsync(data);
  const presentationXml = await zip.file('ppt/presentation.xml')!.async('string');
  const presentationRels = await zip.file('ppt/_rels/presentation.xml.rels')!.async('string');
  const presDoc = parseXml(presentationXml);
  const sldSz = firstEl(presDoc.documentElement, 'p:sldSz');
  const widthEmu = Number(sldSz?.getAttribute('cx')) || 12192000;
  const heightEmu = Number(sldSz?.getAttribute('cy')) || 6858000;

  const slidePaths = slideOrderPaths(presentationXml, presentationRels);
  const urlCache = new Map<string, string>();

  const slides: RenderedSlide[] = [];
  for (let index = 0; index < slidePaths.length; index++) {
    const path = slidePaths[index];
    const file = zip.file(path);
    if (!file) {
      slides.push({ index, widthEmu, heightEmu, shapes: [] });
      continue;
    }
    const slideXml = await file.async('string');
    const relsPath = `${path.slice(0, path.lastIndexOf('/'))}/_rels/${path.slice(path.lastIndexOf('/') + 1)}.rels`;
    const relsFile = zip.file(relsPath);
    const relsXml = relsFile ? await relsFile.async('string') : null;
    const relTargets = readSlideRelTargets(relsXml);

    const doc = parseXml(slideXml);
    const cSld = firstEl(doc.documentElement, 'p:cSld');
    const bg = cSld && firstEl(cSld, 'p:bg');
    const background = bg ? readSolidFill(firstEl(bg, 'p:bgPr')) : undefined;

    const spTree = cSld && firstEl(cSld, 'p:spTree');
    const shapes: RenderedShape[] = [];
    if (spTree) {
      for (const child of Array.from(spTree.children)) {
        const box = readXfrm(firstEl(child, 'p:spPr'));
        if (!box) continue;
        if (child.tagName === 'p:sp') {
          const shape = readTextShape(child, box);
          if (shape) shapes.push(shape);
        } else if (child.tagName === 'p:pic') {
          const shape = await readPictureShape(child, box, zip, relTargets, urlCache);
          if (shape) shapes.push(shape);
        }
      }
    }
    slides.push({ index, widthEmu, heightEmu, background, shapes });
  }
  return slides;
}

/** Release every object URL a renderPptxSlides() call created. */
export function revokeRenderedSlides(slides: RenderedSlide[]): void {
  const seen = new Set<string>();
  for (const slide of slides) {
    for (const shape of slide.shapes) {
      if (shape.kind === 'picture' && !seen.has(shape.imageUrl)) {
        seen.add(shape.imageUrl);
        URL.revokeObjectURL(shape.imageUrl);
      }
    }
  }
}

export function emuToPx(emu: number, pxPerEmu: number): number {
  return emu * pxPerEmu;
}

export function ptToPx(pt: number, pxPerEmu: number): number {
  return pt * EMU_PER_POINT * pxPerEmu;
}
