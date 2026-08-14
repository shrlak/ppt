/// <reference lib="dom" />

import { inspectDeckBytes } from '../storage/pptLibrary';
import { buildImageDeck, type ImageSlideSource } from '../pptx/imageDeckBuilder';
import { loadPdfTask } from '../utils/contiPdf';
import { detectAdditionalFileKind } from './files';
import type { AdditionalFile } from './types';

function namedError(name: string, error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  return new Error(message.startsWith(`${name}:`) ? message : `${name}: ${message}`);
}

async function imageSource(file: AdditionalFile): Promise<ImageSlideSource> {
  const mimeType = file.kind === 'png' ? 'image/png' : 'image/jpeg';
  const bitmap = await createImageBitmap(new Blob([file.data], { type: mimeType }));
  try {
    if (bitmap.width <= 0 || bitmap.height <= 0) throw new Error('이미지 크기가 올바르지 않습니다.');
    return {
      data: new Uint8Array(file.data.slice(0)),
      mimeType,
      width: bitmap.width,
      height: bitmap.height,
    };
  } finally {
    bitmap.close();
  }
}

function canvasPng(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error('PDF 페이지 이미지를 만들지 못했습니다.'));
        return;
      }
      void blob.arrayBuffer().then((data) => resolve(new Uint8Array(data)), reject);
    }, 'image/png');
  });
}

async function renderPdfImages(data: ArrayBuffer): Promise<ImageSlideSource[]> {
  const loadingTask = loadPdfTask(data);
  try {
    const document = await loadingTask.promise;
    const images: ImageSlideSource[] = [];
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const base = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: Math.min(1600 / base.width, 2) });
      const canvas = window.document.createElement('canvas');
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      const context = canvas.getContext('2d');
      if (!context) throw new Error('PDF 페이지용 캔버스를 만들지 못했습니다.');
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: context, viewport }).promise;
      images.push({
        data: await canvasPng(canvas),
        mimeType: 'image/png',
        width: canvas.width,
        height: canvas.height,
      });
      page.cleanup();
    }
    return images;
  } finally {
    await loadingTask.destroy();
  }
}

export async function inspectAdditionalUpload(file: File): Promise<AdditionalFile> {
  try {
    const data = await file.arrayBuffer();
    const kind = detectAdditionalFileKind(file.name, new Uint8Array(data));
    let slideCount = 1;
    if (kind === 'pptx') {
      slideCount = (await inspectDeckBytes(data)).slideCount;
      if (slideCount < 1) throw new Error('슬라이드가 없는 PPTX입니다.');
    } else if (kind === 'pdf') {
      const loadingTask = loadPdfTask(data);
      try {
        const document = await loadingTask.promise;
        slideCount = document.numPages;
        if (slideCount < 1) throw new Error('페이지가 없는 PDF입니다.');
      } finally {
        await loadingTask.destroy();
      }
    } else {
      const bitmap = await createImageBitmap(new Blob([data], { type: kind === 'png' ? 'image/png' : 'image/jpeg' }));
      try {
        if (bitmap.width <= 0 || bitmap.height <= 0) throw new Error('이미지 크기가 올바르지 않습니다.');
      } finally {
        bitmap.close();
      }
    }
    return { id: crypto.randomUUID(), name: file.name, kind, data, slideCount };
  } catch (error) {
    throw namedError(file.name, error);
  }
}

export async function convertAdditionalFile(
  file: AdditionalFile,
  template: ArrayBuffer | Uint8Array,
): Promise<{ deck: Uint8Array; slideCount: number }> {
  try {
    if (file.kind === 'pptx') {
      return { deck: new Uint8Array(file.data.slice(0)), slideCount: file.slideCount };
    }
    const images = file.kind === 'pdf' ? await renderPdfImages(file.data) : [await imageSource(file)];
    return { deck: await buildImageDeck(template, images), slideCount: images.length };
  } catch (error) {
    throw namedError(file.name, error);
  }
}
