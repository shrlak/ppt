// A 수요예배 song's own PPT, the way this church puts it up: with the 악보 on
// its slides, on a plain white slide.
//
// One song is shared in several versions — 가사 only or with the 악보, on a
// photo background or 무배경 — and a post does not always say which file is
// which. So a downloaded deck is looked at before it is attached: one with no
// 악보 on its slides is refused, and the next hit (or the 악보 사진) is tried
// instead. Whatever background a deck arrives with is taken off when the
// service deck is built, uploaded decks included.
//
// "The 악보" is pictures: a sheet is always an image on the slide (one full
// page, or a line per picture), and a 가사 PPT is text. "The background" is
// what sits behind it — the slide's own fill or picture, the layout's and the
// master's, or a photo someone inserted and sent to the back on every slide.
import JSZip from 'jszip';
import { slideOrderOf } from '../lib/pptx/pptxSlices';
import { matchingCloseIndex, readSlideSizeOf, type SlideSize } from '../lib/pptx/slideGeometry';

/** The share of a slide pictures must cover for it to be a 악보 page. */
const SHEET_AREA = 0.1;
/** A picture covering this much of both axes fills the slide. */
const FULL_SLIDE = 0.95;

const WHITE_BACKGROUND =
  '<p:bg><p:bgPr><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill><a:effectLst/></p:bgPr></p:bg>';

/** Text 1 on dark 1, as on a plain white slide, whatever the master maps. */
const STANDARD_COLOR_MAP =
  '<p:clrMapOvr><a:overrideClrMapping bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" ' +
  'accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" ' +
  'hlink="hlink" folHlink="folHlink"/></p:clrMapOvr>';

const DARK_FILL = '<a:solidFill><a:srgbClr val="000000"/></a:solidFill>';

const RELATIONSHIPS_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

interface Box {
  x: number;
  y: number;
  cx: number;
  cy: number;
}

/** One top-level shape of a slide's tree, where it sits in the slide's XML. */
interface Shape {
  start: number;
  end: number;
  tag: string;
  /** The picture it shows, as its relationship's target, when it shows one. */
  image?: string;
  box?: Box;
}

interface Slide {
  path: string;
  xml: string;
  shapes: Shape[];
  /** The picture the slide's own `<p:bg>` shows, when it shows one. */
  background?: { image: string; rId: string };
}

interface Analysis {
  size: SlideSize;
  slides: Slide[];
  /** Per slide: its bottom shape is a background photo inserted as a picture. */
  backgroundShape: boolean[];
  /** Per slide: its `<p:bg>` picture is the slide's 악보, not decoration. */
  backgroundIsSheet: boolean[];
  /** Per slide: the share of it the 악보 covers (may exceed 1). */
  sheetShare: number[];
}

function relationshipTargets(relsXml: string | null): Map<string, string> {
  const targets = new Map<string, string>();
  for (const [tag] of (relsXml ?? '').matchAll(/<Relationship\b[^>]*>/g)) {
    const id = tag.match(/\bId="([^"]+)"/)?.[1];
    const target = tag.match(/\bTarget="([^"]+)"/)?.[1];
    if (id && target && !/\bTargetMode="External"/.test(tag)) targets.set(id, target);
  }
  return targets;
}

function embeddedImage(xml: string, targets: Map<string, string>): { image: string; rId: string } | undefined {
  const rId = xml.match(/<a:blip\b[^>]*?\br:embed="([^"]+)"/)?.[1];
  return rId ? { image: targets.get(rId) ?? rId, rId } : undefined;
}

/** A shape's own position and size: its first transform. */
function boxOf(xml: string): Box | undefined {
  const xfrm = xml.match(/<(a|p):xfrm\b[^>]*>([\s\S]*?)<\/\1:xfrm>/)?.[2];
  const off = xfrm?.match(/<a:off\b[^>]*>/)?.[0];
  const ext = xfrm?.match(/<a:ext\b[^>]*>/)?.[0];
  const x = Number(off?.match(/\bx="(-?\d+)"/)?.[1]);
  const y = Number(off?.match(/\by="(-?\d+)"/)?.[1]);
  const cx = Number(ext?.match(/\bcx="(\d+)"/)?.[1]);
  const cy = Number(ext?.match(/\bcy="(\d+)"/)?.[1]);
  if (![x, y, cx, cy].every(Number.isFinite)) return undefined;
  return { x, y, cx, cy };
}

/** How much of the slide a box covers, per axis, 0..1. */
function coverage(box: Box, size: SlideSize): { x: number; y: number } {
  const span = (start: number, length: number, total: number) =>
    Math.max(0, Math.min(total, start + length) - Math.max(0, start)) / total;
  return { x: span(box.x, box.cx, size.cx), y: span(box.y, box.cy, size.cy) };
}

const TOP_LEVEL = /<(p:sp|p:pic|p:graphicFrame|p:grpSp|p:cxnSp|p:contentPart|mc:AlternateContent)\b/g;

