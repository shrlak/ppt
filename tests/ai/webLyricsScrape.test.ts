import { describe, expect, it } from 'vitest';
import {
  buildSearchQueries,
  decodeHtmlEntities,
  extractLyricBlock,
  extractSearchResultUrls,
  fetchLyricsCandidates,
  htmlToLines,
  isAllowedLyricsUrl,
  isBugsUrl,
  looksLikeLyricLine,
  lyricsHosts,
  scoreLyricBlock,
} from '../../worker/src/lyrics.js';
import {
  BUGS_ADAPTER,
  activeSourceAdapters,
  adapterForUrl,
  extractPageArtist,
  extractPageTitle,
} from '../../worker/src/lyricsSources.js';

// Placeholder verse text — the extraction rules care about line shape, not
// about any particular song.
const SAMPLE = ['가나다라 마바사 아자차', '카타파하 그 이름', '높이 불러 찬양하리', '영원토록 노래해'];

describe('buildSearchQueries', () => {
  it('asks for the worship-specific phrasing first', () => {
    expect(buildSearchQueries('청년의 기도')).toEqual(['청년의 기도 찬양 가사', '청년의 기도 가사']);
  });

  it('has nothing to search for without a title', () => {
    expect(buildSearchQueries('   ')).toEqual([]);
  });

  it('leads with the artist when one is known, to narrow a shared title', () => {
    expect(buildSearchQueries('청년의 기도', '어느 사역팀')[0]).toBe('청년의 기도 어느 사역팀 가사');
  });
});

describe('isAllowedLyricsUrl', () => {
  it('accepts https pages on allowlisted hosts', () => {
    expect(isAllowedLyricsUrl('https://ccm.co.kr/song/1234')).toBe(true);
    expect(isAllowedLyricsUrl('https://m.blog.naver.com/someone/1')).toBe(true);
  });

  it('refuses anything else, so the proxy cannot be aimed elsewhere', () => {
    expect(isAllowedLyricsUrl('https://evil.example.com/x')).toBe(false);
    expect(isAllowedLyricsUrl('http://ccm.co.kr/song/1234')).toBe(false);
    // Internal addresses are the reason the allowlist exists.
    expect(isAllowedLyricsUrl('https://169.254.169.254/latest/meta-data')).toBe(false);
    expect(isAllowedLyricsUrl('not a url')).toBe(false);
  });

  it('is not fooled by an allowlisted host in the path or userinfo', () => {
    expect(isAllowedLyricsUrl('https://evil.example.com/ccm.co.kr/song')).toBe(false);
    expect(isAllowedLyricsUrl('https://ccm.co.kr@evil.example.com/song')).toBe(false);
  });
});

describe('extractSearchResultUrls', () => {
  it('unwraps the DuckDuckGo redirector and keeps only allowlisted results', () => {
    const html = `
      <a href="/l/?uddg=https%3A%2F%2Fccm.co.kr%2Fsong%2F1">first</a>
      <a href="/l/?uddg=https%3A%2F%2Fevil.example.com%2Fx">blocked</a>
      <a href="https://m.blog.naver.com/writer/222">second</a>
    `;
    expect(extractSearchResultUrls(html)).toEqual([
      'https://ccm.co.kr/song/1',
      'https://m.blog.naver.com/writer/222',
    ]);
  });

  it('deduplicates and respects the candidate cap', () => {
    const html = Array.from({ length: 6 }, () => '<a href="https://ccm.co.kr/song/9">x</a>').join('');
    expect(extractSearchResultUrls(html)).toEqual(['https://ccm.co.kr/song/9']);
    const many = [1, 2, 3, 4, 5].map((n) => `<a href="https://ccm.co.kr/song/${n}">x</a>`).join('');
    expect(extractSearchResultUrls(many, 2)).toHaveLength(2);
  });
});

describe('decodeHtmlEntities', () => {
  it('decodes the entities lyric markup actually uses', () => {
    expect(decodeHtmlEntities('&lt;후렴&gt; &amp; &quot;노래&quot;&nbsp;끝')).toBe('<후렴> & "노래" 끝');
    expect(decodeHtmlEntities('&#54620;&#44544;')).toBe('한글');
  });
});

