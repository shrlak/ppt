import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NO_SHEET_MUSIC_MESSAGE, autoAttachSong, downloadSongPpt, inSearchOrder } from '../../src/wednesday/songSource';
import { deckOf, lyricsSlides, sheetSlides } from '../support/songDeckFixtures';

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

describe('autoAttachSong with 찬양 PPT', () => {
  /** A proxy whose PPT search finds `decks` (all sure), with these 악보 사진 behind them. */
  function stubDecks(decks: Record<string, Uint8Array>, sheets: Hit[] = []) {
    const downloaded: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | Request, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.url;
        if (url.startsWith(`${PROXY}/wednesday/songs?`)) {
          return Response.json({
            candidates: Object.keys(decks).map((deckUrl) => ({
              token: deckUrl,
              url: deckUrl,
              host: new URL(deckUrl).host,
              title: '은혜 PPT',
              direct: true,
              decision: 'auto',
            })),
          });
        }
        if (url.startsWith(`${PROXY}/wednesday/songs/sheets?`)) {
          return Response.json({
            candidates: sheets.map((hit) => ({ ...hit, token: hit.url, host: new URL(hit.url).host, title: '악보' })),
          });
        }
        const { token } = JSON.parse(String(init?.body)) as { token: string };
        downloaded.push(token);
        if (url === `${PROXY}/wednesday/songs/file`) return new Response(decks[token].slice().buffer as ArrayBuffer);
        return new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), { headers: { 'Content-Type': 'image/png' } });
      }),
    );
    return downloaded;
  }

  it('passes over a 가사 PPT for the next one that has the 악보', async () => {
    const downloaded = stubDecks({
      'https://a.tistory.com/lyrics.pptx': await deckOf(lyricsSlides(3)),
      'https://b.tistory.com/sheet.pptx': await deckOf(sheetSlides(3)),
    });

    const found = await autoAttachSong('은혜');
    expect(downloaded).toEqual(['https://a.tistory.com/lyrics.pptx', 'https://b.tistory.com/sheet.pptx']);
    expect(found.kind).toBe('deck');
    if (found.kind === 'deck') expect(found.candidate.url).toBe('https://b.tistory.com/sheet.pptx');
  });

  it('takes the 악보 사진 when the only PPT is 가사', async () => {
    const downloaded = stubDecks({ 'https://a.tistory.com/lyrics.pptx': await deckOf(lyricsSlides(3)) }, [
      sheet('https://img.test/a1.png', 'https://blog.test/a'),
    ]);

    const found = await autoAttachSong('은혜');
    expect(found.kind).toBe('images');
    expect(downloaded).toEqual(['https://a.tistory.com/lyrics.pptx', 'https://img.test/a1.png']);
  });

  it('says why when a 가사 PPT is picked by hand', async () => {
    stubDecks({ 'https://a.tistory.com/lyrics.pptx': await deckOf(lyricsSlides(3)) });
    await expect(
      downloadSongPpt({ token: 'https://a.tistory.com/lyrics.pptx', url: 'https://a.tistory.com/lyrics.pptx' }),
    ).rejects.toThrow(NO_SHEET_MUSIC_MESSAGE);
  });
});

describe('the 찬양 PPT hits offered to choose from', () => {
  it('lists Google\'s results first, in Google\'s order, and the rest as the proxy ranked them', () => {
    const hits: { url: string; google?: number }[] = [
      { url: 'naver-1' },
      { url: 'google-3', google: 3 },
      { url: 'daum-1' },
      { url: 'google-1', google: 1 },
      { url: 'google-2', google: 2 },
    ];
    expect(inSearchOrder(hits).map((hit) => hit.url)).toEqual(['google-1', 'google-2', 'google-3', 'naver-1', 'daum-1']);
    // Without Google, the proxy's ranking stands.
    const unranked: { url: string; google?: number }[] = [{ url: 'b' }, { url: 'a' }];
    expect(inSearchOrder(unranked).map((hit) => hit.url)).toEqual(['b', 'a']);
  });

  it('offers them in that order when nothing is sure, while the sure-hit tries keep the ranking', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | Request) => {
        const url = typeof input === 'string' ? input : input.url;
        if (url.startsWith(`${PROXY}/wednesday/songs?`)) {
          return Response.json({
            candidates: [
              { token: 'n', url: 'https://blog.naver.com/a/1', host: 'blog.naver.com', title: '은혜 PPT', direct: false, decision: 'review' },
              { token: 'g2', url: 'https://b.tistory.com/2', host: 'b.tistory.com', title: '은혜 PPT', direct: false, decision: 'review', google: 2 },
              { token: 'g1', url: 'https://a.tistory.com/1', host: 'a.tistory.com', title: '은혜 PPT', direct: false, decision: 'review', google: 1 },
            ],
          });
        }
        if (url.startsWith(`${PROXY}/wednesday/songs/sheets?`)) return Response.json({ candidates: [] });
        return new Response('not found', { status: 404 });
      }),
    );

    const found = await autoAttachSong('은혜');
    expect(found.kind).toBe('none');
    if (found.kind !== 'none') return;
    expect(found.pptCandidates.map((candidate) => candidate.token)).toEqual(['g1', 'g2', 'n']);
  });
});