/** The shapes directly in the slide's tree, bottom first. */
function topLevelShapes(xml: string, targets: Map<string, string>): Shape[] {
  const treeStart = xml.indexOf('<p:spTree>');
  const treeEnd = xml.lastIndexOf('</p:spTree>');
  if (treeStart === -1 || treeEnd === -1) return [];
  const shapes: Shape[] = [];
  const pattern = new RegExp(TOP_LEVEL.source, 'g');
  pattern.lastIndex = treeStart;
  for (let match = pattern.exec(xml); match && match.index < treeEnd; match = pattern.exec(xml)) {
    const end = matchingCloseIndex(xml, match.index, match[1]);
    const shapeXml = xml.slice(match.index, end);
    shapes.push({
      start: match.index,
      end,
      tag: match[1],
      image: embeddedImage(shapeXml, targets)?.image,
      box: boxOf(shapeXml),
    });
    pattern.lastIndex = end;
  }
  return shapes;
}

/** The picture a slide's bottom shape shows when that shape fills the slide and something sits on it. */
function bottomFullPicture(slide: Slide, size: SlideSize): string | undefined {
  const [bottom, ...above] = slide.shapes;
  if (!bottom || above.length === 0 || bottom.tag !== 'p:pic' || !bottom.image || !bottom.box) return undefined;
  const { x, y } = coverage(bottom.box, size);
  return x >= FULL_SLIDE && y >= FULL_SLIDE ? bottom.image : undefined;
}

function countOf(values: (string | undefined)[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) if (value) counts.set(value, (counts.get(value) ?? 0) + 1);
  return counts;
}

async function analyze(zip: JSZip): Promise<Analysis> {
  const size = readSlideSizeOf(await zip.file('ppt/presentation.xml')!.async('string'));
  const slides: Slide[] = [];
  for (const name of await slideOrderOf(zip)) {
    const path = `ppt/slides/${name}`;
    const file = zip.file(path);
    if (!file) continue;
    const xml = await file.async('string');
    const targets = relationshipTargets((await zip.file(`ppt/slides/_rels/${name}.rels`)?.async('string')) ?? null);
    const bg = xml.match(/<p:bg\b[^>]*>[\s\S]*?<\/p:bg>/)?.[0];
    slides.push({
      path,
      xml,
      shapes: topLevelShapes(xml, targets),
      background: bg ? embeddedImage(bg, targets) : undefined,
    });
  }

  // A photo under everything, the same one on most slides, is a background
  // someone inserted as a picture — a 악보 page is not the same on every slide.
  const bottoms = slides.map((slide) => bottomFullPicture(slide, size));
  const bottomCounts = countOf(bottoms);
  const backgroundShape = bottoms.map(
    (image) => !!image && (bottomCounts.get(image) ?? 0) >= 2 && bottomCounts.get(image)! * 2 > slides.length,
  );

  const pictureShare = slides.map((slide, index) =>
    slide.shapes.reduce((share, shape, position) => {
      if (!shape.image || (position === 0 && backgroundShape[index])) return share;
      if (!shape.box) return share + 1;
      const { x, y } = coverage(shape.box, size);
      return share + x * y;
    }, 0),
  );

  // A slide can carry its 악보 as its own background picture ("배경 서식 →
  // 그림"). One used by that slide alone, on a slide with no 악보 of its own,
  // is the page itself and has to stay.
  const backgroundCounts = countOf(slides.map((slide) => slide.background?.image));
  const backgroundIsSheet = slides.map(
    (slide, index) =>
      !!slide.background &&
      backgroundCounts.get(slide.background.image) === 1 &&
      pictureShare[index] < SHEET_AREA,
  );

  return {
    size,
    slides,
    backgroundShape,
    backgroundIsSheet,
    sheetShare: pictureShare.map((share, index) => share + (backgroundIsSheet[index] ? 1 : 0)),
  };
}

/**
 * True when a deck carries its 악보: pictures over a tenth of the slide or
 * more on at least half of its slides (a title slide or a blank end one
 * aside). A 가사 PPT has only text, whatever it has behind it.
 */
export async function hasSheetMusic(data: ArrayBuffer | Uint8Array): Promise<boolean> {
  const { sheetShare } = await analyze(await JSZip.loadAsync(data));
  const sheets = sheetShare.filter((share) => share >= SHEET_AREA).length;
  return sheets > 0 && sheets * 2 >= sheetShare.length;
}

function isLightColor(colorXml: string): boolean {
  const hex =
    colorXml.match(/<a:srgbClr\b[^>]*?\bval="([0-9A-Fa-f]{6})"/)?.[1] ??
    colorXml.match(/<a:sysClr\b[^>]*?\blastClr="([0-9A-Fa-f]{6})"/)?.[1];
  if (hex) {
    const [r, g, b] = [0, 2, 4].map((at) => parseInt(hex.slice(at, at + 2), 16) / 255);
    return 0.2126 * r + 0.7152 * g + 0.0722 * b >= 0.8;
  }
  const scheme = colorXml.match(/<a:schemeClr\b[^>]*?\bval="([^"]+)"/)?.[1];
  if (scheme) return scheme === 'bg1' || scheme === 'lt1';
  return /<a:prstClr\b[^>]*?\bval="white"/.test(colorXml);
}

