// Where a 수요예배 곡's .pptx comes from.
//
// Two ways in, by design:
//
//  1. Search — the proxy searches the web for "<제목> 찬양 ppt", hands back the
//     hits it is willing to fetch, and downloads the chosen one on the
//     browser's behalf. A browser cannot do this itself: no file host sends
//     CORS headers, so `fetch(url).arrayBuffer()` from the app's origin is
//     refused before it starts.
//  2. Upload — the operator downloads the file themselves and drops it in.
//     Sites that need a login (네이버 카페) or that change their markup can
//     never be automated, so this path always works and is never hidden.
//
// A song's slides come from one of two things: its 찬양 PPT, or its 악보
// 사진 (one slide per page). Both can be searched for and both can be
// uploaded, and this module is the one place that knows how each arrives.
//
// Nothing here trusts the search result: the proxy hands out a signed token per
// hit instead of a URL, and the download route re-checks the host against its
// own allowlist. See worker/src/songPpt.js and worker/src/songSheet.js.
import { cloudLibraryBaseUrl, hasCloudLibrary } from '../lib/storage/cloudLibrary';
import { inspectDeckBytes } from '../lib/storage/pptLibrary';

/** How long a search or a download may take before the page stops waiting. */
const SEARCH_TIMEOUT_MS = 15_000;
const DOWNLOAD_TIMEOUT_MS = 30_000;

/** The largest 찬양 PPT the proxy will hand over (it caps this too). */
export const MAX_SONG_DECK_BYTES = 25 * 1024 * 1024;
/** The largest 악보 사진 the proxy will hand over (it caps this too). */
export const MAX_SHEET_IMAGE_BYTES = 8 * 1024 * 1024;
/** What the song card's file picker accepts. */
export const SONG_FILE_ACCEPT = '.pptx,.png,.jpg,.jpeg';

export interface SongPptCandidate {
  /** Opaque, proxy-signed handle for this hit — never a raw URL. */
  token: string;
  /** Where it was found, for the card's "출처" line and the library entry. */
  url: string;
  host: string;
  /** The page or file title, as the search engine reported it. */
  title: string;
  /** True when the hit is the .pptx itself rather than a page carrying one. */
  direct: boolean;
  /** How well the hit's title matches the song, 0..1. */
  score?: number;
  /** 'auto' — confidently this song; 'review' — a guess worth showing. */
  decision?: 'auto' | 'review';
}

/** One 악보 사진 hit. Same token discipline as a 찬양 PPT hit. */
export interface SheetImageCandidate {
  token: string;
  url: string;
  host: string;
  title: string;
  /** The page the image was found on, for the card's 출처 link. */
  pageUrl?: string;
  score?: number;
  decision?: 'auto' | 'review';
}

export interface SheetImageSearch {
  candidates: SheetImageCandidate[];
  message?: string;
}

/** An 악보 사진 ready to become a slide. */
export interface LoadedSheetImage {
  name: string;
  mimeType: 'image/png' | 'image/jpeg';
  data: ArrayBuffer;
  width: number;
  height: number;
  sourceUrl?: string;
}

export interface SongPptSearch {
  candidates: SongPptCandidate[];
  /** Set when the proxy is reachable but found nothing it may fetch. */
  message?: string;
}

export interface LoadedSongDeck {
  deck: ArrayBuffer;
  slideCount: number;
  fileName: string;
}

export function hasSongPptProxy(): boolean {
  return hasCloudLibrary();
}

function requireBase(): string {
  const base = cloudLibraryBaseUrl();
  if (!base) throw new Error('찬양 PPT 검색 서버가 연결되지 않았습니다. 파일을 직접 올려 주세요.');
  return base;
}

async function errorMessage(response: Response): Promise<string> {
  try {
    const payload = (await response.json()) as { error?: string };
    if (payload.error) return payload.error;
  } catch {
    // Fall through to the status code.
  }
  return `HTTP ${response.status}`;
}

