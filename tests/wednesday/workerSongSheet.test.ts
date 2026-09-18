import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_SHEET_IMAGE_BYTES,
  buildSheetQueries,
  extractSheetImageResults,
  fetchSheetImage,
  imageHostsOnly,
  imageMimeType,
  isAllowedSheetImageUrl,
  isImageBytes,
  looksLikeImageUrl,
} from '../../worker/src/songSheet.js';
import { AUTO_ATTACH_SCORE, rankSongMatches, scoreSongMatch, signSongPptToken } from '../../worker/src/songPpt.js';
import { createWorkerHarness } from '../support/workerHarness';
import { DEFAULT_ADMIN_PASSWORD } from '../../worker/src/config.js';

const SHEET = 'https://postfiles.pstatic.net/MjAy/악보.png';
const ELSEWHERE = 'https://sheets.example.test/praise/score.jpg';

function pngBytes(size = 64): Uint8Array {
  const bytes = new Uint8Array(size);
  bytes.set([0x89, 0x50, 0x4e, 0x47]);
  return bytes;
}

function jpegBytes(size = 64): Uint8Array {
  const bytes = new Uint8Array(size);
  bytes.set([0xff, 0xd8, 0xff, 0xe0]);
  return bytes;
}

function bodyOf(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

/** Bing's image results carry the real URL as JSON in an m="" attribute. */
function searchPage(entries: { murl: string; t?: string; purl?: string }[]): string {
  return entries
    .map((entry) => `<a class="iusc" m="${JSON.stringify(entry).replace(/"/g, '&quot;')}">hit</a>`)
    .join('\n');
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('악보 사진 search', () => {
  it('asks for the sheet music, not the song file', () => {
    expect(buildSheetQueries(' 주 은혜임을 ')).toEqual(['주 은혜임을 악보', '주 은혜임을 찬양 악보']);
    expect(buildSheetQueries('  ')).toEqual([]);
  });

  it('reads each hit out of the search page', () => {
    const html = searchPage([
      { murl: SHEET, t: '주 은혜임을 악보', purl: 'https://blog.naver.com/x/1' },
      { murl: ELSEWHERE, t: '주 은혜임을 (C key)' },
      { murl: 'https://sheets.example.test/page', t: '이미지가 아님' },
    ]);
    const results = extractSheetImageResults(html);

    expect(results.map((hit) => hit.url)).toEqual([SHEET, ELSEWHERE]);
    expect(results[0]).toMatchObject({ host: 'postfiles.pstatic.net', title: '주 은혜임을 악보' });
    expect(results[0].pageUrl).toBe('https://blog.naver.com/x/1');
  });

  it('recognizes an image address', () => {
    expect(looksLikeImageUrl('https://x.test/a.png?type=w800')).toBe(true);
    expect(looksLikeImageUrl('https://x.test/a.JPEG')).toBe(true);
    expect(looksLikeImageUrl('https://x.test/post/1')).toBe(false);
  });
});

describe('악보 사진 host policy', () => {
  it('takes images from any https host, because 악보 live everywhere', () => {
    // Unlike a 찬양 PPT, an 악보 image is on whatever CDN its blog uses, so
    // these are gated by what comes back rather than by an allowlist.
    expect(isAllowedSheetImageUrl(ELSEWHERE)).toBe(true);
    expect(isAllowedSheetImageUrl(SHEET)).toBe(true);
    expect(isAllowedSheetImageUrl('http://sheets.example.test/a.png')).toBe(false);
  });

  it('never fetches an address that resolves inside', () => {
    expect(isAllowedSheetImageUrl('https://localhost/a.png')).toBe(false);
    expect(isAllowedSheetImageUrl('https://127.0.0.1/a.png')).toBe(false);
    expect(isAllowedSheetImageUrl('https://169.254.169.254/a.png')).toBe(false);
    expect(isAllowedSheetImageUrl('https://printer.local/a.png')).toBe(false);
  });

  it('falls back to the 찬양 PPT allowlist when a deployment asks for it', () => {
    const env = { WEDNESDAY_IMAGE_HOSTS_ONLY: 'true' };
    expect(imageHostsOnly(env)).toBe(true);
    expect(isAllowedSheetImageUrl(SHEET, env)).toBe(true);
    expect(isAllowedSheetImageUrl(ELSEWHERE, env)).toBe(false);
  });
});

describe('downloading an 악보 사진', () => {
  function stubFetch(handler: (url: string) => Response) {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | Request) => handler(typeof input === 'string' ? input : input.url)),
    );
  }

  it('returns the bytes and says which kind they are', async () => {
    stubFetch(() => new Response(bodyOf(jpegBytes()), { status: 200 }));
    const image = await fetchSheetImage(ELSEWHERE);
    expect(image.mimeType).toBe('image/jpeg');
    expect(image.bytes.length).toBe(64);
  });

  it('refuses anything that is not a PNG or JPEG', async () => {
    // A missing file often comes back as an HTML page with HTTP 200, and
    // PowerPoint cannot put that on a slide.
    stubFetch(() => new Response('<html>not found</html>', { status: 200 }));
    await expect(fetchSheetImage(ELSEWHERE)).rejects.toThrow('PNG·JPG 이미지가 아닙니다');
  });

  it('refuses one that is too large, and one that redirects out of bounds', async () => {
    stubFetch(
      () =>
        new Response(bodyOf(pngBytes()), {
          status: 200,
          headers: { 'Content-Length': String(MAX_SHEET_IMAGE_BYTES + 1) },
        }),
    );
    await expect(fetchSheetImage(ELSEWHERE)).rejects.toThrow('너무 큽니다');

    stubFetch(() => {
      const response = new Response(bodyOf(pngBytes()), { status: 200 });
      Object.defineProperty(response, 'url', { value: 'https://127.0.0.1/a.png' });
      return response;
    });
    await expect(fetchSheetImage(ELSEWHERE)).rejects.toThrow('허용되지 않은 주소');
  });

  it('knows a PNG from a JPEG from neither', () => {
    expect(isImageBytes(pngBytes())).toBe(true);
    expect(isImageBytes(jpegBytes())).toBe(true);
    expect(isImageBytes(new Uint8Array([0x50, 0x4b, 0x03, 0x04]))).toBe(false);
    expect(imageMimeType(pngBytes())).toBe('image/png');
    expect(imageMimeType(jpegBytes())).toBe('image/jpeg');
  });
});