/** True when a shape paints its own fill, so its text is read against that, not the slide. */
function hasOwnFill(shapeXml: string): boolean {
  const spPr = (shapeXml.match(/<p:spPr\b[^>]*>([\s\S]*?)<\/p:spPr>/)?.[1] ?? '')
    // The outline's colour is not a fill.
    .replace(/<a:ln\b[^>]*\/>|<a:ln\b[^>]*>[\s\S]*?<\/a:ln>/g, '');
  if (/<a:(solidFill|gradFill|blipFill|pattFill|grpFill)\b/.test(spPr)) return true;
  if (/<a:noFill\b/.test(spPr)) return false;
  const fillRef = shapeXml.match(/<a:fillRef\b[^>]*?\bidx="(\d+)"/)?.[1];
  return fillRef !== undefined && fillRef !== '0';
}

/**
 * White text written for a dark background would vanish on a white one, so
 * text in a light colour is made black — only where it sits on the slide
 * itself, never in a button or box that paints its own fill.
 */
function darkenLightText(xml: string): string {
  return xml.replace(/<p:sp(?:\s[^>]*)?>[\s\S]*?<\/p:sp>/g, (shape) =>
    hasOwnFill(shape)
      ? shape
      : shape.replace(/<a:(rPr|defRPr|endParaRPr)\b[^>]*?(?:\/>|>[\s\S]*?<\/a:\1>)/g, (props) =>
          props.replace(/<a:solidFill>([\s\S]*?)<\/a:solidFill>/g, (fill, color: string) =>
            isLightColor(color) ? DARK_FILL : fill,
          ),
        ),
  );
}

function sheetPicture(id: number, rId: string, size: SlideSize): string {
  return (
    `<p:pic><p:nvPicPr><p:cNvPr id="${id}" name="악보"/><p:cNvPicPr><a:picLocks noChangeAspect="1"/>` +
    '</p:cNvPicPr><p:nvPr/></p:nvPicPr>' +
    `<p:blipFill><a:blip xmlns:r="${RELATIONSHIPS_NS}" r:embed="${rId}"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>` +
    `<p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${size.cx}" cy="${size.cy}"/></a:xfrm>` +
    '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>'
  );
}

/** One slide, on white, with nothing of its layout's or master's behind it. */
function plainSlide(analysis: Analysis, index: number): string {
  const slide = analysis.slides[index];
  let xml = slide.xml;

  const bottom = slide.shapes[0];
  if (analysis.backgroundShape[index]) {
    xml = xml.slice(0, bottom.start) + xml.slice(bottom.end);
  } else if (analysis.backgroundIsSheet[index] && slide.background) {
    // The page moves from the background onto the slide, at the bottom.
    const ids = [...xml.matchAll(/<p:cNvPr\b[^>]*?\bid="(\d+)"/g)].map((match) => Number(match[1]));
    const at = bottom?.start ?? xml.lastIndexOf('</p:spTree>');
    xml =
      xml.slice(0, at) + sheetPicture(Math.max(1, ...ids) + 1, slide.background.rId, analysis.size) + xml.slice(at);
  }

  xml = /<p:bg\b[^>]*>[\s\S]*?<\/p:bg>/.test(xml)
    ? xml.replace(/<p:bg\b[^>]*>[\s\S]*?<\/p:bg>/, WHITE_BACKGROUND)
    : xml.replace(/<p:cSld\b[^>]*>/, (open) => open + WHITE_BACKGROUND);

  // PowerPoint's "배경 그래픽 숨기기": the layout's and master's pictures and
  // shapes stay off this slide.
  xml = xml.replace(/<p:sld\b[^>]*>/, (open) =>
    /\sshowMasterSp="/.test(open)
      ? open.replace(/\sshowMasterSp="[^"]*"/, ' showMasterSp="0"')
      : open.replace(/^<p:sld\b/, '<p:sld showMasterSp="0"'),
  );

  xml = /<p:clrMapOvr\b[^>]*>[\s\S]*?<\/p:clrMapOvr>/.test(xml)
    ? xml.replace(/<p:clrMapOvr\b[^>]*>[\s\S]*?<\/p:clrMapOvr>/, STANDARD_COLOR_MAP)
    : xml.replace('</p:cSld>', `</p:cSld>${STANDARD_COLOR_MAP}`);

  return darkenLightText(xml);
}

/**
 * The deck with every background taken off: each slide on plain white, with
 * no layout or master graphics behind it and no background photo under its
 * 악보. The 악보 itself — its pictures, and a page set as a slide's own
 * background — stays exactly where it was.
 */
export async function removeSongBackgrounds(
  data: ArrayBuffer | Uint8Array,
  compression: 'STORE' | 'DEFLATE' = 'STORE',
): Promise<Uint8Array> {
  const zip = await JSZip.loadAsync(data);
  const analysis = await analyze(zip);
  analysis.slides.forEach((slide, index) => zip.file(slide.path, plainSlide(analysis, index)));
  return zip.generateAsync({ type: 'uint8array', compression });
}
