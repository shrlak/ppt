import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_SONG_PPT_HOSTS,
  MAX_SONG_PPT_BYTES,
  attachmentKind,
  buildSongPptQueries,
  extractDaumBlogResults,
  extractNaverBlogResults,
  extractSongPptResults,
  fetchSongPptCandidates,
  fetchSongPptFile,
  findSongPptAttachment,
  hasLegacyPptAttachment,
  isAllowedSongPptUrl,
  isKnownSongPptHost,
  isNeverFileHost,
  isPptxBytes,
  looksLikeModernPptxUrl,
  looksLikePptxUrl,
  mobileNaverBlogUrl,
  rankSongPptHits,
  sanitizeWednesdaySongEntries,
  sanitizeWednesdaySongEntry,
  signSongPptToken,
  songPptHosts,
  songPptHostsOnly,
  verifySongPptToken,
} from '../../worker/src/songPpt.js';
import { createWorkerHarness } from '../support/workerHarness';
import { DEFAULT_ADMIN_PASSWORD } from '../../worker/src/config.js';

const BLOG = 'https://blog.naver.com/church/12345';
const FILE = 'https://blogfiles.pstatic.net/MjAy/song.pptx';
const TISTORY = 'https://praise.tistory.com/entry/찬양-ppt';

/** A response body from raw bytes, which BodyInit does not take directly. */
function bodyOf(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

/** Bytes that pass for a .pptx: ZIP magic plus the presentation part's name. */
function pptxBytes(size = 512): Uint8Array {
  const bytes = new Uint8Array(size);
  bytes.set([0x50, 0x4b, 0x03, 0x04]);
  const name = 'ppt/presentation.xml';
  for (let i = 0; i < name.length; i++) bytes[size - name.length - 4 + i] = name.charCodeAt(i);
  return bytes;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('song PPT host policy', () => {
  it('downloads from any https host, because the song decides the site', () => {
    // 찾는 방법이 "제목 검색 → 위에 있는 데 들어가서 받기"라서, 주소 목록으로
    // 막으면 대부분의 곡이 "직접 올려 주세요"가 됩니다. 대신 받아온 바이트가
    // 진짜 PowerPoint 파일인지로 거릅니다 (isPptxBytes).
    expect(isAllowedSongPptUrl(FILE)).toBe(true);
    expect(isAllowedSongPptUrl(BLOG)).toBe(true);
    expect(isAllowedSongPptUrl(TISTORY)).toBe(true);
    expect(isAllowedSongPptUrl('https://praise.example.kr/song.pptx')).toBe(true);
    // http is refused wherever it points, and so is a non-URL.
    expect(isAllowedSongPptUrl('http://blog.naver.com/church/1')).toBe(false);
    expect(isAllowedSongPptUrl('not a url')).toBe(false);
  });

  it('never resolves a host that points back inside', () => {
    // The open policy must not become a way to reach the Worker's own network,
    // whatever an operator lists.
    const env = { WEDNESDAY_PPT_HOSTS: 'localhost,127.0.0.1,[::1],router.local,169.254.169.254' };
    expect(isAllowedSongPptUrl('https://localhost/song.pptx', env)).toBe(false);
    expect(isAllowedSongPptUrl('https://127.0.0.1/song.pptx', env)).toBe(false);
    expect(isAllowedSongPptUrl('https://router.local/song.pptx', env)).toBe(false);
    expect(isAllowedSongPptUrl('https://169.254.169.254/latest/meta-data', env)).toBe(false);
    expect(isAllowedSongPptUrl('https://box.internal/song.pptx', env)).toBe(false);
  });

  it('knows the sites this church downloads from, subdomains included', () => {
    expect(isKnownSongPptHost(BLOG)).toBe(true);
    // 티스토리 blogs are all on their own subdomain, 갓피플 spreads over several.
    expect(isKnownSongPptHost(TISTORY)).toBe(true);
    expect(isKnownSongPptHost('https://www.godpeople.com/bbs/view?id=1')).toBe(true);
    expect(isKnownSongPptHost('https://blog.kakaocdn.net/dn/x/song.pptx')).toBe(true);
    expect(isKnownSongPptHost('https://elsewhere.test/song.pptx')).toBe(false);
    // Not a subdomain, just a look-alike suffix.
    expect(isKnownSongPptHost('https://nottistory.com/1')).toBe(false);
  });

  it('never follows a page that cannot hold a file', () => {
    expect(isNeverFileHost('https://www.youtube.com/watch?v=x')).toBe(true);
    expect(isNeverFileHost('https://ko.wikipedia.org/wiki/x')).toBe(true);
    expect(isNeverFileHost(TISTORY)).toBe(false);
  });

  it('takes a deployment\'s own hosts from the environment', () => {
    const env = { WEDNESDAY_PPT_HOSTS: ' praise.example.kr , Files.Example.Kr ' };
    expect(songPptHosts(env)).toEqual([...DEFAULT_SONG_PPT_HOSTS, 'praise.example.kr', 'files.example.kr']);
    expect(isKnownSongPptHost('https://files.example.kr/a.pptx', env)).toBe(true);
    expect(isKnownSongPptHost('https://files.example.kr/a.pptx')).toBe(false);
  });

  it('can be locked back down to that list', () => {
    const env = { WEDNESDAY_PPT_HOSTS_ONLY: 'true', WEDNESDAY_PPT_HOSTS: 'praise.example.kr' };
    expect(songPptHostsOnly(env)).toBe(true);
    expect(isAllowedSongPptUrl(FILE, env)).toBe(true);
    expect(isAllowedSongPptUrl('https://praise.example.kr/a.pptx', env)).toBe(true);
    expect(isAllowedSongPptUrl('https://elsewhere.test/song.pptx', env)).toBe(false);
  });
});

describe('search result parsing', () => {
  it('asks for the file, not the lyrics', () => {
    expect(buildSongPptQueries(' 나의 반석이신 하나님 ')).toEqual([
      '나의 반석이신 하나님 찬양 ppt',
      '나의 반석이신 하나님 ppt 다운로드',
      '나의 반석이신 하나님 악보 ppt',
    ]);
    expect(buildSongPptQueries('   ')).toEqual([]);
  });

  it('puts the file first, then the sites we know, then the rest', () => {
    const html = `
      <a href="https://duckduckgo.com/y.js?ad=1">ad</a>
      <a href="/l/?uddg=${encodeURIComponent('https://elsewhere.test/page')}">본문만</a>
      <a href="/l/?uddg=${encodeURIComponent(BLOG)}">찬양 ppt 모음 &amp; 악보</a>
      <a href="/l/?uddg=${encodeURIComponent(FILE)}">나의 반석이신 하나님 ppt</a>
      <a href="/l/?uddg=${encodeURIComponent('https://www.youtube.com/watch?v=x')}">찬양 영상</a>
    `;
    const { results, links } = extractSongPptResults(html);

    // Page order says nothing about which hit holds a file, so a .pptx comes
    // first, a 자료실 we know next, and an unknown blog after both.
    expect(results.map((hit: { url: string }) => hit.url)).toEqual([
      FILE,
      BLOG,
      'https://elsewhere.test/page',
    ]);
    expect(results[0]).toEqual({
      url: FILE,
      host: 'blogfiles.pstatic.net',
      title: '나의 반석이신 하나님 ppt',
      direct: true,
      known: true,
    });
    expect(results[2].known).toBe(false);
    // A video page can never hold the file, so it is not worth a fetch.
    expect(results.some((hit: { host: string }) => hit.host.includes('youtube'))).toBe(false);
    expect(links).toEqual([]);
  });

  it('offers what it may not fetch as a link instead', () => {
    const html = `
      <a href="/l/?uddg=${encodeURIComponent(BLOG)}">네이버 블로그</a>
      <a href="/l/?uddg=${encodeURIComponent('https://elsewhere.test/song.pptx')}">다른 사이트</a>
    `;
    const { results, links } = extractSongPptResults(html, { WEDNESDAY_PPT_HOSTS_ONLY: 'true' });

    expect(results.map((hit: { url: string }) => hit.url)).toEqual([BLOG]);
    expect(links.map((link: { url: string }) => link.url)).toEqual(['https://elsewhere.test/song.pptx']);
  });

  it('recognizes a file URL with a query string', () => {
    expect(looksLikePptxUrl('https://blogfiles.pstatic.net/a.pptx?download=1')).toBe(true);
    expect(looksLikePptxUrl('https://blogfiles.pstatic.net/a.ppt')).toBe(true);
    expect(looksLikePptxUrl('https://blog.naver.com/post/1')).toBe(false);
  });

  it('finds an attachment inside a post, resolving a relative link', () => {
    // A post links out to other sites too, so the file host we know wins over
    // a .pptx someone linked elsewhere, wherever each appears in the page.
    const html = `
      <a href="/common/download?x=1">첨부</a>
      <a href="https://elsewhere.test/song.pptx">다른 곳</a>
      <a href="//blogfiles.pstatic.net/MjAy/%EC%B0%AC%EC%96%91.pptx">찬양.pptx</a>
    `;
    expect(findSongPptAttachment(html, BLOG)).toBe(
      'https://blogfiles.pstatic.net/MjAy/%EC%B0%AC%EC%96%91.pptx',
    );
    expect(findSongPptAttachment('<a href="/none">없음</a>', BLOG)).toBeNull();

    // On a site we know nothing about, the post's own domain is the next best
    // clue as to which .pptx is the attachment.
    const board = `
      <a href="https://ads.other.test/free.pptx">광고</a>
      <a href="https://cdn.example.kr/files/song.pptx">주 은혜임을.pptx</a>
    `;
    expect(findSongPptAttachment(board, 'https://board.example.kr/view/44')).toBe(
      'https://cdn.example.kr/files/song.pptx',
    );
  });

  it('falls back to the link a person would click', () => {
    // 갓피플 and most 자료실 boards hide the file behind a download script, so
    // the only place the name appears is the link's own text.
    const html = '<a href="/bbs/download.php?no=44"><span>주 은혜임을.pptx</span> (2.1MB)</a>';
    expect(findSongPptAttachment(html, 'https://www.godpeople.com/bbs/view?no=44')).toBe(
      'https://www.godpeople.com/bbs/download.php?no=44',
    );
    expect(findSongPptAttachment('<a href="/bbs/download.php?no=44">첨부파일</a>', BLOG)).toBeNull();
  });

  it('takes the .pptx when a post offers the old .ppt beside it', () => {
    // 티스토리 posts often attach the 4:3 and the wide version, one of them
    // still in the binary .ppt format no slide can be made from.
    const legacy = 'https://blog.kakaocdn.net/dna/a/%EC%9D%80%ED%98%9C.ppt?credential=x&knm=tfile.ppt';
    const modern = 'https://blog.kakaocdn.net/dna/b/%EC%9D%80%ED%98%9C.pptx?credential=x&knm=tfile.pptx';
    const html = `<a href="${legacy}">은혜.ppt</a><a href="${modern}">은혜.pptx</a>`;
    expect(findSongPptAttachment(html, TISTORY)).toBe(modern);
    expect(hasLegacyPptAttachment(html, TISTORY)).toBe(true);

    expect(findSongPptAttachment(`<a href="${legacy}">은혜.ppt</a>`, TISTORY)).toBeNull();
    expect(findSongPptAttachment('<a href="/bbs/download.php?no=1">은혜.ppt</a>', TISTORY)).toBeNull();
    expect(looksLikeModernPptxUrl(modern)).toBe(true);
    expect(looksLikeModernPptxUrl(legacy)).toBe(false);
  });
});

describe('블로그 검색 parsing', () => {
  it('reads each 다음 블로그 result: its post, title and snippet', () => {
    // Trimmed from a real 다음 블로그 검색 page.
    const html = `
      <c-card data-docid="tstory-1_714">
        <c-header-item data-href="https://colordiary.tistory.com/"><c-frag>colordiary.tistory.com</c-frag></c-header-item>
        <c-doc-web>
          <c-title slot="title" data-href="https://colordiary.tistory.com/714">[찬양<b>PPT</b>,가사] <b>나의</b> <b>반석이신</b> <b>하나님</b> <b>PPT</b></c-title>
          <c-contents-desc slot="contents" data-href="https://colordiary.tistory.com/714">나의 반석이신 하나님 행하신 모든 것…</c-contents-desc>
        </c-doc-web>
      </c-card>
      <c-card>
        <c-title data-href="https://akkbo.tistory.com/1379">새 찬송가 386장 &lt;만세 반석 열린 곳에&gt;</c-title>
        <c-contents-desc data-href="https://akkbo.tistory.com/1379">PPT 다운로드 새찬송가 386장_만세 반석 열린 곳에.pptx 3.55MB</c-contents-desc>
      </c-card>
      <c-title data-href="https://search.daum.net/search?w=tot&q=x">관련 검색어</c-title>`;
    const { results, links } = extractDaumBlogResults(html);

    expect(results.map((hit) => hit.url)).toEqual([
      'https://colordiary.tistory.com/714',
      'https://akkbo.tistory.com/1379',
    ]);
    expect(results[0]).toMatchObject({
      host: 'colordiary.tistory.com',
      title: '[찬양PPT,가사] 나의 반석이신 하나님 PPT',
      known: true,
      direct: false,
    });
    expect(results[0].attachment).toBeUndefined();
    // The snippet names the attachment, which is what puts a post first.
    expect(results[1].title).toBe('새 찬송가 386장 <만세 반석 열린 곳에>');
    expect(results[1].attachment).toBe('pptx');
    expect(links).toEqual([]);
  });

  it('reads each 네이버 블로그 result from the links to its post', () => {
    const post = 'https://blog.naver.com/ihrkja/224319609047';
    const html = `
      <a href="https://blog.naver.com/ihrkja">프로필</a>
      <a class="title" href="${post}" target="_blank"><span>E key 찬양콘티 + 가사 <mark>ppt</mark></span><span class="blind">새 창 열림</span></a>
      <a class="dsc" href="${post}"><span>보라 하나님 구원을 첨부파일 1_악보틀.png 첨부파일 찬양예배.pptx</span></a>
      <a href="${post}"><img src="https://search.pstatic.net/common/?src=x" alt=""></a>
      <a href="https://blog.naver.com/sweetvoice3/223034650901"><span>[악보] 나의 반석이신 하나님 F Major</span></a>`;
    const { results } = extractNaverBlogResults(html);

    expect(results.map((hit) => hit.url)).toEqual([post, 'https://blog.naver.com/sweetvoice3/223034650901']);
    expect(results[0].title).toBe('E key 찬양콘티 + 가사 ppt');
    expect(results[0].attachment).toBe('pptx');
    expect(results[1].attachment).toBeUndefined();
  });

  it('knows a .pptx attachment from an old .ppt one in a snippet', () => {
    expect(attachmentKind('첨부파일 찬양예배.pptx')).toBe('pptx');
    expect(attachmentKind('은혜(보통).ppt 다운로드')).toBe('ppt');
    expect(attachmentKind('찬양 PPT, 악보 PPT')).toBeUndefined();
  });

  it('turns a 네이버 블로그 address into the page the post is really on', () => {
    expect(mobileNaverBlogUrl('https://blog.naver.com/church/12345')).toBe('https://m.blog.naver.com/church/12345');
    expect(mobileNaverBlogUrl('https://blog.naver.com/PostView.naver?blogId=church&logNo=12345')).toBe(
      'https://m.blog.naver.com/church/12345',
    );
    expect(mobileNaverBlogUrl('https://blog.naver.com/church?Redirect=Log&logNo=12345')).toBe(
      'https://m.blog.naver.com/church/12345',
    );
    expect(mobileNaverBlogUrl('https://m.blog.naver.com/church/12345')).toBeNull();
    expect(mobileNaverBlogUrl(TISTORY)).toBeNull();
  });

  it('tries the posts most likely to hold the song\'s own .pptx first', () => {
    const hit = (url: string, title: string, extra: object = {}) => ({
      url,
      host: new URL(url).hostname,
      title,
      direct: false,
      known: true,
      ...extra,
    });
    const ranked = rankSongPptHits('나의 반석이신 하나님', [
      hit('https://a.tistory.com/1', '나의 반석이신 하나님 ppt', { attachment: 'ppt' }),
      hit('https://b.tistory.com/2', '나의 반석이신 하나님 ppt'),
      hit('https://c.tistory.com/3', '다른 찬양 ppt'),
      hit('https://blog.naver.com/d/4', '찬양콘티 ppt (나의 반석이신 하나님, 나는 믿네)', { attachment: 'pptx' }),
      hit('https://blog.naver.com/e/5', '나의 반석이신 하나님 PPT', { attachment: 'pptx' }),
    ]);

    expect(ranked.map((entry) => [entry.url, entry.decision])).toEqual([
      // Named .pptx attachment, then a post on a site we know, then a post
      // whose only file is the old .ppt.
      ['https://blog.naver.com/e/5', 'auto'],
      ['https://b.tistory.com/2', 'auto'],
      ['https://a.tistory.com/1', 'auto'],
      // A week's 콘티 carries every song of that week, so it is only offered.
      ['https://blog.naver.com/d/4', 'review'],
      ['https://c.tistory.com/3', 'review'],
    ]);
  });
});

describe('searching for a song PPT', () => {
  it('asks the blog searches and the web search together and merges what they find', async () => {
    const naverPost = 'https://blog.naver.com/church/12345';
    const asked: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | Request) => {
        const url = typeof input === 'string' ? input : input.url;
        asked.push(new URL(url).hostname);
        if (url.startsWith('https://search.daum.net/')) {
          return new Response(`
            <c-title data-href="https://m.blog.naver.com/church/12345">나의 반석이신 하나님 PPT</c-title>
            <c-title data-href="https://praise.tistory.com/7">나의 반석이신 하나님 ppt</c-title>`);
        }
        if (url.startsWith('https://search.naver.com/')) {
          return new Response(
            `<a href="${naverPost}">나의 반석이신 하나님 PPT</a><a href="${naverPost}">첨부파일 반석.pptx</a>`,
          );
        }
        // DuckDuckGo turning the Worker away costs nothing.
        return new Response('', { status: 403 });
      }),
    );

    const { candidates } = await fetchSongPptCandidates('나의 반석이신 하나님', {}, 'secret');
    expect(asked).toEqual(expect.arrayContaining(['search.daum.net', 'search.naver.com', 'html.duckduckgo.com']));
    // One post found by both searches is one hit.
    expect(candidates.map((candidate) => candidate.url)).toEqual([
      'https://m.blog.naver.com/church/12345',
      'https://praise.tistory.com/7',
    ]);
    expect(candidates.every((candidate) => candidate.decision === 'auto' && candidate.token)).toBe(true);
  });
});