describe('htmlToLines', () => {
  it('turns <br> and block tags into line breaks', () => {
    const html = `<div>${SAMPLE[0]}<br>${SAMPLE[1]}</div><p>${SAMPLE[2]}</p>`;
    expect(htmlToLines(html)).toEqual([SAMPLE[0], SAMPLE[1], SAMPLE[2]]);
  });

  it('drops script and style content before it can look like text', () => {
    const html = `<script>var lyrics = "가짜 가사 여기 있음";</script><p>${SAMPLE[0]}</p>`;
    expect(htmlToLines(html)).toEqual([SAMPLE[0]]);
  });
});

describe('looksLikeLyricLine', () => {
  it('accepts short Korean lines and part headings', () => {
    expect(looksLikeLyricLine(SAMPLE[0])).toBe(true);
    expect(looksLikeLyricLine('후렴')).toBe(true);
    expect(looksLikeLyricLine('Verse 2')).toBe(true);
  });

  it('rejects site furniture and long prose', () => {
    expect(looksLikeLyricLine('로그인')).toBe(false);
    expect(looksLikeLyricLine('https://ccm.co.kr/song/1')).toBe(false);
    expect(looksLikeLyricLine('Copyright 2026 All rights reserved')).toBe(false);
    expect(looksLikeLyricLine('이 곡은 '.repeat(20))).toBe(false);
  });
});

describe('extractLyricBlock', () => {
  it('picks the longest run of lyric-shaped lines', () => {
    const lines = ['홈', '검색', ...SAMPLE, '댓글 0개', '이웃추가'];
    expect(extractLyricBlock(lines)).toEqual(SAMPLE);
  });

  it('tolerates one stray line inside the block rather than splitting it', () => {
    const lines = [...SAMPLE, '· · ·'.replace(/·/g, '광고'), ...SAMPLE];
    expect(extractLyricBlock(lines).length).toBeGreaterThan(SAMPLE.length);
  });

  it('returns nothing when the page has no lyric block at all', () => {
    expect(extractLyricBlock(['홈', '로그인', '검색'])).toEqual([]);
    expect(extractLyricBlock(SAMPLE.slice(0, 2))).toEqual([]);
  });
});

describe('scoreLyricBlock', () => {
  it('prefers a page that actually names the song', () => {
    const named = scoreLyricBlock(SAMPLE, '청년의 기도', '청년의 기도 - 찬양 가사');
    const unnamed = scoreLyricBlock(SAMPLE, '청년의 기도', '다른 곡 가사');
    expect(named).toBeGreaterThan(unnamed);
  });

  it('scores an empty block at zero', () => {
    expect(scoreLyricBlock([], '청년의 기도', '청년의 기도')).toBe(0);
  });
});

describe('source adapters', () => {
  it('claims a URL only for the adapter that owns its host', () => {
    expect(adapterForUrl('https://ccm.co.kr/song/1')?.id).toBe('ccm');
    expect(adapterForUrl('https://blog.naver.com/post')?.id).toBe('naver-blog');
    expect(adapterForUrl('https://evil.test/ccm.co.kr')).toBeNull();
    // http is never read, only https.
    expect(adapterForUrl('http://ccm.co.kr/song/1')).toBeNull();
  });

  it('trusts a dedicated lyrics database above a personal blog', () => {
    const ccm = adapterForUrl('https://ccm.co.kr/song/1');
    const blog = adapterForUrl('https://blog.naver.com/post');
    expect(ccm!.trust).toBeGreaterThan(blog!.trust);
  });

  it('reads the page title without the site name stuck to it', () => {
    expect(extractPageTitle('<title>은혜의 노래 - CCM 가사</title>')).toBe('은혜의 노래');
    expect(
      extractPageTitle('<meta property="og:title" content="은혜의 노래"><title>무시됨</title>'),
    ).toBe('은혜의 노래');
  });

  it('only reads an artist that sits behind an explicit label', () => {
    // A wrong artist is worse than none: artist agreement is what keeps two
    // different songs with the same title apart.
    expect(extractPageArtist('<div>아티스트 : 어느 사역팀</div>')).toBe('어느 사역팀');
    expect(extractPageArtist('<p>어느 사역팀이 부른 좋은 곡입니다</p>')).toBe('');
    expect(extractPageArtist('<div>아티스트</div><div>어느 사역팀</div>')).toBe('');
  });
});

