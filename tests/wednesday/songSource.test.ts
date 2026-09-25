import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { autoAttachSong } from '../../src/wednesday/songSource';

const PROXY = 'https://proxy.test';

interface Hit {
  url: string;
  pageUrl?: string;
  decision: 'auto' | 'review';
}

const sheet = (url: string, pageUrl: string | undefined, decision: 'auto' | 'review' = 'auto'): Hit => ({
  url,
  pageUrl,
  decision,
});

/** A proxy that finds no 찬양 PPT, these 악보 사진, and serves every image but `broken`. */
function stubProxy(sheets: Hit[], broken: string[] = []) {
  const downloaded: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.url;
      if (url.startsWith(`${PROXY}/wednesday/songs/sheets?`)) {
        return Response.json({
          candidates: sheets.map((hit) => ({ ...hit, token: hit.url, host: new URL(hit.url).host, title: '악보' })),
        });
      }
      if (url.startsWith(`${PROXY}/wednesday/songs?`)) return Response.json({ candidates: [] });
      if (url === `${PROXY}/wednesday/songs/image`) {
        const { token } = JSON.parse(String(init?.body)) as { token: string };
        if (broken.includes(token)) return Response.json({ error: 'HTTP 404' }, { status: 502 });
        downloaded.push(token);
        return new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), { headers: { 'Content-Type': 'image/png' } });
      }
      return new Response('not found', { status: 404 });
    }),
  );
  return downloaded;
}

beforeEach(() => {
  vi.stubEnv('VITE_RECOGNITION_PROXY_URL', PROXY);
  // Node has no image decoder; every picture here is a 악보 page's size.
  vi.stubGlobal('createImageBitmap', async () => ({ width: 900, height: 1273, close() {} }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('autoAttachSong with 악보 사진', () => {
  it('attaches the pages of one post, never a sure image from another', async () => {
    const downloaded = stubProxy([
      sheet('https://img.test/a1.png', 'https://blog.test/a'),
      // Another blog's 악보 of the same song is another arrangement.
      sheet('https://img.test/b1.png', 'https://blog.test/b'),
      sheet('https://img.test/a2.png', 'https://blog.test/a'),
    ]);

    const found = await autoAttachSong('주 품에');
    expect(found.kind).toBe('images');
    expect(downloaded).toEqual(['https://img.test/a1.png', 'https://img.test/a2.png']);
    if (found.kind !== 'images') return;
    expect(found.images.map((image) => image.sourceUrl)).toEqual(['https://img.test/a1.png', 'https://img.test/a2.png']);
    // What was not taken stays on offer.
    expect(found.candidates.map((candidate) => candidate.url)).toEqual(['https://img.test/b1.png']);
  });

  it('moves on to the next sure image when one will not come', async () => {
    const downloaded = stubProxy(
      [
        sheet('https://img.test/dead.png', 'https://blog.test/a'),
        sheet('https://img.test/guess.png', 'https://blog.test/c', 'review'),
        sheet('https://img.test/b1.png', 'https://blog.test/b'),
      ],
      ['https://img.test/dead.png'],
    );

    const found = await autoAttachSong('주 품에');
    expect(found.kind).toBe('images');
    // A guess is never attached unasked.
    expect(downloaded).toEqual(['https://img.test/b1.png']);
  });

  it('attaches nothing when nothing is sure', async () => {
    const downloaded = stubProxy([sheet('https://img.test/guess.png', 'https://blog.test/c', 'review')]);

    const found = await autoAttachSong('주 품에');
    expect(found.kind).toBe('none');
    expect(downloaded).toEqual([]);
  });
});
