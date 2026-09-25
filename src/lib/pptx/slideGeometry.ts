// Reads a deck's slide size, and rescales a deck's slides to a different one.
//
// mergePptxDecks keeps the *base* deck's `<p:sldSz>`, because a presentation
// has exactly one slide size. An addition authored at another size therefore
// keeps its own coordinates on a canvas of a different size: a 16:9 song deck
// spliced into the 4:3 수요예배 template lands up in the top-left corner with
// its 악보 image ending short of the right edge.
//
// Scope, deliberately: only top-level shapes in each slide's `<p:spTree>` are
// moved, and font sizes on every run are scaled with them. Group children live
// in their own coordinate space (mapped by the group's chOff/chExt), so the
// group's own transform is enough. Line widths, paragraph indents, bodyPr
// insets and custom geometry paths are left alone — they share the same EMU
// space, but they are invisible on the full-bleed image slides this exists
// for, and guessing at them risks more than it fixes. Slides whose shapes take
// their geometry from the layout (no `<a:xfrm>` of their own, like the 표지)
// are unaffected, which is why the 썸네일 ships as its own 16:9 asset instead
// of being rescaled from the template.
import JSZip from 'jszip';
import { slideOrderOf } from './pptxSlices';

export interface SlideSize {
  cx: number;
  cy: number;
}

/** Read `<p:sldSz>` out of a deck. */
export async function readSlideSize(data: ArrayBuffer | Uint8Array): Promise<SlideSize> {
  const zip = await JSZip.loadAsync(data);
  return readSlideSizeOf(await zip.file('ppt/presentation.xml')!.async('string'));
}

export function readSlideSizeOf(presentationXml: string): SlideSize {
  const tag = presentationXml.match(/<p:sldSz\b[^>]*>/)?.[0];
  const cx = Number(tag?.match(/\bcx="(\d+)"/)?.[1]);
  const cy = Number(tag?.match(/\bcy="(\d+)"/)?.[1]);
  if (!cx || !cy) throw new Error('프레젠테이션에서 슬라이드 크기를 찾지 못했습니다.');
  return { cx, cy };
}

export function sameSlideSize(a: SlideSize, b: SlideSize): boolean {
  return a.cx === b.cx && a.cy === b.cy;
}

/** How a slide's content is mapped onto a canvas of a different size. */
export interface SlideScale {
  /** Uniform factor — the larger of the two axes' shrink, so nothing is cropped. */
  scale: number;
  /** Letterbox offsets that centre the scaled content on the new canvas. */
  offsetX: number;
  offsetY: number;
}

export function slideScaleFor(from: SlideSize, to: SlideSize): SlideScale {
  const scale = Math.min(to.cx / from.cx, to.cy / from.cy);
  return {
    scale,
    offsetX: Math.round((to.cx - from.cx * scale) / 2),
    offsetY: Math.round((to.cy - from.cy * scale) / 2),
  };
}

/** Scale one slide's top-level shape geometry and every run's font size. */
export function scaleSlideXml(slideXml: string, { scale, offsetX, offsetY }: SlideScale): string {
  const treeStart = slideXml.indexOf('<p:spTree>');
  const treeEnd = slideXml.indexOf('</p:spTree>');
  if (treeStart === -1 || treeEnd === -1) return slideXml;

  const head = slideXml.slice(0, treeStart);
  const tree = slideXml.slice(treeStart, treeEnd);
  const tail = slideXml.slice(treeEnd);

  // Top-level children only: an <a:xfrm> inside a group is relative to the
  // group's child space, which the group's own transform already maps. The
  // <p:grpSpPr> at the tree's root is skipped for the same reason — it is the
  // tree's own transform, not a shape.
  let scaled = '';
  let index = 0;
  while (index < tree.length) {
    const open = tree.slice(index).match(/<(p:sp|p:pic|p:graphicFrame|p:grpSp|p:cxnSp)\b/);
    if (!open) break;
    const start = index + open.index!;
    const name = open[1];
    const end = matchingCloseIndex(tree, start, name);
    scaled += tree.slice(index, start);
    scaled += scaleShapeXml(tree.slice(start, end), { scale, offsetX, offsetY });
    index = end;
  }
  scaled += tree.slice(index);

  return head + scaled + tail;
}