describe('search result tokens', () => {
  it('round-trips a URL the proxy itself chose', async () => {
    const token = await signSongPptToken(FILE, 'secret');
    expect(token).not.toContain(FILE);
    expect(await verifySongPptToken(token, 'secret')).toBe(FILE);
  });

  it('refuses a forged, tampered or expired token', async () => {
    const token = await signSongPptToken(FILE, 'secret');
    expect(await verifySongPptToken(token, 'other-secret')).toBeNull();
    expect(await verifySongPptToken(`${token}x`, 'secret')).toBeNull();
    expect(await verifySongPptToken('', 'secret')).toBeNull();

    const shortLived = await signSongPptToken(FILE, 'secret', { ttlMs: 1000 });
    expect(await verifySongPptToken(shortLived, 'secret', { now: Date.now() + 5000 })).toBeNull();
  });
});

describe('downloading a song deck', () => {
  function stubFetch(handler: (url: string, init?: RequestInit) => Response) {
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | Request, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.url;
        calls.push(url);
        return handler(url, init);
      }),
    );
    return calls;
  }

  it('follows a post to its attachment and returns the bytes', async () => {
    const bytes = pptxBytes();
    const calls = stubFetch((url) => {
      if (url === TISTORY) {
        return new Response(`<a href="${FILE}">찬양.pptx</a>`, {
          status: 200,
          headers: { 'Content-Type': 'text/html' },
        });
      }
      return new Response(bodyOf(bytes), { status: 200 });
    });

    const file = await fetchSongPptFile(TISTORY);
    expect(file.bytes.length).toBe(bytes.length);
    expect(calls).toEqual([TISTORY, FILE]);
  });

  it('reads a 네이버 블로그 post on its mobile page, where the attachment is', async () => {
    // blog.naver.com/<blog>/<number> is only a frame; the post and its
    // download link are on m.blog.naver.com.
    const bytes = pptxBytes();
    const attachment = 'https://download.blog.naver.com/open/abc/PPT-%EC%9D%80%ED%98%9C.pptx';
    const calls = stubFetch((url) => {
      if (url === 'https://m.blog.naver.com/church/12345') {
        return new Response(`<a href="${attachment}" class="se-file-save-button">PPT-은혜.pptx</a>`, {
          status: 200,
        });
      }
      if (url === BLOG) return new Response('<iframe id="mainFrame" src="/PostView.naver"></iframe>');
      return new Response(bodyOf(bytes), { status: 200 });
    });

    const file = await fetchSongPptFile(BLOG);
    expect(file.bytes.length).toBe(bytes.length);
    expect(calls).toEqual(['https://m.blog.naver.com/church/12345', attachment]);
  });

  it('says so when the post only has the old .ppt format', async () => {
    const legacy = 'https://blog.kakaocdn.net/dna/x/%EC%9D%80%ED%98%9C.ppt?credential=a&knm=tfile.ppt';
    stubFetch(() => new Response(`<figure class="fileblock"><a href="${legacy}">은혜.ppt</a></figure>`));
    await expect(fetchSongPptFile(TISTORY)).rejects.toThrow('옛 형식(.ppt)');

    // A direct link to one says the same, from the bytes rather than the name.
    const ole = new Uint8Array(64);
    ole.set([0xd0, 0xcf, 0x11, 0xe0]);
    stubFetch(() => new Response(bodyOf(ole), { status: 200 }));
    await expect(fetchSongPptFile('https://blog.kakaocdn.net/dna/x/song.ppt')).rejects.toThrow(
      '옛 형식(.ppt)',
    );
  });

  it('downloads from a site it has never seen, and checks what arrives', async () => {
    const bytes = pptxBytes();
    const calls = stubFetch((url) => {
      if (url === TISTORY) return new Response(`<a href="${'https://blog.kakaocdn.net/dn/x/찬양.pptx'}">찬양.pptx</a>`, { status: 200 });
      return new Response(bodyOf(bytes), { status: 200 });
    });

    const file = await fetchSongPptFile(TISTORY);
    expect(file.bytes.length).toBe(bytes.length);
    expect(calls).toHaveLength(2);
  });

  it('refuses http and an address that points inside', async () => {
    await expect(fetchSongPptFile('http://elsewhere.test/song.pptx')).rejects.toThrow(
      '이 주소에서는 받아올 수 없습니다. 파일을 직접 올려 주세요.',
    );
    await expect(fetchSongPptFile('https://127.0.0.1/song.pptx')).rejects.toThrow(
      '이 주소에서는 받아올 수 없습니다. 파일을 직접 올려 주세요.',
    );
  });

  it('refuses a host off the list when the deployment asks for one', async () => {
    await expect(
      fetchSongPptFile('https://elsewhere.test/song.pptx', { WEDNESDAY_PPT_HOSTS_ONLY: 'true' }),
    ).rejects.toThrow('이 주소에서는 받아올 수 없습니다. 파일을 직접 올려 주세요.');
  });

  it('refuses a file that is not a PowerPoint package', async () => {
    stubFetch(() => new Response(bodyOf(new Uint8Array([1, 2, 3, 4])), { status: 200 }));
    await expect(fetchSongPptFile(FILE)).rejects.toThrow('PowerPoint(.pptx) 파일이 아닙니다');
  });

  it('refuses a file over the size cap without reading it', async () => {
    stubFetch(
      () =>
        new Response(bodyOf(pptxBytes()), {
          status: 200,
          headers: { 'Content-Length': String(MAX_SONG_PPT_BYTES + 1) },
        }),
    );
    await expect(fetchSongPptFile(FILE)).rejects.toThrow('너무 큽니다');
  });

  it('re-checks where a redirect actually landed', async () => {
    stubFetch(() => {
      const response = new Response(bodyOf(pptxBytes()), { status: 200 });
      // Any host may redirect anywhere, including back inside; response.url is
      // where we really ended up.
      Object.defineProperty(response, 'url', { value: 'https://169.254.169.254/latest/meta-data' });
      return response;
    });
    await expect(fetchSongPptFile(FILE)).rejects.toThrow('허용되지 않은 주소로 이동했습니다.');
  });

  it('knows a real package from a look-alike', () => {
    expect(isPptxBytes(pptxBytes())).toBe(true);
    expect(isPptxBytes(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0]))).toBe(false);
    expect(isPptxBytes(new Uint8Array([]))).toBe(false);
  });
});

