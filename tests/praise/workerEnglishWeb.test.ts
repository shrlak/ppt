import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  englishCandidateFromPage,
  englishLyricsQuery,
  englishTitleFrom,
  englishTitleFromHits,
  extractGeniusHits,
  fetchEnglishLyricsCandidates,
  geniusLyricsHtml,
  geniusSongTitle,
  GENIUS_SEARCH_ENDPOINT,
  isEnglishTitle,
  lineKind,
  lyricBlocks,
  originalLyricsQuery,
  pageLines,
  relevantHits,
} from '../../worker/src/praiseEnglishWeb.js';
import { GOOGLE_SEARCH_ENDPOINT } from '../../worker/src/songPpt.js';

// Made-up lyrics: the shapes real 영어 가사 posts take, none of their words.
const TITLE = '시험의 노래';

/** A 티스토리-style post: one <p> per line, a zero-width space between stanzas. */
function bilingualPost(): string {
  const p = (text: string) => `<p data-ke-size="size16"><span>${text}</span></p>\n`;
  const gap = p('​');
  return `<!doctype html><html><head><title>${TITLE} 영어 가사 :: 블로그</title>
    <script>var lines = ["not", "lyrics"];</script></head><body>
    <nav><a href="/">홈</a><a href="/tag">태그</a></nav>
    <h2>${TITLE} 영어 가사</h2>
    <div class="tt_article_useless_p_margin">
    ${p('주 사랑 안에 나 살아가리')}${p('그 은혜 날마다 새롭네')}${gap}
    ${p('In Your love I will live my days')}${p('Your grace is new every morning')}${gap}
    ${p('주를 찬양해 영원토록')}${p('주의 이름 높이리')}${gap}
    ${p('I will praise You forevermore')}${p('I lift Your name on high')}${gap}
    ${p('Copyright &copy; 2024 Some Music. All rights reserved')}
    </div>
    <footer>공유하기 · 댓글 0</footer></body></html>`;
}

/**
 * A Genius-style page: the lyrics in data-lyrics-container divs, split by an
 * ad, under a header Genius marks as outside the lyrics — and around them a
 * description, annotations and credits in short English lines.
 */
