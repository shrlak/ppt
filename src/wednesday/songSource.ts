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
// Nothing here trusts the search result: the proxy hands out a signed token per
// hit instead of a URL, and the download route re-checks the host against its
// own allowlist. See worker/src/songPpt.js.
import { cloudLibraryBaseUrl, hasCloudLibrary } from '../lib/storage/cloudLibrary';
import { inspectDeckBytes } from '../lib/storage/pptLibrary';

/** How long a search or a download may take before the page stops waiting. */
const SEARCH_TIMEOUT_MS = 15_000;
const DOWNLOAD_TIMEOUT_MS = 30_000;

/** The largest 찬양 PPT the proxy will hand over (it caps this too). */
export const MAX_SONG_DECK_BYTES = 25 * 1024 * 1024;

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