describe('the link-only song library', () => {
  it('stores a title and its address, and nothing unverifiable', () => {
    expect(
      sanitizeWednesdaySongEntry({
        title: '  나의 반석이신 하나님  ',
        sourceUrl: FILE,
        slideCount: 6,
        updatedAt: '2026-09-16T00:00:00.000Z',
        deck: 'should not be stored',
      }),
    ).toEqual({
      title: '나의 반석이신 하나님',
      sourceUrl: FILE,
      sourceHost: 'blogfiles.pstatic.net',
      slideCount: 6,
      updatedAt: '2026-09-16T00:00:00.000Z',
    });

    // An http address, a junk address and a missing title are all dropped.
    expect(sanitizeWednesdaySongEntry({ title: '곡', sourceUrl: 'http://x.test/a.pptx' })?.sourceUrl).toBeUndefined();
    expect(sanitizeWednesdaySongEntry({ title: '' })).toBeNull();
    expect(sanitizeWednesdaySongEntries('nope')).toEqual([]);
  });

  it('is readable by the app and writable with the shared password', async () => {
    const harness = createWorkerHarness();
    const entry = { title: '나의 반석이신 하나님', sourceUrl: FILE, slideCount: 6 };

    const refused = await harness.fetch('/libraries/wednesday-songs', {
      method: 'PUT',
      body: JSON.stringify({ entry }),
    });
    expect(refused.status).toBe(403);

    const written = await harness.fetch('/libraries/wednesday-songs', {
      method: 'PUT',
      admin: true,
      body: JSON.stringify({ entry }),
    });
    expect(written.status).toBe(200);

    const read = await harness.fetch('/libraries/wednesday-songs');
    expect(read.status).toBe(200);
    const snapshot = (await read.json()) as { entries: { title: string; sourceUrl?: string }[] };
    expect(snapshot.entries).toHaveLength(1);
    expect(snapshot.entries[0]).toMatchObject({ title: '나의 반석이신 하나님', sourceUrl: FILE });

    const deleted = await harness.fetch('/libraries/wednesday-songs', {
      method: 'DELETE',
      admin: true,
      body: JSON.stringify({ title: '나의 반석이신 하나님' }),
    });
    expect(deleted.status).toBe(200);
    const after = (await (await harness.fetch('/libraries/wednesday-songs')).json()) as {
      entries: unknown[];
      deletedTitles: string[];
    };
    expect(after.entries).toEqual([]);
    expect(after.deletedTitles).toHaveLength(1);
  });

  it('survives the weekly PPT purge, like the lyrics library', async () => {
    const harness = createWorkerHarness();
    await harness.fetch('/libraries/wednesday-songs', {
      method: 'PUT',
      admin: true,
      body: JSON.stringify({ entry: { title: '남아야 하는 곡', sourceUrl: FILE } }),
    });

    // The weekly purge clears the week's decks; the song index is a standing
    // asset and lives outside library:ppt:*.
    await harness.tracker.purgePptLibrary({ trigger: 'manual' });

    const snapshot = (await (await harness.fetch('/libraries/wednesday-songs')).json()) as {
      entries: { title: string }[];
    };
    expect(snapshot.entries.map((entry) => entry.title)).toEqual(['남아야 하는 곡']);
  });
});

