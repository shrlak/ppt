import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const PROXY = 'https://proxy.test';

beforeEach(() => {
  vi.stubEnv('VITE_RECOGNITION_PROXY_URL', PROXY);
  // The proxy address is read when the module loads.
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

/** A scored page as the proxy returns it (placeholder lyrics). */
function page(id: string, score: number, decision: 'auto' | 'review') {
  return {
    id: `bugs:music.bugs.co.kr/track/${id}`,
    title: '곡',
    lines: ['가나다라 마바사', '아자차카 타파하'],
    url: `https://music.bugs.co.kr/track/${id}`,
    host: 'music.bugs.co.kr',
    source: 'bugs',
    score,
    titleScore: 1,
    artistScore: 0,
    lyricsScore: 0.8,
    decision,
  };
}

describe('fetchWebLyricsForTitles', () => {
  it('searches the title read off the 악보 and the conti title, and pools the pages', async () => {
    const asked: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const params = new URL(String(input)).searchParams;
        asked.push(params.get('title') ?? '');
        expect(params.get('sample')).toBe('가나다');
        return Response.json(
          params.get('title') === '주 신실하심 놀라워'
            ? { candidates: [page('1', 0.92, 'auto'), page('2', 0.5, 'review')], links: [] }
            : { candidates: [page('2', 0.7, 'review')], links: [{ url: 'https://ccm.co.kr/1', host: 'ccm.co.kr', source: 'ccm' }] },
        );
      }),
    );
    const { fetchWebLyricsForTitles } = await import('../../src/lib/lyrics/webLyrics');

    const lookup = await fetchWebLyricsForTitles(
      // The same title twice, and a placeholder, are asked about once / never.
      ['주 신실하심 놀라워', '주님의 은혜 넘치네', '주 신실하심  놀라워', '새 찬양 (1번)'],
      { sample: '가나다' },
    );

    expect(asked.sort()).toEqual(['주 신실하심 놀라워', '주님의 은혜 넘치네'].sort());
    // A page both searches found is kept once, at its better score; best first.
    expect(lookup.candidates.map((candidate) => [candidate.sourceUrl, candidate.score])).toEqual([
      ['https://music.bugs.co.kr/track/1', 0.92],
      ['https://music.bugs.co.kr/track/2', 0.7],
    ]);
    expect(lookup.candidates[0].decision).toBe('auto');
    expect(lookup.links.map((link) => link.url)).toEqual(['https://ccm.co.kr/1']);
  });

  it('asks nothing when there is no title to search', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const { fetchWebLyricsForTitles } = await import('../../src/lib/lyrics/webLyrics');
    expect(await fetchWebLyricsForTitles([undefined, '  '])).toEqual({ candidates: [], links: [] });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