/** Index just past `</name>` matching the element opening at `start`. */
export function matchingCloseIndex(xml: string, start: number, name: string): number {
  const pattern = new RegExp(`<(/?)${name}\\b[^>]*?(/?)>`, 'g');
  pattern.lastIndex = start;
  let depth = 0;
  for (let match = pattern.exec(xml); match; match = pattern.exec(xml)) {
    const [, closing, selfClosing] = match;
    if (closing) {
      depth -= 1;
      if (depth === 0) return match.index + match[0].length;
    } else if (!selfClosing) {
      depth += 1;
    } else if (depth === 0) {
      return match.index + match[0].length;
    }
  }
  return xml.length;
}

/** Scale a single top-level shape: its first xfrm, and all of its font sizes. */
function scaleShapeXml(shapeXml: string, { scale, offsetX, offsetY }: SlideScale): string {
  let seenOffset = false;
  let seenExtent = false;

  let out = shapeXml.replace(/<a:off\b[^>]*\/>/, (tag) => {
    if (seenOffset) return tag;
    seenOffset = true;
    return tag
      .replace(/\bx="(-?\d+)"/, (_, value: string) => `x="${Math.round(Number(value) * scale) + offsetX}"`)
      .replace(/\by="(-?\d+)"/, (_, value: string) => `y="${Math.round(Number(value) * scale) + offsetY}"`);
  });

  out = out.replace(/<a:ext\b[^>]*\/>/, (tag) => {
    if (seenExtent) return tag;
    seenExtent = true;
    return tag
      .replace(/\bcx="(\d+)"/, (_, value: string) => `cx="${Math.max(1, Math.round(Number(value) * scale))}"`)
      .replace(/\bcy="(\d+)"/, (_, value: string) => `cy="${Math.max(1, Math.round(Number(value) * scale))}"`);
  });

  // Font sizes are in 1/100 pt and live on rPr/defRPr/endParaRPr at any depth.
  out = out.replace(/<a:(rPr|defRPr|endParaRPr)\b[^>]*/g, (tag) =>
    tag.replace(/\bsz="(\d+)"/, (_, value: string) => `sz="${Math.max(100, Math.round((Number(value) * scale) / 100) * 100)}"`),
  );

  return out;
}

/**
 * Rescale every slide in `data` for a canvas of `target` size, centred and
 * uniformly scaled so nothing is cropped. Returns the deck unchanged when it
 * is already that size.
 */
export async function rescaleDeckToSize(
  data: ArrayBuffer | Uint8Array,
  target: SlideSize,
  compression: 'STORE' | 'DEFLATE' = 'STORE',
): Promise<{ data: Uint8Array; rescaled: boolean; from: SlideSize }> {
  const zip = await JSZip.loadAsync(data);
  const presentationXml = await zip.file('ppt/presentation.xml')!.async('string');
  const from = readSlideSizeOf(presentationXml);
  if (sameSlideSize(from, target)) {
    return { data: data instanceof Uint8Array ? data : new Uint8Array(data), rescaled: false, from };
  }

  const scale = slideScaleFor(from, target);
  for (const name of await slideOrderOf(zip)) {
    const path = `ppt/slides/${name}`;
    const file = zip.file(path);
    if (!file) continue;
    zip.file(path, scaleSlideXml(await file.async('string'), scale));
  }

  // The merge keeps the base deck's slide size, but a rescaled deck that is
  // opened on its own should agree with its new coordinates.
  zip.file(
    'ppt/presentation.xml',
    presentationXml.replace(/<p:sldSz\b[^>]*>/, `<p:sldSz cx="${target.cx}" cy="${target.cy}"/>`),
  );

  return {
    data: await zip.generateAsync({ type: 'uint8array', compression }),
    rescaled: true,
    from,
  };
}
