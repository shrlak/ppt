import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_SHEET_IMAGE_BYTES,
  buildSheetQueries,
  extractNaverImageResults,
  extractSheetImageResults,
  fetchSheetImage,
  fetchSheetImageCandidates,
  fetchableImageUrl,
  imageHostsOnly,
  imageMimeType,
  isAllowedSheetImageUrl,
  isImageBytes,
  keysNamed,
  looksLikeImageUrl,
  rankSheetImages,
  sheetLikeness,
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

/**
 * 네이버 이미지 검색 renders from an `items: [...]` array in its own script;
 * these are the fields the proxy reads, as the real page spells them.
 */
function naverImagePage(
  items: { originalUrl: string; link?: string; title?: string; orgWidth?: number; orgHeight?: number }[],
): string {
  return `<script>naver.search.image = { total: 50, items: ${JSON.stringify(
    items.map((item) => ({ type: 'image', source: '네이버 블로그', ...item })),
  )}, more: "[x]" };</script>`;
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

  it('reads 네이버 이미지 검색 results, with each original\'s size', () => {
    const html = naverImagePage([
      {
        originalUrl: 'http://blogfiles.naver.net/MjAy/MDAx.PNG.sweetvoice3/1678344299120.png',
        link: 'https://blog.naver.com/sweetvoice3/223034650901',
        title: '[악보] 나의 반석이신 하나님 F Major 악보',
        orgWidth: 900,
        orgHeight: 1273,
      },
      // A GIF cannot become a slide, and neither can what only speaks http.
      { originalUrl: 'http://blogfiles.naver.net/2013/ccmlove_GIF/score.gif', title: '악보 [gif]' },
      { originalUrl: 'http://www.akbobada.com/sampleimg/97824.png', title: '악보바다' },
      { originalUrl: 'https://cdn.example.test/score.jpg', link: 'https://example.test/1', title: '"은혜" 악보' },
    ]);
    const results = extractNaverImageResults(html);

    expect(results.map((hit) => hit.url)).toEqual([
      // 네이버's own file hosts answer https too.
      'https://blogfiles.naver.net/MjAy/MDAx.PNG.sweetvoice3/1678344299120.png',
      'https://cdn.example.test/score.jpg',
    ]);
    expect(results[0]).toMatchObject({
      host: 'blogfiles.naver.net',
      title: '[악보] 나의 반석이신 하나님 F Major 악보',
      pageUrl: 'https://blog.naver.com/sweetvoice3/223034650901',
      width: 900,
      height: 1273,
    });
    expect(extractNaverImageResults('<html>no results</html>')).toEqual([]);
  });

  it('upgrades only 네이버\'s own http file hosts to https', () => {
    expect(fetchableImageUrl('http://postfiles.pstatic.net/a/b.jpg')).toBe('https://postfiles.pstatic.net/a/b.jpg');
    expect(fetchableImageUrl('https://x.test/a.png')).toBe('https://x.test/a.png');
    expect(fetchableImageUrl('http://x.test/a.png')).toBeNull();
    expect(fetchableImageUrl('http://evil-naver.net.example/a.png')).toBeNull();
    expect(fetchableImageUrl('not a url')).toBeNull();
  });

  it('tells a 악보 page from a still, a thumbnail or another part', () => {
    expect(sheetLikeness({ title: '하늘 위에 주님 밖에 악보', width: 900, height: 1273 })).toBe(4);
    expect(sheetLikeness({ title: '하늘 위에 주님 밖에 악보', width: 600, height: 848 })).toBe(3);
    expect(sheetLikeness({ title: '[ccm] 하늘 위에 주님 밖에', width: 522, height: 700 })).toBe(1);
    // A week's 콘티 carries other songs' 악보 too.
    expect(sheetLikeness({ title: '[A코드 찬양] 나의 반석이신 하나님 (콘티/가사)', width: 900, height: 1273 })).toBe(0);
    // A landscape picture its post does not call 악보 is a video still or a photo.
    expect(sheetLikeness({ title: '하늘 위에 주님 밖에 / 플루트 가든', width: 1920, height: 1080 })).toBe(0);
    expect(sheetLikeness({ title: '하늘 위에 주님 밖에', width: 1920, height: 1080 })).toBe(0);
    // Too small to project, another instrument's part, a paid preview.
    expect(sheetLikeness({ title: '악보', width: 300, height: 400 })).toBe(0);
    expect(sheetLikeness({ title: '일렉기타 악보', width: 600, height: 900 })).toBe(0);
    expect(sheetLikeness({ title: '악보', url: 'https://www.akbobada.com/a.png', width: 992, height: 1403 })).toBe(0);
  });

  it('attaches the most sheet-like sure hit, with the other pages of its post', () => {
    const post = 'https://blog.naver.com/church/1';
    const hit = (url: string, title: string, width: number, height: number, pageUrl?: string) => ({
      url: `https://blogfiles.naver.net/${url}`,
      host: 'blogfiles.naver.net',
      title,
      width,
      height,
      pageUrl,
    });
    const ranked = rankSheetImages('주 품에', [
      hit('photo.jpg', '주 품에 드럼커버', 740, 416),
      hit('landscape.jpg', '악보 - 주 품에 C D', 3659, 3068, 'https://blog.naver.com/other/2'),
      hit('elsewhere.jpg', '주님 품에 악보', 900, 1273),
      hit('page2.png', '주품에(still) 코드악보', 1463, 2064, post),
      hit('unrelated.png', '다른 곡 악보', 900, 1273, post),
      hit('page1.png', '주품에(still) 코드악보', 1463, 2064, post),
    ]);

    expect(ranked.map((entry) => [entry.url.split('/').pop(), entry.decision])).toEqual([
      // The best hit's post, in page order…
      ['page1.png', 'auto'],
      ['page2.png', 'auto'],
      // …then the other sure hits, then the guesses: 주님 품에 is a different
      // song that merely contains the title, and a drum cover is no 악보.
      ['landscape.jpg', 'auto'],
      ['elsewhere.jpg', 'review'],
      ['photo.jpg', 'review'],
      ['unrelated.png', 'review'],
    ]);
  });

  it('never takes a post\'s other keys, or a differently sized picture, for its next page', () => {
    const post = 'https://blog.naver.com/church/1';
    const hit = (url: string, title: string, width: number, height: number) => ({
      url: `https://blogfiles.naver.net/${url}`,
      host: 'blogfiles.naver.net',
      title,
      width,
      height,
      pageUrl: post,
    });
    expect(keysNamed('악보) 나의 반석이신 하나님 F, G, A (나비워십ver.)')).toBe(3);
    expect(keysNamed('주품에(still) 여러가지 조성 코드악보 C,F,G,B♭ key')).toBe(4);
    expect(keysNamed('[CCM 악보] 나의 반석이신 하나님(Ascribe Greatness To Our God) A코드')).toBe(1);

    const keys = rankSheetImages('나의 반석이신 하나님', [
      hit('F.png', '악보) 나의 반석이신 하나님 F, G, A', 900, 1535),
      hit('G.png', '악보) 나의 반석이신 하나님 F, G, A', 900, 1535),
    ]);
    expect(keys.map((entry) => entry.decision)).toEqual(['auto', 'review']);

    const photo = rankSheetImages('나의 반석이신 하나님', [
      hit('1.png', '나의 반석이신 하나님 악보', 900, 1273),
      hit('2.png', '나의 반석이신 하나님 악보', 1600, 1200),
    ]);
    expect(photo.map((entry) => entry.decision)).toEqual(['auto', 'review']);
  });

  it('asks 네이버 first and only falls back to Bing when it has nothing', async () => {
    const asked: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | Request) => {
        const url = typeof input === 'string' ? input : input.url;
        asked.push(new URL(url).hostname);
        if (url.startsWith('https://search.naver.com/')) {
          return new Response(
            naverImagePage([
              {
                originalUrl: 'http://blogfiles.naver.net/a/score.png',
                link: 'https://blog.naver.com/church/1',
                title: '주 은혜임을 악보',
                orgWidth: 900,
                orgHeight: 1273,
              },
            ]),
          );
        }
        return new Response(searchPage([{ murl: ELSEWHERE, t: '주 은혜임을 악보' }]));
      }),
    );

    const found = await fetchSheetImageCandidates('주 은혜임을', {}, async (url) => `signed:${url}`);
    expect(found.candidates.map((candidate) => candidate.url)).toEqual(['https://blogfiles.naver.net/a/score.png']);
    expect(found.candidates[0]).toMatchObject({ decision: 'auto', token: 'signed:https://blogfiles.naver.net/a/score.png' });
    expect(asked.every((host) => host === 'search.naver.com')).toBe(true);

    // 네이버 answering with nothing sends the same query on to Bing.
    asked.length = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | Request) => {
        const url = typeof input === 'string' ? input : input.url;
        asked.push(new URL(url).hostname);
        if (url.startsWith('https://search.naver.com/')) return new Response('<html></html>');
        return new Response(searchPage([{ murl: ELSEWHERE, t: '주 은혜임을 악보' }]));
      }),
    );
    const fallback = await fetchSheetImageCandidates('주 은혜임을');
    expect(fallback.candidates.map((candidate) => candidate.url)).toEqual([ELSEWHERE]);
    expect(asked.slice(0, 2)).toEqual(['search.naver.com', 'www.bing.com']);
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

  it('needs a short title to stand on its own, not inside a longer name', () => {
    // 은혜 is inside 은혜로다 and 어머님은혜; 주 품에 inside 주님 품에.
    expect(scoreSongMatch('은혜', '"은혜" 찬양 악보')).toBe(1);
    expect(scoreSongMatch('은혜', '내가 누려왔던 모든 것들이 (은혜) ppt')).toBe(1);
    expect(scoreSongMatch('은혜', '은혜ppt')).toBe(1);
    expect(scoreSongMatch('은혜', '악보 - 은혜로다')).toBeLessThan(AUTO_ATTACH_SCORE);
    expect(scoreSongMatch('은혜', '어머님은혜 칼림바 악보')).toBeLessThan(AUTO_ATTACH_SCORE);
    expect(scoreSongMatch('주 품에', '주품에(still) 코드악보')).toBe(1);
    expect(scoreSongMatch('주 품에', '주님 품에 안겨')).toBeLessThan(AUTO_ATTACH_SCORE);
    // A longer title is specific enough as it is.
    expect(scoreSongMatch('나의 반석이신 하나님', '나의 반석이신하나님_A')).toBe(1);
  });

  it('reads a file name in the old EUC-KR encoding without failing', () => {
    // 네이버's older files are named %B3%AA…, which decodeURIComponent throws on.
    const ranked = rankSongMatches('나의 반석이신 하나님', [
      { title: '나의 반석이신 하나님 악보', url: 'https://blogfiles.naver.net/2014/%B3%AA%C0%C7.jpg' },
    ]);
    expect(ranked[0].decision).toBe('auto');
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