/** Ask the proxy for 찬양 PPT hits for a title. Never throws — the page falls back to upload. */
export async function searchSongPpt(title: string, signal?: AbortSignal): Promise<SongPptSearch> {
  const trimmed = title.trim();
  if (!trimmed || !hasSongPptProxy()) return { candidates: [] };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort);
  try {
    const response = await fetch(
      `${requireBase()}/wednesday/songs?title=${encodeURIComponent(trimmed)}`,
      { signal: controller.signal },
    );
    if (!response.ok) return { candidates: [], message: await errorMessage(response) };
    const payload = (await response.json()) as SongPptSearch;
    return { candidates: payload.candidates ?? [], message: payload.message };
  } catch {
    // A failed search is not an error the operator has to act on: the upload
    // path is right next to the search button.
    return { candidates: [] };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

/**
 * Have the proxy download a chosen hit. Throws with a Korean message the card
 * shows, because the operator asked for this one specifically.
 */
export async function downloadSongPpt(
  candidate: Pick<SongPptCandidate, 'token' | 'url'>,
  signal?: AbortSignal,
): Promise<LoadedSongDeck> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort);
  try {
    const response = await fetch(`${requireBase()}/wednesday/songs/file`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: candidate.token }),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(await errorMessage(response));

    const deck = await response.arrayBuffer();
    if (deck.byteLength > MAX_SONG_DECK_BYTES) {
      throw new Error('찬양 PPT가 너무 큽니다 (25MB 초과).');
    }
    const { slideCount } = await inspectDeckBytes(deck);
    if (slideCount < 1) throw new Error('받은 파일에 슬라이드가 없습니다.');
    return { deck, slideCount, fileName: fileNameFromUrl(candidate.url) };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

function fileNameFromUrl(url: string): string {
  try {
    const name = new URL(url).pathname.split('/').filter(Boolean).pop() ?? '';
    return decodeURIComponent(name) || '찬양.pptx';
  } catch {
    return '찬양.pptx';
  }
}

/** Ask the proxy for 악보 사진 hits. Never throws — upload is always there. */
export async function searchSheetImages(title: string, signal?: AbortSignal): Promise<SheetImageSearch> {
  const trimmed = title.trim();
  if (!trimmed || !hasSongPptProxy()) return { candidates: [] };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort);
  try {
    const response = await fetch(
      `${requireBase()}/wednesday/songs/sheets?title=${encodeURIComponent(trimmed)}`,
      { signal: controller.signal },
    );
    if (!response.ok) return { candidates: [], message: await errorMessage(response) };
    const payload = (await response.json()) as SheetImageSearch;
    return { candidates: payload.candidates ?? [], message: payload.message };
  } catch {
    return { candidates: [] };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

/** Have the proxy download one 악보 사진 and measure it for the slide. */
export async function downloadSheetImage(
  candidate: Pick<SheetImageCandidate, 'token' | 'url'>,
  signal?: AbortSignal,
): Promise<LoadedSheetImage> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort);
  try {
    const response = await fetch(`${requireBase()}/wednesday/songs/image`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: candidate.token }),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(await errorMessage(response));

    const data = await response.arrayBuffer();
    if (data.byteLength > MAX_SHEET_IMAGE_BYTES) throw new Error('악보 사진이 너무 큽니다 (8MB 초과).');
    const mimeType = response.headers.get('Content-Type')?.includes('png') ? 'image/png' : 'image/jpeg';
    const { width, height } = await measureImage(data, mimeType);
    return {
      name: fileNameFromUrl(candidate.url),
      mimeType,
      data,
      width,
      height,
      sourceUrl: candidate.url,
    };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

/** Read 악보 사진 the operator picked off their own machine. */
export async function readUploadedSheetImages(files: File[]): Promise<LoadedSheetImage[]> {
  const images: LoadedSheetImage[] = [];
  for (const file of files) {
    if (!/\.(png|jpe?g)$/i.test(file.name)) {
      throw new Error(`${file.name}: PNG·JPG 사진만 올릴 수 있습니다.`);
    }
    if (file.size > MAX_SHEET_IMAGE_BYTES) {
      throw new Error(`${file.name}: 사진이 너무 큽니다 (8MB 초과).`);
    }
    const mimeType = /\.png$/i.test(file.name) ? 'image/png' : 'image/jpeg';
    const data = await file.arrayBuffer();
    const { width, height } = await measureImage(data, mimeType);
    images.push({ name: file.name, mimeType, data, width, height });
  }
  return images;
}

