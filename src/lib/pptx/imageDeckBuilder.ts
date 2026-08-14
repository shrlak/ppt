import JSZip from 'jszip';
import { ensureDefaultExtension } from './contentTypes';
import { extractSlideSubset } from './pptxSlices';

const SLIDE_WIDTH = 9_144_000;
const SLIDE_HEIGHT = 6_858_000;

export interface ImageSlideSource {
  data: Uint8Array;
  mimeType: 'image/png' | 'image/jpeg';
  width: number;
  height: number;
}

export interface ContainedRect {
  x: number;
  y: number;
  cx: number;
  cy: number;
}

export function containRect(
  imageWidth: number,
  imageHeight: number,
  slideWidth = SLIDE_WIDTH,
  slideHeight = SLIDE_HEIGHT,
): ContainedRect {
  if (
    !Number.isFinite(imageWidth) ||
    !Number.isFinite(imageHeight) ||
    imageWidth <= 0 ||
    imageHeight <= 0
  ) {
    throw new Error('이미지 크기가 올바르지 않습니다.');
  }
  const scale = Math.min(slideWidth / imageWidth, slideHeight / imageHeight);
  const cx = Math.round(imageWidth * scale);
  const cy = Math.round(imageHeight * scale);
  return {
    x: Math.round((slideWidth - cx) / 2),
    y: Math.round((slideHeight - cy) / 2),
    cx,
    cy,
  };
}

function imagePicture(index: number, imageRid: string, rect: ContainedRect): string {
  return `<p:pic><p:nvPicPr><p:cNvPr id="${1000 + index}" name="추가 자료 ${index + 1}"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="${imageRid}"/><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr><a:xfrm><a:off x="${rect.x}" y="${rect.y}"/><a:ext cx="${rect.cx}" cy="${rect.cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:ln><a:noFill/></a:ln></p:spPr></p:pic>`;
}

function replaceVisibleShapes(slideXml: string, picture: string): string {
  const spTree = slideXml.match(/<p:spTree>([\s\S]*?)<\/p:spTree>/)?.[1];
  const nonVisual = spTree?.match(/<p:nvGrpSpPr>[\s\S]*?<\/p:nvGrpSpPr>/)?.[0];
  const group = spTree?.match(/<p:grpSpPr>[\s\S]*?<\/p:grpSpPr>/)?.[0];
  if (!spTree || !nonVisual || !group) throw new Error('이미지 슬라이드 템플릿 구조를 읽지 못했습니다.');
  return slideXml.replace(
    /<p:spTree>[\s\S]*?<\/p:spTree>/,
    `<p:spTree>${nonVisual}${group}${picture}</p:spTree>`,
  );
}

export async function buildImageDeck(
  templateData: ArrayBuffer | Uint8Array,
  images: ImageSlideSource[],
): Promise<Uint8Array> {
  if (images.length === 0) throw new Error('추가할 이미지가 없습니다.');
  for (const image of images) {
    if (image.data.byteLength === 0) throw new Error('빈 이미지는 슬라이드로 만들 수 없습니다.');
    containRect(image.width, image.height);
  }

  const zip = await JSZip.loadAsync(await extractSlideSubset(templateData, images.map(() => 2)));
  let contentTypes = await zip.file('[Content_Types].xml')!.async('string');

  for (const [index, image] of images.entries()) {
    const slideNumber = index + 1;
    const extension = image.mimeType === 'image/png' ? 'png' : 'jpg';
    const mediaPath = `ppt/media/additional-image-${slideNumber}.${extension}`;
    const imageRid = `rIdAdditionalImage${slideNumber}`;
    const slidePath = `ppt/slides/slide${slideNumber}.xml`;
    const relsPath = `ppt/slides/_rels/slide${slideNumber}.xml.rels`;
    const slideXml = await zip.file(slidePath)!.async('string');
    const relsXml = await zip.file(relsPath)!.async('string');
    const picture = imagePicture(index, imageRid, containRect(image.width, image.height));

    zip.file(slidePath, replaceVisibleShapes(slideXml, picture));
    zip.file(
      relsPath,
      relsXml.replace(
        '</Relationships>',
        `<Relationship Id="${imageRid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/additional-image-${slideNumber}.${extension}"/></Relationships>`,
      ),
    );
    zip.file(mediaPath, image.data);
    contentTypes = ensureDefaultExtension(contentTypes, extension, image.mimeType);
  }

  zip.file('[Content_Types].xml', contentTypes);
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
}