describe('matching a hit to the song', () => {
  it('is sure only when the hit carries the title', () => {
    expect(scoreSongMatch('주 은혜임을', '주 은혜임을 악보 (D key)')).toBe(1);
    expect(scoreSongMatch('주 은혜임을', '주은혜임을ppt')).toBe(1);
    expect(scoreSongMatch('주 은혜임을', '하나님의 은혜 악보')).toBeLessThan(AUTO_ATTACH_SCORE);
    expect(scoreSongMatch('', 'anything')).toBe(0);
  });

  it('ranks hits and marks which ones may be attached unasked', () => {
    const ranked = rankSongMatches('주 은혜임을', [
      { title: '다른 찬양 악보', url: 'https://x.test/other.png' },
      { title: '', url: 'https://x.test/주%20은혜임을.png' },
    ]);
    // The second hit says nothing in its title, but its file name is the song.
    expect(ranked[0].url).toBe('https://x.test/주%20은혜임을.png');
    expect(ranked[0].decision).toBe('auto');
    expect(ranked[1].decision).toBe('review');
  });
});

describe('the 악보 사진 routes', () => {
  it('returns ranked hits with tokens instead of URLs', async () => {
    const harness = createWorkerHarness();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(searchPage([{ murl: SHEET, t: '주 은혜임을 악보' }]), { status: 200 })),
    );

    const response = await harness.fetch('/wednesday/songs/sheets?title=주 은혜임을');
    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      candidates: { url: string; token: string; decision: string }[];
    };
    expect(payload.candidates).toHaveLength(1);
    expect(payload.candidates[0].decision).toBe('auto');
    expect(payload.candidates[0].token).toBeTruthy();
  });

  it('serves one image for a token it signed', async () => {
    const harness = createWorkerHarness();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(bodyOf(pngBytes(128)), { status: 200 })));

    const token = await signSongPptToken(SHEET, DEFAULT_ADMIN_PASSWORD);
    const response = await harness.fetch('/wednesday/songs/image', {
      method: 'POST',
      body: JSON.stringify({ token }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('image/png');
    expect((await response.arrayBuffer()).byteLength).toBe(128);
  });

  it('needs a title, and refuses an address it cannot fetch', async () => {
    const harness = createWorkerHarness({ WEDNESDAY_IMAGE_HOSTS_ONLY: 'true' });
    expect((await harness.fetch('/wednesday/songs/sheets?title=')).status).toBe(400);

    const refused = await harness.fetch('/wednesday/songs/image', {
      method: 'POST',
      body: JSON.stringify({ url: ELSEWHERE }),
    });
    expect(refused.status).toBe(400);
  });
});