describe('Bugs scraping permission', () => {
  it('is off unless the deployment recorded permission', () => {
    expect(activeSourceAdapters({}).some((adapter) => adapter.id === 'bugs')).toBe(false);
    expect(activeSourceAdapters({ BUGS_SCRAPING_ALLOWED: 'false' }).some((a) => a.id === 'bugs')).toBe(false);
    expect(activeSourceAdapters({ BUGS_SCRAPING_ALLOWED: 'yes' }).some((a) => a.id === 'bugs')).toBe(false);
    expect(activeSourceAdapters({ BUGS_SCRAPING_ALLOWED: 'true' }).some((a) => a.id === 'bugs')).toBe(true);
  });

  it('keeps Bugs hosts out of the fetch allowlist while permission is off', () => {
    for (const host of BUGS_ADAPTER.hosts) {
      expect(lyricsHosts({})).not.toContain(host);
      expect(lyricsHosts({ BUGS_SCRAPING_ALLOWED: 'true' })).toContain(host);
    }
    expect(isAllowedLyricsUrl('https://music.bugs.co.kr/track/1')).toBe(false);
    expect(isBugsUrl('https://music.bugs.co.kr/track/1')).toBe(true);
  });

  it('never fetches a Bugs page without permission, but may offer the link', async () => {
    const fetched: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      fetched.push(url);
      if (url.includes('duckduckgo')) {
        return new Response(
          '<a href="https://music.bugs.co.kr/track/1">벅스</a><a href="https://ccm.co.kr/song/1">가사</a>',
          { status: 200, headers: { 'Content-Type': 'text/html' } },
        );
      }
      return new Response(
        `<title>가나다라 마바사</title><div>${SAMPLE.join('<br>')}</div>`,
        { status: 200, headers: { 'Content-Type': 'text/html' } },
      );
    }) as typeof fetch;

    try {
      const result = await fetchLyricsCandidates({ title: '가나다라 마바사', sample: '' }, {});
      expect(fetched.some((url) => url.includes('bugs.co.kr'))).toBe(false);
      expect(result.links.map((link) => link.url)).toEqual(['https://music.bugs.co.kr/track/1']);
      expect(result.links[0]).toMatchObject({ source: 'bugs' });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('candidate lookup', () => {
  it('re-checks the host it actually landed on before reading the body', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('duckduckgo')) {
        return new Response('<a href="https://ccm.co.kr/song/1">가사</a>', {
          status: 200,
          headers: { 'Content-Type': 'text/html' },
        });
      }
      // The allowlisted host redirected somewhere it is not allowed to send us.
      return Object.defineProperty(
        new Response(`<title>가나다라 마바사</title><div>${SAMPLE.join('<br>')}</div>`, { status: 200 }),
        'url',
        { value: 'https://elsewhere.test/song/1' },
      );
    }) as typeof fetch;

    try {
      const result = await fetchLyricsCandidates({ title: '가나다라 마바사', sample: '' }, {});
      expect(result.candidates).toEqual([]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('returns scored candidates carrying no raw HTML', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('duckduckgo')) {
        return new Response('<a href="https://ccm.co.kr/song/1">가사</a>', {
          status: 200,
          headers: { 'Content-Type': 'text/html' },
        });
      }
      return new Response(
        `<title>가나다라 마바사 - CCM</title><div>아티스트 : 어느 사역팀</div><div>${SAMPLE.join('<br>')}</div>`,
        { status: 200 },
      );
    }) as typeof fetch;

    try {
      const result = await fetchLyricsCandidates(
        { title: '가나다라 마바사', artist: '어느 사역팀', sample: SAMPLE.join('').replace(/\s+/g, '') },
        {},
      );
      expect(result.candidates).toHaveLength(1);
      expect(result.candidates[0]).toMatchObject({ host: 'ccm.co.kr', source: 'ccm', decision: 'auto' });
      expect(JSON.stringify(result)).not.toMatch(/<div|<title/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
