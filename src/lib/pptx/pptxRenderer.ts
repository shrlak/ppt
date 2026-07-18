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
//
// A slide built from scratch (this app's own templates, all Google-Slides
// exports) bakes an explicit position/size/font onto every shape. A slide
// from a real PowerPoint deck (an admin-uploaded Front/Back replacement)
// commonly does neither: its title/content text is a PLACEHOLDER that only
// says "I'm the title" and inherits its actual position, size, and font from
// the slide's layout (and the layout in turn from the master) — exactly how
// PowerPoint itself composites master → layout → slide. Skipping that
// inheritance is what made such decks render squished/mispositioned, so
// readSpTreeShapes/readTextShape below resolve it explicitly.
import JSZip from 'jszip';

const EMU_PER_POINT = 12700;

export interface RenderedRun {
  text: string;
  sizePt?: number;
  bold?: boolean;
  italic?: boolean;
  color?: string; // CSS color, e.g. "#112233"
  /** Resolved from the run's own typeface, or the theme's major/minor Latin font for a +mj-lt/+mn-lt reference. */
  fontFamily?: string;
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

/** A part's own Target is relative to its parent directory; every part this
 * reader visits (slides, slideLayouts, slideMasters, media, themes) lives
 * exactly one directory below `ppt/`, so a single `../` strip always
 * resolves it. */
function resolvePartTarget(target: string): string {
  return target.startsWith('/') ? target.slice(1) : `ppt/${target.replace(/^\.\.\//, '')}`;
}

function relsPathFor(partPath: string): string {
  const slash = partPath.lastIndexOf('/');
  return `${partPath.slice(0, slash)}/_rels/${partPath.slice(slash + 1)}.rels`;
}

/** Find the Target of the first relationship whose Type ends with `typeSuffix` (e.g. "/slideLayout"). */
function findRelTarget(relsXml: string, typeSuffix: string): string | null {
  const doc = parseXml(relsXml);
  for (const rel of allEls(doc.documentElement, 'Relationship')) {
    if (rel.getAttribute('Type')?.endsWith(typeSuffix)) {
      return rel.getAttribute('Target');
    }
  }
  return null;
}

/** A shape only counts as slide-specific content if it fills a layout/master placeholder. */
function isPlaceholder(shapeEl: Element): boolean {
  return shapeEl.getElementsByTagName('p:ph').length > 0;
}

interface PlaceholderKey {
  type: string;
  idx: string | null;
}

/** A shape's placeholder identity (type + idx), used to find its counterpart on the layout/master. */
function readPlaceholderKey(shapeEl: Element): PlaceholderKey | null {
  const ph = shapeEl.getElementsByTagName('p:ph')[0];
  if (!ph) return null;
  return { type: ph.getAttribute('type') ?? 'body', idx: ph.getAttribute('idx') };
}

/** Placeholder types templates commonly re-type loosely across a body/subtitle/content family. */
const BODY_LIKE_TYPES = new Set(['body', 'subTitle', 'obj', 'txBox']);

/**
 * Find the layout/master placeholder a slide placeholder inherits from:
 * exact idx match first (OOXML's real matching key), then same type, then
 * any other body-like placeholder.
 */
function findMatchingPlaceholder(spTree: Element | null, key: PlaceholderKey): Element | null {
  if (!spTree) return null;
  const candidates = Array.from(spTree.children).filter(isPlaceholder);
  if (key.idx) {
    const byIdx = candidates.find((c) => readPlaceholderKey(c)?.idx === key.idx);
    if (byIdx) return byIdx;
  }
  const byType = candidates.find((c) => (readPlaceholderKey(c)?.type ?? 'body') === key.type);
  if (byType) return byType;
  if (BODY_LIKE_TYPES.has(key.type)) {
    return candidates.find((c) => BODY_LIKE_TYPES.has(readPlaceholderKey(c)?.type ?? 'body')) ?? null;
  }
  return null;
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

/**
 * A shape's box: its own <a:xfrm> when present, otherwise (for a
 * placeholder only) the matching layout placeholder's box, then the
 * matching master placeholder's box — the same fallback chain PowerPoint
 * itself uses, so a placeholder that only exists to inherit its geometry
 * still lands in the right place instead of being skipped.
 */
function resolveBox(shapeEl: Element, layoutSpTree: Element | null, masterSpTree: Element | null): ShapeBase | null {
  const own = readXfrm(firstEl(shapeEl, 'p:spPr'));
  if (own) return own;
  const key = readPlaceholderKey(shapeEl);
  if (!key) return null;
  const layoutMatch = findMatchingPlaceholder(layoutSpTree, key);
  const fromLayout = layoutMatch && readXfrm(firstEl(layoutMatch, 'p:spPr'));
  if (fromLayout) return fromLayout;
  const masterMatch = findMatchingPlaceholder(masterSpTree, key);
  return (masterMatch && readXfrm(firstEl(masterMatch, 'p:spPr'))) ?? null;
}

interface ThemeFonts {
  major?: string;
  minor?: string;
}

/** Resolve a run's actual typeface: a literal font name as-is, or the theme's major/minor Latin font for +mj-lt/+mn-lt. */
function resolveFontFamily(rPr: Element | null, themeFonts: ThemeFonts): string | undefined {
  const typeface = rPr && firstEl(rPr, 'a:latin')?.getAttribute('typeface');
  if (!typeface) return undefined;
  if (typeface === '+mj-lt') return themeFonts.major;
  if (typeface === '+mn-lt') return themeFonts.minor;
  return typeface;
}

function styleBucketFor(placeholderType: string): 'p:titleStyle' | 'p:bodyStyle' | 'p:otherStyle' {
  if (placeholderType === 'title' || placeholderType === 'ctrTitle') return 'p:titleStyle';
  if (BODY_LIKE_TYPES.has(placeholderType)) return 'p:bodyStyle';
  return 'p:otherStyle';
}

/** Master-level default run size for a placeholder type, from p:txStyles/*Style/lvl1pPr/defRPr@sz. */
function resolveMasterDefaultFontPt(masterDoc: Document | null, placeholderType: string): number | undefined {
  const txStyles = masterDoc && firstEl(masterDoc.documentElement, 'p:txStyles');
  const bucket = txStyles && firstEl(txStyles, styleBucketFor(placeholderType));
  const lvl1 = bucket && firstEl(bucket, 'a:lvl1pPr');
  const sz = lvl1 && firstEl(lvl1, 'a:defRPr')?.getAttribute('sz');
  return sz ? Number(sz) / 100 : undefined;
}

/** A layout placeholder's own run size, when the layout gives its prompt text an explicit size. */
function resolveLayoutPlaceholderFontPt(layoutMatch: Element | null): number | undefined {
  if (!layoutMatch) return undefined;
  const rPr = layoutMatch.getElementsByTagName('a:rPr')[0] ?? layoutMatch.getElementsByTagName('a:defRPr')[0];
  const sz = rPr?.getAttribute('sz');
  return sz ? Number(sz) / 100 : undefined;
}

function readAlign(pPr: Element | null): RenderedParagraph['align'] {
  const algn = pPr?.getAttribute('algn');
  if (algn === 'ctr' || algn === 'r' || algn === 'l') return algn;
  return undefined;
}

/** Inherited context a placeholder shape's text falls back to when it doesn't set something itself. */
interface TextInheritContext {
  placeholderKey: PlaceholderKey | null;
  layoutMatch: Element | null;
  masterDoc: Document | null;
  themeFonts: ThemeFonts;
}

const NO_INHERIT: TextInheritContext = { placeholderKey: null, layoutMatch: null, masterDoc: null, themeFonts: {} };

function readTextShape(sp: Element, box: ShapeBase, ctx: TextInheritContext): RenderedTextShape | null {
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
      const sizePt = szAttr
        ? Number(szAttr) / 100
        : (ctx.placeholderKey &&
            (resolveLayoutPlaceholderFontPt(ctx.layoutMatch) ??
              resolveMasterDefaultFontPt(ctx.masterDoc, ctx.placeholderKey.type))) ||
          undefined;
      runs.push({
        text,
        sizePt,
        bold: rPr?.getAttribute('b') === '1',
        italic: rPr?.getAttribute('i') === '1',
        color: readSolidFill(rPr),
        fontFamily: resolveFontFamily(rPr, ctx.themeFonts),
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
  const mediaPath = resolvePartTarget(target);
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

/** Geometry/font inheritance sources for a spTree's placeholder shapes — undefined when reading a layout/master's own (non-placeholder) art, which never needs it. */
interface InheritSources {
  layoutSpTree: Element | null;
  masterSpTree: Element | null;
  masterDoc: Document | null;
  themeFonts: ThemeFonts;
}

/** Read every `p:sp`/`p:pic` child of a `p:spTree` into shapes, in document order. */
async function readSpTreeShapes(
  spTree: Element,
  zip: JSZip,
  relTargets: Map<string, string>,
  urlCache: Map<string, string>,
  skipPlaceholders: boolean,
  inherit?: InheritSources,
): Promise<RenderedShape[]> {
  const shapes: RenderedShape[] = [];
  for (const child of Array.from(spTree.children)) {
    if (skipPlaceholders && isPlaceholder(child)) continue;
    const box = inherit
      ? resolveBox(child, inherit.layoutSpTree, inherit.masterSpTree)
      : readXfrm(firstEl(child, 'p:spPr'));
    if (!box) continue;
    if (child.tagName === 'p:sp') {
      const key = readPlaceholderKey(child);
      const ctx: TextInheritContext =
        inherit && key
          ? {
              placeholderKey: key,
              layoutMatch: findMatchingPlaceholder(inherit.layoutSpTree, key),
              masterDoc: inherit.masterDoc,
              themeFonts: inherit.themeFonts,
            }
          : { ...NO_INHERIT, themeFonts: inherit?.themeFonts ?? {} };
      const shape = readTextShape(child, box, ctx);
      if (shape) shapes.push(shape);
    } else if (child.tagName === 'p:pic') {
      const shape = await readPictureShape(child, box, zip, relTargets, urlCache);
      if (shape) shapes.push(shape);
    }
  }
  return shapes;
}

interface StaticLayer {
  background?: string;
  shapes: RenderedShape[];
  spTree: Element | null;
  doc: Document | null;
}

/**
 * Read a slideLayout or slideMaster part for the static art every slide
 * using it inherits: its background (when the slide doesn't set its own)
 * and any non-placeholder shapes/pictures (logos, watermarks) — matching
 * how PowerPoint actually composites a slide over its layout over its
 * master. Placeholders are skipped here: their content lives on the slide
 * itself, inheriting this part's placeholder geometry/fonts (resolved
 * separately by resolveInheritance) rather than being drawn twice.
 */
async function readStaticLayer(zip: JSZip, partPath: string, urlCache: Map<string, string>): Promise<StaticLayer> {
  const file = zip.file(partPath);
  if (!file) return { shapes: [], spTree: null, doc: null };
  const xml = await file.async('string');
  const doc = parseXml(xml);
  const cSld = firstEl(doc.documentElement, 'p:cSld');
  const bg = cSld && firstEl(cSld, 'p:bg');
  const background = bg ? readSolidFill(firstEl(bg, 'p:bgPr')) : undefined;

  const relsFile = zip.file(relsPathFor(partPath));
  const relsXml = relsFile ? await relsFile.async('string') : null;
  const relTargets = readSlideRelTargets(relsXml);

  const spTree = cSld && firstEl(cSld, 'p:spTree');
  const shapes = spTree ? await readSpTreeShapes(spTree, zip, relTargets, urlCache, true) : [];
  return { background, shapes, spTree, doc };
}

async function resolveThemeFonts(zip: JSZip, masterPath: string): Promise<ThemeFonts> {
  const relsFile = zip.file(relsPathFor(masterPath));
  const relsXml = relsFile ? await relsFile.async('string') : null;
  const themeTarget = relsXml ? findRelTarget(relsXml, '/theme') : null;
  if (!themeTarget) return {};
  const themeFile = zip.file(resolvePartTarget(themeTarget));
  if (!themeFile) return {};
  const doc = parseXml(await themeFile.async('string'));
  const fontScheme = firstEl(doc.documentElement, 'a:fontScheme');
  const major = fontScheme && firstEl(fontScheme, 'a:majorFont');
  const minor = fontScheme && firstEl(fontScheme, 'a:minorFont');
  return {
    major: (major && firstEl(major, 'a:latin')?.getAttribute('typeface')) || undefined,
    minor: (minor && firstEl(minor, 'a:latin')?.getAttribute('typeface')) || undefined,
  };
}

interface Inheritance {
  /** Master then layout, for background + static-shape composition (master furthest back). */
  layers: StaticLayer[];
  layoutSpTree: Element | null;
  masterSpTree: Element | null;
  masterDoc: Document | null;
  themeFonts: ThemeFonts;
}

const EMPTY_INHERITANCE: Inheritance = {
  layers: [],
  layoutSpTree: null,
  masterSpTree: null,
  masterDoc: null,
  themeFonts: {},
};

/** Resolve everything a slide inherits from its slideLayout and slideMaster — cached by path since many slides share one layout. */
async function resolveInheritance(
  zip: JSZip,
  ownRelsXml: string | null,
  urlCache: Map<string, string>,
  layerCache: Map<string, Promise<StaticLayer>>,
  themeCache: Map<string, Promise<ThemeFonts>>,
): Promise<Inheritance> {
  const layoutTarget = ownRelsXml ? findRelTarget(ownRelsXml, '/slideLayout') : null;
  if (!layoutTarget) return EMPTY_INHERITANCE;
  const layoutPath = resolvePartTarget(layoutTarget);
  let layoutLayerP = layerCache.get(layoutPath);
  if (!layoutLayerP) {
    layoutLayerP = readStaticLayer(zip, layoutPath, urlCache);
    layerCache.set(layoutPath, layoutLayerP);
  }
  const layoutLayer = await layoutLayerP;

  const layoutRelsFile = zip.file(relsPathFor(layoutPath));
  const layoutRelsXml = layoutRelsFile ? await layoutRelsFile.async('string') : null;
  const masterTarget = layoutRelsXml ? findRelTarget(layoutRelsXml, '/slideMaster') : null;
  if (!masterTarget) {
    return { layers: [layoutLayer], layoutSpTree: layoutLayer.spTree, masterSpTree: null, masterDoc: null, themeFonts: {} };
  }
  const masterPath = resolvePartTarget(masterTarget);
  let masterLayerP = layerCache.get(masterPath);
  if (!masterLayerP) {
    masterLayerP = readStaticLayer(zip, masterPath, urlCache);
    layerCache.set(masterPath, masterLayerP);
  }
  const masterLayer = await masterLayerP;

  let themeP = themeCache.get(masterPath);
  if (!themeP) {
    themeP = resolveThemeFonts(zip, masterPath);
    themeCache.set(masterPath, themeP);
  }
  const themeFonts = await themeP;

  return {
    layers: [masterLayer, layoutLayer], // master furthest back, then layout, so the slide's own content ends up on top.
    layoutSpTree: layoutLayer.spTree,
    masterSpTree: masterLayer.spTree,
    masterDoc: masterLayer.doc,
    themeFonts,
  };
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
  const layerCache = new Map<string, Promise<StaticLayer>>();
  const themeCache = new Map<string, Promise<ThemeFonts>>();

  const slides: RenderedSlide[] = [];
  for (let index = 0; index < slidePaths.length; index++) {
    const path = slidePaths[index];
    const file = zip.file(path);
    if (!file) {
      slides.push({ index, widthEmu, heightEmu, shapes: [] });
      continue;
    }
    const slideXml = await file.async('string');
    const relsFile = zip.file(relsPathFor(path));
    const relsXml = relsFile ? await relsFile.async('string') : null;
    const relTargets = readSlideRelTargets(relsXml);
    const inheritance = await resolveInheritance(zip, relsXml, urlCache, layerCache, themeCache);

    const doc = parseXml(slideXml);
    const cSld = firstEl(doc.documentElement, 'p:cSld');
    const bg = cSld && firstEl(cSld, 'p:bg');
    const ownBackground = bg ? readSolidFill(firstEl(bg, 'p:bgPr')) : undefined;
    const background = ownBackground ?? inheritance.layers.find((l) => l.background)?.background;

    const spTree = cSld && firstEl(cSld, 'p:spTree');
    const ownShapes = spTree
      ? await readSpTreeShapes(spTree, zip, relTargets, urlCache, false, {
          layoutSpTree: inheritance.layoutSpTree,
          masterSpTree: inheritance.masterSpTree,
          masterDoc: inheritance.masterDoc,
          themeFonts: inheritance.themeFonts,
        })
      : [];
    const shapes = [...inheritance.layers.flatMap((l) => l.shapes), ...ownShapes];
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
