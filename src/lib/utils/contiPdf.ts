// Browser-side wrapper around pdf.js for loading a 찬양 콘티 PDF:
// per-page text extraction, page classification, and page-image rendering.
import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import type { ParsedConti } from './types';
import { classifyPages, matchSongsToPages, parseCoverText } from './contiText';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

const BASE: string = (import.meta.env && import.meta.env.BASE_URL) || '/';

export interface ContiDocument {
  parsed: ParsedConti;
  /** Render a page (1-based) to a JPEG data URL, scaled to maxWidth CSS px. */
  renderPage(pageNumber: number, maxWidth?: number): Promise<string>;
  destroy(): void;
}

interface TextItemLike {
  str: string;
  hasEOL?: boolean;
  transform?: number[];
  width?: number;
}

async function extractPageText(page: pdfjs.PDFPageProxy): Promise<string> {
  const content = await page.getTextContent();
  let text = '';
  let lastY: number | null = null;
  let lastEndX: number | null = null;
  for (const raw of content.items) {
    const item = raw as TextItemLike;
    if (typeof item.str !== 'string') continue;
    const tf = item.transform;
    const x = tf ? tf[4] : null;
    const y = tf ? tf[5] : null;
    const fontSize = tf ? Math.abs(tf[0]) || Math.abs(tf[3]) || 10 : 10;
    if (text.length > 0 && !text.endsWith('\n')) {
      if (lastY !== null && y !== null && Math.abs(y - lastY) > 2) {
        text += '\n';
      } else if (
        // Items are often per-glyph with explicit space items in between;
        // only a real horizontal gap means a missing word break.
        lastEndX !== null &&
        x !== null &&
        x - lastEndX > 0.3 * fontSize &&
        !/\s$/.test(text)
      ) {
        text += ' ';
      }
    }
    text += item.str;
    if (item.hasEOL) text += '\n';
    if (y !== null) lastY = y;
    lastEndX = x !== null ? x + (item.width ?? 0) : null;
  }
  return text;
}

export async function loadConti(data: ArrayBuffer): Promise<ContiDocument> {
  // pdf.js transfers the buffer to its worker, so hand it a private copy.
  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(data.slice(0)),
    cMapUrl: BASE + 'cmaps/',
    cMapPacked: true,
    standardFontDataUrl: BASE + 'standard_fonts/',
  });
  const doc = await loadingTask.promise;

  const pageTexts: string[] = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    try {
      pageTexts.push(await extractPageText(page));
    } catch {
      pageTexts.push('');
    }
  }

  const { coverIndex, musicPages } = classifyPages(pageTexts);
  const info = (coverIndex !== null ? parseCoverText(pageTexts[coverIndex - 1]) : null) ?? {
    songs: [],
  };
  matchSongsToPages(info, pageTexts, musicPages);

  const parsed: ParsedConti = { info, numPages: doc.numPages, pageTexts, musicPages };

  return {
    parsed,
    async renderPage(pageNumber: number, maxWidth = 900): Promise<string> {
      const page = await doc.getPage(pageNumber);
      const base = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: maxWidth / base.width });
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('캔버스를 만들 수 없습니다.');
      await page.render({ canvasContext: ctx, viewport }).promise;
      return canvas.toDataURL('image/jpeg', 0.85);
    },
    destroy() {
      void loadingTask.destroy();
    },
  };
}
