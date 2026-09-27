// A 광고's links, drawn as QR codes in the bottom-right corner of its slide
// (the links themselves are taken out of the text: utils/announcementLinks.ts).
// Both 광고 builders — the Sunday service's and the 수련회's — place them the
// same way: stacked up from the corner, with the body text box moved clear of
// them so no line of text ever runs underneath a code.
import qrcode from 'qrcode-generator';
import { xmlEscape } from './pptxBuilder';
import { fitBodyFontSize } from './textFit';

const IMAGE_REL_TYPE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image';

export const QR_IMAGE_EXTENSION = 'gif';
export const QR_IMAGE_CONTENT_TYPE = 'image/gif';

/** 1.8 in — large enough to scan from the back of the room once projected. */
export const QR_SIZE = 1645920;
/** Between two codes, and between a code and the text. */
export const QR_GAP = 137160;
/** White border around the code, in modules (keeps it scannable on any background). */
const QUIET_MODULES = 2;
/** Pixels on a side to aim for, so PowerPoint only ever scales the image down. */
const TARGET_PIXELS = 480;

export interface Rect {
  x: number;
  y: number;
  cx: number;
  cy: number;
}

/** Where a slide's codes may go: lined up on `right`, stacked up from `bottom`, never above `top`. */
export interface QrArea {
  right: number;
  bottom: number;
  top: number;
}

/** A shape's own position and size (its first `a:off`/`a:ext`). */
export function shapeRect(shapeXml: string): Rect | null {
  const off = shapeXml.match(/<a:off x="(-?\d+)" y="(-?\d+)"\/>/);
  const ext = shapeXml.match(/<a:ext cx="(\d+)" cy="(\d+)"\/>/);
  if (!off || !ext) return null;
  return { x: Number(off[1]), y: Number(off[2]), cx: Number(ext[1]), cy: Number(ext[2]) };
}

function withRect(shapeXml: string, rect: Rect): string {
  return shapeXml
    .replace(/<a:off x="-?\d+" y="-?\d+"\/>/, `<a:off x="${rect.x}" y="${rect.y}"/>`)
    .replace(/<a:ext cx="\d+" cy="\d+"\/>/, `<a:ext cx="${rect.cx}" cy="${rect.cy}"/>`);
}

/** `text`'s QR code as a GIF: black modules on white. */
export function qrCodeGif(text: string): Uint8Array {
  const qr = qrcode(0, 'M');
  // The library reads one byte per character; hand it the UTF-8 bytes that way.
  qr.addData(String.fromCharCode(...new TextEncoder().encode(text)), 'Byte');
  try {
    qr.make();
  } catch {
    throw new Error(`링크가 너무 길어 QR 코드로 만들 수 없습니다: ${text.slice(0, 60)}…`);
  }
  const cell = Math.max(1, Math.ceil(TARGET_PIXELS / (qr.getModuleCount() + 2 * QUIET_MODULES)));
  const dataUrl = qr.createDataURL(cell, cell * QUIET_MODULES);
  const binary = atob(dataUrl.slice(dataUrl.indexOf(',') + 1));
  return Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
}

/**
 * One square per link, stacked up from the area's bottom-right corner in
 * reading order (the first link on top) — shrunk alike when that many would
 * not fit between `bottom` and `top`.
 */
export function qrCodeBoxes(count: number, area: QrArea): Rect[] {
  if (count === 0) return [];
  const fits = Math.floor((area.bottom - area.top - (count - 1) * QR_GAP) / count);
  const size = Math.max(0, Math.min(QR_SIZE, fits));
  return Array.from({ length: count }, (_, i) => ({
    x: area.right - size,
    y: area.bottom - size - (count - 1 - i) * (size + QR_GAP),
    cx: size,
    cy: size,
  }));
}

/**
 * The body text box moved clear of the codes: cut short above them or
 * narrowed to their left, whichever keeps the text larger — cut short on a
 * tie, so short text keeps the full width. `baseSz`/`minSz` are the sizes the
 * caller then fits the text between.
 */
export function clearOfQrCodes(
  bodyShapeXml: string,
  lines: string[],
  boxes: Rect[],
  baseSz: number,
  minSz: number,
): string {
  const body = shapeRect(bodyShapeXml);
  if (!body || boxes.length === 0) return bodyShapeXml;
  const left = Math.min(...boxes.map((box) => box.x));
  const top = Math.min(...boxes.map((box) => box.y));
  if (body.x + body.cx <= left - QR_GAP || body.y + body.cy <= top - QR_GAP) return bodyShapeXml;

  const candidates: Rect[] = [
    { ...body, cy: top - QR_GAP - body.y },
    { ...body, cx: left - QR_GAP - body.x },
  ].filter((rect) => rect.cx > 0 && rect.cy > 0);
  let best = bodyShapeXml;
  let bestSz = -1;
  for (const rect of candidates) {
    const xml = withRect(bodyShapeXml, rect);
    const sz = fitBodyFontSize(xml, lines.length > 0 ? lines : [''], baseSz, minSz);
    if (sz > bestSz) {
      best = xml;
      bestSz = sz;
    }
  }
  return best;
}

export interface QrSlide {
  slideXml: string;
  relsXml: string;
  /** Image parts to add to the package, by path (`ppt/media/…`). */
  media: { path: string; data: Uint8Array }[];
}

/**
 * The slide with one QR picture per link at its box, the relationships
 * that embed them, and the images themselves, named `<mediaName>-<n>.gif`.
 */
export function addQrCodes(
  slideXml: string,
  relsXml: string,
  links: string[],
  boxes: Rect[],
  mediaName: string,
): QrSlide {
  let nextId = Math.max(0, ...[...slideXml.matchAll(/<p:cNvPr id="(\d+)"/g)].map((m) => Number(m[1]))) + 1;
  const pictures: string[] = [];
  const relationships: string[] = [];
  const media: QrSlide['media'] = [];
  links.forEach((link, i) => {
    const box = boxes[i];
    if (!box || box.cx === 0) return;
    const rId = `rIdQr${i + 1}`;
    const file = `${mediaName}-${i + 1}.${QR_IMAGE_EXTENSION}`;
    media.push({ path: `ppt/media/${file}`, data: qrCodeGif(link) });
    relationships.push(`<Relationship Id="${rId}" Type="${IMAGE_REL_TYPE}" Target="../media/${file}"/>`);
    pictures.push(
      `<p:pic><p:nvPicPr><p:cNvPr id="${nextId++}" name="QR ${i + 1}" descr="${xmlEscape(link)}"/>` +
        '<p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr>' +
        `<p:blipFill><a:blip r:embed="${rId}"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>` +
        `<p:spPr><a:xfrm><a:off x="${box.x}" y="${box.y}"/><a:ext cx="${box.cx}" cy="${box.cy}"/></a:xfrm>` +
        '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>',
    );
  });
  return {
    slideXml: slideXml.replace('</p:spTree>', `${pictures.join('')}</p:spTree>`),
    relsXml: relsXml.replace('</Relationships>', `${relationships.join('')}</Relationships>`),
    media,
  };
}