/**
 * An image's pixel size, which the slide needs to keep its aspect ratio.
 * A file the browser cannot decode is not a picture PowerPoint can show
 * either, so it is refused here rather than at download time.
 */
async function measureImage(
  data: ArrayBuffer,
  mimeType: string,
): Promise<{ width: number; height: number }> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(new Blob([data], { type: mimeType }));
  } catch {
    throw new Error('사진을 읽지 못했습니다. PNG·JPG 파일인지 확인해 주세요.');
  }
  try {
    if (bitmap.width <= 0 || bitmap.height <= 0) throw new Error('사진 크기가 올바르지 않습니다.');
    return { width: bitmap.width, height: bitmap.height };
  } finally {
    bitmap.close();
  }
}

/** Read a 찬양 PPT the operator downloaded and uploaded by hand. */
export async function readUploadedSongDeck(file: File): Promise<LoadedSongDeck> {
  if (!/\.pptx$/i.test(file.name)) {
    throw new Error('.pptx 파일만 올릴 수 있습니다.');
  }
  if (file.size > MAX_SONG_DECK_BYTES) {
    throw new Error('찬양 PPT가 너무 큽니다 (25MB 초과).');
  }
  const deck = await file.arrayBuffer();
  const { slideCount } = await inspectDeckBytes(deck);
  if (slideCount < 1) throw new Error('이 파일에서 슬라이드를 찾지 못했습니다.');
  return { deck, slideCount, fileName: file.name };
}

export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

/** How many 악보 사진 the app attaches by itself — a 찬양 악보 is usually 1-2 pages. */
export const MAX_AUTO_SHEET_IMAGES = 2;

export type AutoAttachResult =
  | { kind: 'deck'; deck: LoadedSongDeck; candidate: SongPptCandidate }
  | { kind: 'images'; images: LoadedSheetImage[]; candidates: SheetImageCandidate[] }
  | {
      kind: 'none';
      pptCandidates: SongPptCandidate[];
      sheetCandidates: SheetImageCandidate[];
      message?: string;
    };

/**
 * Find a song's slides and bring them back, without asking anything.
 *
 * A 찬양 PPT wins when one is confidently this song, because it is the whole
 * song in the church's own format. Otherwise the 악보 사진 the search is sure
 * about are downloaded, since most songs are shared as sheet-music images.
 * When nothing is certain, nothing is attached: the hits come back for the
 * operator to choose from, next to the upload button that always works.
 */
export async function autoAttachSong(title: string, signal?: AbortSignal): Promise<AutoAttachResult> {
  const trimmed = title.trim();
  if (!trimmed) return { kind: 'none', pptCandidates: [], sheetCandidates: [] };

  const ppt = await searchSongPpt(trimmed, signal);
  const bestDeck = ppt.candidates.find((candidate) => candidate.decision === 'auto');
  if (bestDeck) {
    try {
      return { kind: 'deck', deck: await downloadSongPpt(bestDeck, signal), candidate: bestDeck };
    } catch {
      // The file would not come; fall through to 악보 사진 rather than stop.
    }
  }

  const sheets = await searchSheetImages(trimmed, signal);
  const confident = sheets.candidates.filter((candidate) => candidate.decision === 'auto');
  const images: LoadedSheetImage[] = [];
  for (const candidate of confident.slice(0, MAX_AUTO_SHEET_IMAGES)) {
    try {
      images.push(await downloadSheetImage(candidate, signal));
    } catch {
      // One unreachable image does not spoil the rest.
    }
  }
  if (images.length > 0) {
    // The pages that were not taken stay on offer, so a three-page 악보 can be
    // completed with one click instead of a fresh search.
    return {
      kind: 'images',
      images,
      candidates: sheets.candidates.filter(
        (candidate) => !images.some((image) => image.sourceUrl === candidate.url),
      ),
    };
  }

  return {
    kind: 'none',
    pptCandidates: ppt.candidates,
    sheetCandidates: sheets.candidates,
    message: ppt.message ?? sheets.message,
  };
}
