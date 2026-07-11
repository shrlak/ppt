// Keyless, on-device OCR fallback using tesseract.js. Loaded lazily (dynamic
// import) so its worker/wasm/language data are only fetched the first time a
// user actually recognizes a score without a Gemini key — it stays out of the
// main bundle entirely.
import type { ParsedScore } from './scoreParser';
import { parseScoreText } from './scoreParser';

export type OcrProgress = (fraction: number) => void;

/** OCR a score image (Korean + English) and return the raw recognized text. */
export async function ocrScoreImage(dataUrl: string, onProgress?: OcrProgress): Promise<string> {
  const { createWorker } = await import('tesseract.js');
  const worker = await createWorker('kor+eng', 1, {
    logger: (m: { status?: string; progress?: number }) => {
      if (onProgress && m.status === 'recognizing text' && typeof m.progress === 'number') {
        onProgress(m.progress);
      }
    },
  });
  try {
    const { data } = await worker.recognize(dataUrl);
    return data.text ?? '';
  } finally {
    await worker.terminate();
  }
}

/** OCR a score image and parse it into a draft song via the heuristic parser. */
export async function recognizeWithTesseract(dataUrl: string, onProgress?: OcrProgress): Promise<ParsedScore> {
  const text = await ocrScoreImage(dataUrl, onProgress);
  return parseScoreText(text);
}