describe('the song PPT routes', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('takes a title and returns hits with tokens instead of URLs', async () => {
    const harness = createWorkerHarness();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(`<a href="/l/?uddg=${encodeURIComponent(FILE)}">찬양 ppt</a>`, { status: 200 }),
      ),
    );

    const response = await harness.fetch('/wednesday/songs?title=나의 반석이신 하나님');
    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      candidates: { url: string; token: string }[];
      hosts: string[];
    };
    expect(payload.candidates).toHaveLength(1);
    expect(payload.candidates[0].token).toBeTruthy();
    expect(payload.hosts).toContain('blog.naver.com');
    // The token stands on its own: it verifies against the deployment's secret.
    expect(await verifySongPptToken(payload.candidates[0].token, DEFAULT_ADMIN_PASSWORD)).toBe(FILE);
  });

  it('needs a title', async () => {
    const harness = createWorkerHarness();
    const response = await harness.fetch('/wednesday/songs?title=');
    expect(response.status).toBe(400);
  });

  it('serves the file for a token it signed', async () => {
    const harness = createWorkerHarness();
    const bytes = pptxBytes();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(bodyOf(bytes), { status: 200 })));

    const token = await signSongPptToken(FILE, DEFAULT_ADMIN_PASSWORD);
    const response = await harness.fetch('/wednesday/songs/file', {
      method: 'POST',
      body: JSON.stringify({ token }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toContain('presentationml.presentation');
    expect((await response.arrayBuffer()).byteLength).toBe(bytes.length);
  });

  it('only lets this app ask for an outside file', async () => {
    // The route fetches an address and hands back the bytes, so the CORS rule
    // is restated here rather than left to the browser.
    const harness = createWorkerHarness();
    const token = await signSongPptToken(FILE, DEFAULT_ADMIN_PASSWORD);
    const elsewhere = await harness.fetch('/wednesday/songs/file', {
      method: 'POST',
      headers: { Origin: 'https://not-ours.test' },
      body: JSON.stringify({ token }),
    });
    expect(elsewhere.status).toBe(403);
  });

  it('refuses an expired token and a URL it may not fetch', async () => {
    const harness = createWorkerHarness();
    const stale = await signSongPptToken(FILE, DEFAULT_ADMIN_PASSWORD, { ttlMs: -1000 });
    const expired = await harness.fetch('/wednesday/songs/file', {
      method: 'POST',
      body: JSON.stringify({ token: stale }),
    });
    expect(expired.status).toBe(400);
    expect(((await expired.json()) as { error: string }).error).toContain('만료');

    const inside = await harness.fetch('/wednesday/songs/file', {
      method: 'POST',
      body: JSON.stringify({ url: 'https://169.254.169.254/song.pptx' }),
    });
    expect(inside.status).toBe(400);

    const locked = createWorkerHarness({ WEDNESDAY_PPT_HOSTS_ONLY: 'true' });
    const pasted = await locked.fetch('/wednesday/songs/file', {
      method: 'POST',
      body: JSON.stringify({ url: 'https://elsewhere.test/song.pptx' }),
    });
    expect(pasted.status).toBe(400);
  });
});