function geniusPage(): string {
  return `<!doctype html><html><head><title>Some Worship – Song of Trial Lyrics | Genius Lyrics</title></head><body>
    <div class="SongHeader"><h1>Song of Trial</h1><p>Some Worship</p></div>
    <div id="lyrics-root">
      <div data-lyrics-container="true" class="Lyrics__Container-sc-1">
        <div data-exclude-from-selection="true" class="LyricsHeader__Container"><div>3 Contributors</div><div>Translations</div><h2>Song of Trial Lyrics</h2><p>A song about the grace that holds us fast</p></div>
        [Verse 1: Some Singer]<br/><a href="/1" class="ReferentFragment"><span>In Your love I will live my days</span></a><br/>Your grace is new every morning<br/><br/>[Chorus]<br/>I will praise You forevermore<br/>
      </div>
      <div class="RightSidebar"><div>Advertisement</div></div>
      <div data-lyrics-container="true" class="Lyrics__Container-sc-1">I lift Your name on high<br/><br/>[Bridge: All]<br/>When I fall You hold me fast<br/>Your love will never end<br/><br/>[Chorus]<br/>I will praise You forevermore<br/>I lift Your name on high</div>
    </div>
    <div class="About"><p>How to sing this song with a band</p><p>Written by Some Writer and Another Writer</p><p>Released on some day this year</p></div>
    </body></html>`;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('reading a 영어 가사 post', () => {
  it('keeps the breaks between stanzas and nothing else from the markup', () => {
    const lines = pageLines('<p>a</p>\n<p>b</p>\n<p>&nbsp;</p>\n<p>c</p><p>​</p><p><br></p><p>d&rsquo;s</p>');
    expect(lines).toEqual(['a', 'b', '', 'c', '', 'd’s']);
  });

  it('tells Korean lyrics, English lyrics, headings and site furniture apart', () => {
    expect(lineKind('주 사랑 안에 나 살아가리')).toBe('ko');
    expect(lineKind('In Your love I will live my days')).toBe('en');
    expect(lineKind('Hallelujah')).toBe('en');
    expect(lineKind('Lyrics')).toBe('other');
    expect(lineKind('[Verse 1]')).toBe('label');
    // A lyrics site names the singer in its headings.
    expect(lineKind('[Verse 1: Some Singer]')).toBe('label');
    expect(lineKind('[Post-Chorus]')).toBe('label');
    expect(lineKind('후렴')).toBe('label');
    expect(lineKind('')).toBe('blank');
    expect(lineKind('Copyright 2024 Some Music')).toBe('other');
    // A blogger's sentence about the song is too long to be a lyric line.
    expect(lineKind('이 찬양은 제가 정말 좋아하는 곡이라서 오늘은 영어 가사와 함께 한글 가사도 정리해 보았습니다.')).toBe('other');
  });

  it('returns the post as its Korean and English stanzas, in order', () => {
    const blocks = lyricBlocks(pageLines(bilingualPost()));
    const lyrics = blocks.filter((block) => block.lines.some((line) => /살아가리|live my|찬양해|praise You/.test(line)));
    expect(lyrics).toEqual([
      { lang: 'ko', lines: ['주 사랑 안에 나 살아가리', '그 은혜 날마다 새롭네'] },
      { lang: 'en', lines: ['In Your love I will live my days', 'Your grace is new every morning'] },
      { lang: 'ko', lines: ['주를 찬양해 영원토록', '주의 이름 높이리'] },
      { lang: 'en', lines: ['I will praise You forevermore', 'I lift Your name on high'] },
    ]);
    // The copyright line and the site's own menus are not lyrics.
    expect(blocks.flatMap((block) => block.lines).join(' ')).not.toMatch(/Copyright|공유하기|태그/);
  });

  it('keeps a heading printed above a stanza as its label', () => {
    const blocks = lyricBlocks(pageLines('<p>[Chorus]</p><p>I will praise You forevermore</p><p>I lift Your name on high</p>'));
    expect(blocks).toEqual([{ lang: 'en', label: 'Chorus', lines: ['I will praise You forevermore', 'I lift Your name on high'] }]);
  });

  it('reads the English title a post names the song by', () => {
    expect(englishTitleFrom('[영어찬양] Song of Trial, 시험의 노래, 영어 가사, 해석')).toBe('Song of Trial');
    expect(englishTitleFrom('시험의 노래 (Song of Trial) 코드악보 G Key, A Key 악보')).toBe('Song of Trial');
    expect(englishTitleFrom('[ccm] 시험의 노래(song of trial )ㅡ영어영상,가사')).toBe('Song Of Trial');
    expect(englishTitleFrom('시험의 노래 Song of Trial 한영 가사 PPT')).toBe('Song of Trial');
    expect(englishTitleFrom('시험의 노래 영어 가사')).toBe('');
  });

  it('passes over a series tag printed before the song’s own title', () => {
    expect(englishTitleFrom('[K-Gospel for you Ep-1] 시험의 노래 | 영어 버전 | 영어가사 악보', TITLE)).toBe('');
    expect(englishTitleFrom('[Worship Night Vol 2] 시험의 노래 (Song of Trial) 영어 가사', TITLE)).toBe('Song of Trial');
    expect(englishTitleFrom('[Worship Night Vol 2] 시험의 노래 Song of Trial', TITLE)).toBe('Song of Trial');
    // The posts' heading agree on one name; a stray one is outvoted.
    const hits = [
      { url: 'https://a.tistory.com/1', host: 'a.tistory.com', title: `${TITLE} (Song of Trial) 영어 가사` },
      { url: 'https://b.tistory.com/2', host: 'b.tistory.com', title: `${TITLE} (song of trial) 한영` },
      { url: 'https://c.tistory.com/3', host: 'c.tistory.com', title: `${TITLE} (Some Other Name) 가사` },
      { url: 'https://d.tistory.com/4', host: 'd.tistory.com', title: `${TITLE} 악보` },
    ];
    expect(englishTitleFromHits(hits, TITLE)).toBe('Song of Trial');
  });

  it('reads only the lyrics off a Genius page, with its headings as labels', () => {
    const blocks = lyricBlocks(pageLines(geniusLyricsHtml(geniusPage())));
    expect(blocks).toEqual([
      { lang: 'en', label: 'Verse 1', lines: ['In Your love I will live my days', 'Your grace is new every morning'] },
      { lang: 'en', label: 'Chorus', lines: ['I will praise You forevermore', 'I lift Your name on high'] },
      { lang: 'en', label: 'Bridge', lines: ['When I fall You hold me fast', 'Your love will never end'] },
      { lang: 'en', label: 'Chorus', lines: ['I will praise You forevermore', 'I lift Your name on high'] },
    ]);
    expect(geniusLyricsHtml('<p>no lyrics here</p>')).toBe('');
  });

  it('makes a candidate of a Genius page under the song’s English title', () => {
    expect(geniusSongTitle('Some Worship – Song of Trial Lyrics | Genius Lyrics')).toBe('Song of Trial');
    const candidate = englishCandidateFromPage(
      geniusPage(),
      { url: 'https://genius.com/Some-worship-song-of-trial-lyrics', host: 'genius.com', heading: 'Some Worship – Song of Trial Lyrics' },
      'Song of Trial',
    )!;
    expect(candidate.englishTitle).toBe('Song of Trial');
    expect(candidate.score).toBeGreaterThan(0.7);
    expect(candidate.blocks.flatMap((block) => block.lines).join(' ')).not.toMatch(/Contributors|Translations|band|Written by/);
    // A Genius page without its lyrics containers is no candidate at all.
    expect(englishCandidateFromPage('<p>How to sing this song with a band</p>'.repeat(5), { url: 'https://genius.com/x-lyrics', host: 'genius.com' }, 'Song of Trial')).toBeNull();
  });

  it('makes a candidate of a post with English lyrics, and none of a post without', () => {
    const candidate = englishCandidateFromPage(bilingualPost(), { url: 'https://a.tistory.com/1', host: 'a.tistory.com', heading: `${TITLE} 영어 가사` }, TITLE)!;
    expect(candidate.url).toBe('https://a.tistory.com/1');
    expect(candidate.score).toBeGreaterThan(0.8);
    expect(candidate.blocks.some((block) => block.lang === 'en')).toBe(true);
    expect(englishCandidateFromPage('<p>주 사랑 안에 나 살아가리</p><p>그 은혜 날마다 새롭네</p>', { url: 'https://b.tistory.com/2', host: 'b.tistory.com' }, TITLE)).toBeNull();
  });
});

describe('searching "<곡 제목> 영어 가사"', () => {
  it('asks exactly what the operator would type', () => {
    expect(englishLyricsQuery(' 시험의 노래 ')).toBe('시험의 노래 영어 가사');
    expect(englishLyricsQuery('')).toBe('');
    expect(originalLyricsQuery(' Song of Trial ')).toBe('Song of Trial lyrics');
    expect(isEnglishTitle('Song of Trial')).toBe(true);
    expect(isEnglishTitle(TITLE)).toBe(false);
  });

  it('opens the Genius song whose title is the title, a worship artist’s first', () => {
    const hits = extractGeniusHits(
      {
        response: {
          sections: [
            {
              type: 'song',
              hits: [
                { result: { title: 'Song of Trial (Remix)', url: 'https://genius.com/A-song-of-trial-remix-lyrics', artist_names: 'A Rapper' } },
                { result: { title: 'Song of Trial', url: 'https://genius.com/A-rapper-song-of-trial-lyrics', artist_names: 'A Rapper' } },
                { result: { title: 'Song of Trial', url: 'https://genius.com/Some-worship-song-of-trial-lyrics', artist_names: 'Some Worship' } },
                { result: { title: 'Song of Trial', url: 'http://genius.com/Insecure-lyrics', artist_names: 'Some Worship' } },
                { result: { title: 'Song of Trial', url: 'https://example.com/song-of-trial', artist_names: 'Some Worship' } },
              ],
            },
          ],
        },
      },
      'Song of Trial',
    );
    expect(hits.map((hit) => hit.url)).toEqual([
      'https://genius.com/Some-worship-song-of-trial-lyrics',
      'https://genius.com/A-rapper-song-of-trial-lyrics',
    ]);
    expect(hits[0]).toMatchObject({ englishTitle: 'Song of Trial', title: 'Some Worship – Song of Trial Lyrics' });
    expect(extractGeniusHits({ error: 'nope' }, 'Song of Trial')).toEqual([]);
  });

  it('opens only posts whose heading names the song, each once, English ones first', () => {
    const hits = relevantHits(
      [
        { url: 'https://blog.naver.com/a/1', host: 'blog.naver.com', title: '시험의 노래 악보' },
        { url: 'https://m.blog.naver.com/a/1', host: 'm.blog.naver.com', title: '시험의 노래 악보' },
        { url: 'https://b.tistory.com/2', host: 'b.tistory.com', title: '[영어찬양] 시험의 노래 영어 가사' },
        { url: 'https://c.tistory.com/3', host: 'c.tistory.com', title: '다른 노래 영어 가사' },
        { url: 'https://www.youtube.com/watch?v=1', host: 'www.youtube.com', title: '시험의 노래 영어' },
        { url: 'http://d.example.com/4', host: 'd.example.com', title: '시험의 노래 영어 가사' },
      ],
      TITLE,
    );
    expect(hits.map((hit) => hit.url)).toEqual(['https://b.tistory.com/2', 'https://blog.naver.com/a/1']);
  });

  it('searches the blogs, DuckDuckGo (and Google when a key is set), reads the posts and ranks them', async () => {
    const asked: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | Request) => {
        const url = typeof input === 'string' ? input : input.url;
        asked.push(url);
        if (url.startsWith(`${GOOGLE_SEARCH_ENDPOINT}?`)) {
          return Response.json({ organic_results: [{ title: `${TITLE} 영어 가사`, link: 'https://a.tistory.com/1', snippet: '' }] });
        }
        if (url.startsWith('https://search.daum.net/')) {
          return new Response(`
            <c-title data-href="https://a.tistory.com/1">${TITLE} 영어 가사</c-title>
            <c-title data-href="https://c.tistory.com/9">전혀 다른 글</c-title>`);
        }
        if (url.startsWith('https://search.naver.com/')) return new Response('<html></html>');
        if (url === 'https://a.tistory.com/1') {
          return new Response(bilingualPost(), { headers: { 'content-type': 'text/html; charset=utf-8' } });
        }
        return new Response('', { status: 404 });
      }),
    );

    const { query, candidates } = await fetchEnglishLyricsCandidates(TITLE, { SERPAPI_API_KEY: 'key-1' });
    expect(query).toBe('시험의 노래 영어 가사');
    expect(candidates.map((candidate) => candidate.url)).toEqual(['https://a.tistory.com/1']);
    // The search itself is "<곡 제목> 영어 가사", on every engine asked.
    const searches = asked.filter((url) => !url.startsWith('https://a.tistory.com'));
    expect(searches).toHaveLength(4);
    for (const url of searches) expect(decodeURIComponent(url.replace(/\+/g, ' '))).toContain('시험의 노래 영어 가사');
    // The post that is about something else is never opened.
    expect(asked).not.toContain('https://c.tistory.com/9');
  });

  it('looks the English original up on Genius by the name the posts give it', async () => {
    const asked: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | Request) => {
        const url = typeof input === 'string' ? input : input.url;
        asked.push(url);
        if (url.startsWith('https://search.daum.net/')) {
          return new Response(`<c-title data-href="https://a.tistory.com/1">[영어찬양] ${TITLE} (Song of Trial)</c-title>`);
        }
        if (url.startsWith(`${GENIUS_SEARCH_ENDPOINT}?`)) {
          return Response.json({
            response: { sections: [{ hits: [{ result: { title: 'Song of Trial', url: 'https://genius.com/Some-worship-song-of-trial-lyrics', artist_names: 'Some Worship' } }] }] },
          });
        }
        if (url === 'https://a.tistory.com/1') return new Response(bilingualPost(), { headers: { 'content-type': 'text/html' } });
        if (url === 'https://genius.com/Some-worship-song-of-trial-lyrics') {
          return new Response(geniusPage(), { headers: { 'content-type': 'text/html; charset=utf-8' } });
        }
        return new Response('', { status: 404 });
      }),
    );

    const found = await fetchEnglishLyricsCandidates(TITLE, { SERPAPI_API_KEY: 'key-1' });
    expect(found.englishTitle).toBe('Song of Trial');
    // The post first, then the lyrics page: the browser tries both.
    expect(found.candidates.map((candidate) => candidate.url)).toEqual([
      'https://a.tistory.com/1',
      'https://genius.com/Some-worship-song-of-trial-lyrics',
    ]);
    expect(found.candidates[1].blocks.map((block) => block.label)).toEqual(['Verse 1', 'Chorus', 'Bridge', 'Chorus']);
    expect(new URL(asked.find((url) => url.startsWith(GENIUS_SEARCH_ENDPOINT))!).searchParams.get('q')).toBe('Song of Trial');
    // Genius found it, so Google is not asked a second time.
    expect(asked.filter((url) => url.startsWith(GOOGLE_SEARCH_ENDPOINT))).toHaveLength(1);
  });

  it('asks Google for "<English title> lyrics" when Genius finds nothing, and takes the English title it is given', async () => {
    const asked: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | Request) => {
        const url = typeof input === 'string' ? input : input.url;
        asked.push(url);
        if (url.startsWith(`${GOOGLE_SEARCH_ENDPOINT}?`) && url.includes('lyrics')) {
          return Response.json({
            organic_results: [
              { title: 'Some Worship – Song of Trial Lyrics | Genius Lyrics', link: 'https://genius.com/Some-worship-song-of-trial-lyrics' },
              { title: 'Another Song Lyrics', link: 'https://genius.com/Another-song-lyrics' },
            ],
          });
        }
        if (url.startsWith(`${GENIUS_SEARCH_ENDPOINT}?`)) return new Response('', { status: 403 });
        if (url === 'https://genius.com/Some-worship-song-of-trial-lyrics') return new Response(geniusPage());
        return new Response('<html></html>');
      }),
    );

    const found = await fetchEnglishLyricsCandidates(TITLE, { SERPAPI_API_KEY: 'key-1' }, { englishTitle: 'Song of Trial' });
    expect(found.candidates.map((candidate) => candidate.url)).toEqual(['https://genius.com/Some-worship-song-of-trial-lyrics']);
    const google = asked.filter((url) => url.startsWith(GOOGLE_SEARCH_ENDPOINT)).map((url) => new URL(url).searchParams);
    expect(google.map((params) => params.get('q'))).toEqual(['시험의 노래 영어 가사', 'Song of Trial lyrics']);
    expect(google[1].get('hl')).toBe('en');
    expect(asked).not.toContain('https://genius.com/Another-song-lyrics');
  });

  it('comes back empty, not failing, when every search turns the Worker away', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 403 })));
    expect((await fetchEnglishLyricsCandidates(TITLE, {})).candidates).toEqual([]);
  });
});
