// Tiny 찬양 PPT packages for the 수요예배 tests: just the parts
// src/wednesday/songDeck.ts reads (presentation.xml, its rels, and each
// slide with its rels), built with the shapes a real deck would carry.
import JSZip from 'jszip';

export const SIZE = { cx: 9144000, cy: 6858000 };
const NS =
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
  'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';

let nextId = 2;

export function picture(rId: string, box: { x?: number; y?: number; cx: number; cy: number } = SIZE): string {
  const id = nextId++;
  return (
    `<p:pic><p:nvPicPr><p:cNvPr id="${id}" name="그림 ${id}"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr>` +
    `<p:blipFill><a:blip r:embed="${rId}"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>` +
    `<p:spPr><a:xfrm><a:off x="${box.x ?? 0}" y="${box.y ?? 0}"/><a:ext cx="${box.cx}" cy="${box.cy}"/></a:xfrm>` +
    '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>'
  );
}

/** A text box; `fill` is the shape's own fill, `color` its text's. */
export function textBox(text: string, { fill, color }: { fill?: string; color?: string } = {}): string {
  const id = nextId++;
  const shapeFill = fill ? `<a:solidFill><a:srgbClr val="${fill}"/></a:solidFill>` : '<a:noFill/>';
  const runFill = color ? `<a:solidFill><a:srgbClr val="${color}"/></a:solidFill>` : '';
  return (
    `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="텍스트 ${id}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>` +
    '<p:spPr><a:xfrm><a:off x="457200" y="457200"/><a:ext cx="8229600" cy="914400"/></a:xfrm>' +
    `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>${shapeFill}` +
    '<a:ln><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill></a:ln></p:spPr>' +
    `<p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="ko-KR" sz="4000">${runFill}</a:rPr>` +
    `<a:t>${text}</a:t></a:r></a:p></p:txBody></p:sp>`
  );
}

export interface SlideSpec {
  shapes: string[];
  /** The slide's own `<p:bg>`. */
  background?: string;
  /** Relationship id → media file name. */
  media?: Record<string, string>;
}

export const PHOTO_BACKGROUND = '<p:bg><p:bgPr><a:blipFill><a:blip r:embed="rIdBg"/><a:stretch><a:fillRect/></a:stretch></a:blipFill><a:effectLst/></p:bgPr></p:bg>';

export async function deckOf(slides: SlideSpec[]): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file(
    'ppt/presentation.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:presentation ${NS}><p:sldIdLst>` +
      slides.map((_, index) => `<p:sldId id="${256 + index}" r:id="rIdS${index + 1}"/>`).join('') +
      `</p:sldIdLst><p:sldSz cx="${SIZE.cx}" cy="${SIZE.cy}"/></p:presentation>`,
  );
  zip.file(
    'ppt/_rels/presentation.xml.rels',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      slides
        .map(
          (_, index) =>
            `<Relationship Id="rIdS${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${index + 1}.xml"/>`,
        )
        .join('') +
      '</Relationships>',
  );
  slides.forEach((slide, index) => {
    zip.file(
      `ppt/slides/slide${index + 1}.xml`,
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sld ${NS}><p:cSld>${slide.background ?? ''}<p:spTree>` +
        '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>' +
        '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>' +
        `${slide.shapes.join('')}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`,
    );
    const media = Object.entries(slide.media ?? {})
      .map(
        ([rId, name]) =>
          `<Relationship Id="${rId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/${name}"/>`,
      )
      .join('');
    zip.file(
      `ppt/slides/_rels/slide${index + 1}.xml.rels`,
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rIdL" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>' +
        `${media}</Relationships>`,
    );
  });
  return zip.generateAsync({ type: 'uint8array' });
}

/** A 티스토리 악보 PPT: one full-page 악보 per slide, the photo on the master. */
export const sheetSlides = (count: number): SlideSpec[] =>
  Array.from({ length: count }, (_, index) => ({
    shapes: [picture('rId2')],
    media: { rId2: `sheet${index + 1}.png` },
  }));

/** The same song's 가사 PPT: the lyrics as text over a photo. */
export const lyricsSlides = (count: number): SlideSpec[] =>
  Array.from({ length: count }, (_, index) => ({
    background: PHOTO_BACKGROUND,
    shapes: [textBox(`가사 ${index + 1}`, { color: 'FFFFFF' })],
    media: { rIdBg: 'photo.jpg' },
  }));
