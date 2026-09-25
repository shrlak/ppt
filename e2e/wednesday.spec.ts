import { test, expect, type Page } from '@playwright/test';
import JSZip from 'jszip';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// Stands in for a 찬양 PPT. It is a real four-slide deck at another slide
// size, so the rescale path runs here too.
const SONG_PPTX = path.join(HERE, '..', 'public', 'front-slides.pptx');
const SHEET_PNG = path.join(HERE, '..', 'tests', 'fixtures', 'sheet-page.png');
const PROXY = 'http://localhost:4173/ppt/__proxy';
// Reading the 개역개정 file and building the deck are both slower in CI.
const BUILD_TIMEOUT = 60_000;

/**
 * The stand-in as a downloaded 찬양 PPT really is: the 악보 page on every
 * slide. The app refuses a download that is text alone, as a 가사 PPT.
 */
async function sheetMusicDeck(): Promise<Buffer> {
  const zip = await JSZip.loadAsync(await fs.readFile(SONG_PPTX));
  zip.file('ppt/media/e2e-sheet.png', await fs.readFile(SHEET_PNG));
  const types = await zip.file('[Content_Types].xml')!.async('string');
  if (!/Extension="png"/i.test(types)) {
    zip.file(
      '[Content_Types].xml',
      types.replace(/<Types\b[^>]*>/, (open) => `${open}<Default Extension="png" ContentType="image/png"/>`),
    );
  }
  const size = (await zip.file('ppt/presentation.xml')!.async('string')).match(
    /<p:sldSz\b[^>]*\bcx="(\d+)"[^>]*\bcy="(\d+)"/,
  )!;
  for (const name of Object.keys(zip.files).filter((file) => /^ppt\/slides\/slide\d+\.xml$/.test(file))) {
    const relsName = name.replace('slides/', 'slides/_rels/') + '.rels';
    const rels = await zip.file(relsName)!.async('string');
    zip.file(
      relsName,
      rels.replace(
        '</Relationships>',
        '<Relationship Id="rIdE2eSheet" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/e2e-sheet.png"/></Relationships>',
      ),
    );
    const xml = await zip.file(name)!.async('string');
    zip.file(
      name,
      xml.replace(
        '</p:spTree>',
        '<p:pic><p:nvPicPr><p:cNvPr id="9999" name="악보"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr>' +
          '<p:blipFill><a:blip xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:embed="rIdE2eSheet"/>' +
          '<a:stretch><a:fillRect/></a:stretch></p:blipFill>' +
          `<p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${size[1]}" cy="${size[2]}"/></a:xfrm>` +
          '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic></p:spTree>',
      ),
    );
  }
  return zip.generateAsync({ type: 'nodebuffer' });
}

/**
 * Slide text in presentation order.
 *
 * Part names are not that order: each song's slides are spliced in after its
 * 찬양 제목 slide, which leaves them numbered after the fixed ones. The
 * <p:sldIdLst> is what PowerPoint shows, so it is what this reads.
 */
async function textOfSlides(zip: JSZip): Promise<string[]> {
  const presentation = await zip.file('ppt/presentation.xml')!.async('string');
  const rels = await zip.file('ppt/_rels/presentation.xml.rels')!.async('string');
  const order = [...(presentation.match(/<p:sldIdLst>([\s\S]*?)<\/p:sldIdLst>/)?.[1] ?? '').matchAll(
    /r:id="([^"]+)"/g,
  )].map((match) => match[1]);
  const names = order.flatMap((id) => {
    const target = rels.match(new RegExp(`Id="${id}"[^>]*Target="slides/(slide\\d+\\.xml)"`));
    return target ? [`ppt/slides/${target[1]}`] : [];
  });

  const texts: string[] = [];
  for (const name of names) {
    const xml = await zip.file(name)!.async('string');
    texts.push(
      [...xml.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)]
        .map((match) => match[1])
        .join('')
        .replace(/\s+/g, ' ')
        .trim(),
    );
  }
  return texts;
}

/** One slide's raw XML, by its position in presentation order. */
async function slideXmlAt(zip: JSZip, position: number): Promise<string> {
  const presentation = await zip.file('ppt/presentation.xml')!.async('string');
  const rels = await zip.file('ppt/_rels/presentation.xml.rels')!.async('string');
  const order = [...(presentation.match(/<p:sldIdLst>([\s\S]*?)<\/p:sldIdLst>/)?.[1] ?? '').matchAll(
    /r:id="([^"]+)"/g,
  )].map((match) => match[1]);
  const target = rels.match(new RegExp(`Id="${order[position - 1]}"[^>]*Target="slides/(slide\\d+\\.xml)"`));
  return zip.file(`ppt/slides/${target![1]}`)!.async('string');
}

async function fillServiceInfo(page: Page): Promise<void> {
  await page.getByTestId('wednesday-date').fill('2026-09-16');
  await page.getByTestId('wednesday-sermon-title').fill('나의 힘이 되신 여호와여');
  await page.getByTestId('wednesday-preacher').fill('고신석');
  await page.getByTestId('wednesday-verse-input').fill('시18:1-12');
  // The passage summary appears once 개역개정 has been read.
  await expect(page.getByTestId('wednesday-passage-preview')).toContainText('시편 18편 1-12절', {
    timeout: BUILD_TIMEOUT,
  });
}

test.describe('수요예배 generator', () => {
  test.beforeEach(async ({ page }) => {
    // Nothing in this flow should reach the proxy unless the test says so.
    await page.route(`${PROXY}/**`, (route) => route.fulfill({ status: 404, json: { error: 'no proxy' } }));
    await page.goto('wednesday.html');
  });

  test('builds the fixed service order around this week’s songs', async ({ page }, testInfo) => {
    await fillServiceInfo(page);
    await page.getByTestId('wednesday-next-service').click();

    await page.getByTestId('wednesday-song-add').click();
    await page.getByTestId('wednesday-song-title-0').fill('나의 반석이신 하나님');
    await page.getByTestId('wednesday-song-input-0').setInputFiles(SONG_PPTX);
    await expect(page.getByTestId('wednesday-song-file-0')).toContainText('슬라이드 5장');

    await page.getByTestId('wednesday-next-songs').click();
    // That week's Wednesday, as the church names its files.
    await expect(page.getByTestId('wednesday-file-name')).toHaveValue('0916.pptx');

    const download = await Promise.race([
      page.waitForEvent('download', { timeout: BUILD_TIMEOUT }),
      page.getByTestId('wednesday-download').click().then(() => page.waitForEvent('download')),
    ]);
    const saved = testInfo.outputPath('wednesday.pptx');
    await download.saveAs(saved);
    const zip = await JSZip.loadAsync(await fs.readFile(saved));
    const texts = await textOfSlides(zip);

    // 표지 · 인트로 · 경배와 찬양 · [찬양 제목 + 곡 5장] · 기도 · 말씀 · 본문 4장
    // · 설교 · 기도 · 합심기도 · 마지막
    expect(texts).toHaveLength(19);
    expect(texts[0]).toContain('2026년 9월 16일');
    expect(texts[0]).toContain('나의 힘이 되신 여호와여');
    expect(texts[2]).toContain('경배와 찬양');
    expect(texts[3]).toContain('나의 반석이신 하나님');
    expect(texts[9]).toContain('기 도');
    expect(texts[11]).toContain('나의 힘이신 여호와여 내가 주를 사랑하나이다');
    expect(texts[18]).toContain('성령으로 봉사하는 교회');
    // Placeholders never reach the screen.
    expect(texts.join('\n')).not.toContain('{{');

    // The 설교 구분 장 is where the pastor's own slides go in afterwards.
    await expect(page.getByTestId('wednesday-slide-list')).toContainText(
      '설교 슬라이드는 이 뒤에 직접 넣으세요',
    );
  });

  test('numbers a verse 개역개정 prints together as "18-19"', async ({ page }, testInfo) => {
    await page.getByTestId('wednesday-date').fill('2026-09-16');
    await page.getByTestId('wednesday-verse-input').fill('신6:18-20');
    // 18-19 is one verse on the slide, but the count covers both of its numbers.
    const preview = page.getByTestId('wednesday-passage-preview');
    await expect(preview).toContainText('신명기 6장 18-20절 · 3절', { timeout: BUILD_TIMEOUT });
    await expect(preview).toContainText('18-19 여호와께서 보시기에 정직하고 선량한 일을 행하라');

    await page.getByTestId('wednesday-next-service').click();
    await page.getByTestId('wednesday-next-songs').click();
    const download = await Promise.race([
      page.waitForEvent('download', { timeout: BUILD_TIMEOUT }),
      page.getByTestId('wednesday-download').click().then(() => page.waitForEvent('download')),
    ]);
    const saved = testInfo.outputPath('wednesday-joined.pptx');
    await download.saveAs(saved);
    const texts = (await textOfSlides(await JSZip.loadAsync(await fs.readFile(saved)))).join('\n');
    expect(texts).toContain('18-19 여호와께서 보시기에');
    expect(texts).toContain('20 후일에 네 아들이');
    expect(texts).not.toMatch(/(^|\s)19 (\s|$)/);
  });

  test('downloads the 썸네일 as its own 16:9 file', async ({ page }, testInfo) => {
    await fillServiceInfo(page);
    await page.getByTestId('wednesday-tab-download').click();

    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: BUILD_TIMEOUT }),
      page.getByTestId('wednesday-download-thumbnail').click(),
    ]);
    const saved = testInfo.outputPath('thumbnail.pptx');
    await download.saveAs(saved);
    const zip = await JSZip.loadAsync(await fs.readFile(saved));

    const texts = await textOfSlides(zip);
    expect(texts).toHaveLength(1);
    expect(texts[0]).toContain('나의 힘이 되신 여호와여');
    expect(texts[0]).toContain('고신석');
    const presentation = await zip.file('ppt/presentation.xml')!.async('string');
    expect(presentation).toContain('cx="12192000"');
  });

  test('keeps this week’s work through a reload', async ({ page }) => {
    await fillServiceInfo(page);
    await page.getByTestId('wednesday-next-service').click();
    await page.getByTestId('wednesday-song-add').click();
    await page.getByTestId('wednesday-song-title-0').fill('하늘 위에 주님 밖에');
    await page.getByTestId('wednesday-song-input-0').setInputFiles(SONG_PPTX);
    await expect(page.getByTestId('wednesday-song-file-0')).toContainText('슬라이드 5장');
    // The song's file is written to IndexedDB as soon as it is attached; wait
    // for it rather than for a fixed delay.
    await expect
      .poll(
        () =>
          page.evaluate(
            () =>
              new Promise<number>((resolve) => {
                const open = indexedDB.open('kccp-wednesday');
                open.onsuccess = () => {
                  const db = open.result;
                  if (!db.objectStoreNames.contains('song-decks')) return resolve(0);
                  const request = db.transaction('song-decks', 'readonly').objectStore('song-decks').count();
                  request.onsuccess = () => resolve(request.result);
                  request.onerror = () => resolve(0);
                };
                open.onerror = () => resolve(0);
              }),
          ),
        { timeout: 15_000 },
      )
      .toBeGreaterThan(0);

    await page.reload();
    await expect(page.getByTestId('wednesday-sermon-title')).toHaveValue('나의 힘이 되신 여호와여', {
      timeout: BUILD_TIMEOUT,
    });
    await page.getByTestId('wednesday-tab-songs').click();
    await expect(page.getByTestId('wednesday-song-title-0')).toHaveValue('하늘 위에 주님 밖에');
    // The uploaded file comes back too, not just its title.
    await expect(page.getByTestId('wednesday-song-file-0')).toContainText('슬라이드 5장');
  });

  test('offers the search hits the proxy is willing to fetch', async ({ page }) => {
    const songFile = await sheetMusicDeck();
    await page.route(`${PROXY}/wednesday/songs?*`, (route) =>
      route.fulfill({
        json: {
          title: '나의 반석이신 하나님',
          candidates: [
            {
              token: 'signed-token',
              url: 'https://blogfiles.pstatic.net/song.pptx',
              host: 'blogfiles.pstatic.net',
              title: '나의 반석이신 하나님 ppt',
              direct: true,
            },
          ],
          links: [],
        },
      }),
    );
    await page.route(`${PROXY}/wednesday/songs/file`, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        body: songFile,
      }),
    );

    await page.getByTestId('wednesday-tab-songs').click();
    await page.getByTestId('wednesday-song-add').click();
    await page.getByTestId('wednesday-song-title-0').fill('나의 반석이신 하나님');
    await page.getByTestId('wednesday-song-search-0').click();

    await expect(page.getByTestId('wednesday-song-candidates-0')).toContainText('blogfiles.pstatic.net');
    await page.getByTestId('wednesday-song-candidates-0').getByRole('button').first().click();
    await expect(page.getByTestId('wednesday-song-file-0')).toContainText('인터넷에서 받음');

    // What it learned is remembered for the following weeks.
    await expect(page.getByTestId('wednesday-library')).toContainText('나의 반석이신 하나님');
  });

  test('says so when the search finds nothing fetchable', async ({ page }) => {
    await page.route(`${PROXY}/wednesday/songs?*`, (route) =>
      route.fulfill({
        json: { title: '없는 곡', candidates: [], links: [], message: '받아올 수 있는 찬양 PPT를 찾지 못했습니다.' },
      }),
    );
    await page.route(`${PROXY}/wednesday/songs/sheets?*`, (route) =>
      route.fulfill({ json: { title: '없는 곡', candidates: [] } }),
    );

    await page.getByTestId('wednesday-tab-songs').click();
    await page.getByTestId('wednesday-song-add').click();
    await page.getByTestId('wednesday-song-title-0').fill('없는 곡');
    await page.getByTestId('wednesday-song-search-0').click();

    await expect(page.getByTestId('wednesday-song-message-0')).toContainText('찾지 못했습니다');
    // The upload path is still right there.
    await expect(page.getByTestId('wednesday-song-upload-0')).toBeVisible();
  });

  test('turns uploaded 악보 사진 into one slide each', async ({ page }, testInfo) => {
    await fillServiceInfo(page);
    await page.getByTestId('wednesday-next-service').click();

    await page.getByTestId('wednesday-song-add').click();
    await page.getByTestId('wednesday-song-title-0').fill('주 은혜임을');
    // Two pages of the same 악보, as a phone photo or a scan would arrive.
    await page.getByTestId('wednesday-song-input-0').setInputFiles([SHEET_PNG, SHEET_PNG]);
    await expect(page.getByTestId('wednesday-song-sheets-0')).toContainText('악보 사진 2장');
    await expect(page.getByTestId('wednesday-song-sheet-list-0').locator('img')).toHaveCount(2);

    // A page can be taken back out before the deck is made.
    await page.getByTestId('wednesday-song-sheet-remove-0-1').click();
    await expect(page.getByTestId('wednesday-song-sheets-0')).toContainText('악보 사진 1장');

    await page.getByTestId('wednesday-next-songs').click();
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: BUILD_TIMEOUT }),
      page.getByTestId('wednesday-download').click(),
    ]);
    const saved = testInfo.outputPath('sheets.pptx');
    await download.saveAs(saved);
    const zip = await JSZip.loadAsync(await fs.readFile(saved));
    const texts = await textOfSlides(zip);

    // 표지·인트로·경배와 찬양 + [제목 + 악보 1장] + 기도·말씀·본문 4장·설교·기도·합심기도·마지막
    expect(texts).toHaveLength(15);
    expect(texts[3]).toContain('주 은혜임을');
    // The 악보 page is a picture, so its slide carries no text of its own.
    expect(texts[4]).toBe('');
    const sheetSlide = await slideXmlAt(zip, 5);
    expect(sheetSlide).toContain('<p:pic>');
  });

  test('finds and attaches a song by itself once the title is typed', async ({ page }) => {
    const sheet = await fs.readFile(SHEET_PNG);
    // No 찬양 PPT for this song, but its 악보 is out there.
    await page.route(`${PROXY}/wednesday/songs?*`, (route) =>
      route.fulfill({ json: { title: '주 은혜임을', candidates: [], links: [] } }),
    );
    await page.route(`${PROXY}/wednesday/songs/sheets?*`, (route) =>
      route.fulfill({
        json: {
          title: '주 은혜임을',
          candidates: [
            {
              token: 'signed-token',
              url: 'https://postfiles.pstatic.net/score.png',
              host: 'postfiles.pstatic.net',
              title: '주 은혜임을 악보',
              score: 1,
              decision: 'auto',
            },
          ],
        },
      }),
    );
    await page.route(`${PROXY}/wednesday/songs/image`, (route) =>
      route.fulfill({ status: 200, contentType: 'image/png', body: sheet }),
    );

    await page.getByTestId('wednesday-tab-songs').click();
    await page.getByTestId('wednesday-song-add').click();
    // Typing the title is the whole interaction — no search button, no picking.
    await page.getByTestId('wednesday-song-title-0').fill('주 은혜임을');

    await expect(page.getByTestId('wednesday-song-sheets-0')).toContainText('악보 사진 1장', {
      timeout: BUILD_TIMEOUT,
    });
    await expect(page.getByTestId('wednesday-song-sheets-0')).toContainText('인터넷에서 받음');
    await expect(page.getByTestId('wednesday-library')).toContainText('주 은혜임을');
  });

  test('prefers a 찬양 PPT when the search is sure of one', async ({ page }) => {
    const songFile = await sheetMusicDeck();
    await page.route(`${PROXY}/wednesday/songs?*`, (route) =>
      route.fulfill({
        json: {
          title: '나의 반석이신 하나님',
          candidates: [
            {
              token: 'ppt-token',
              url: 'https://blogfiles.pstatic.net/song.pptx',
              host: 'blogfiles.pstatic.net',
              title: '나의 반석이신 하나님 ppt',
              direct: true,
              score: 1,
              decision: 'auto',
            },
          ],
          links: [],
        },
      }),
    );
    await page.route(`${PROXY}/wednesday/songs/file`, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        body: songFile,
      }),
    );

    await page.getByTestId('wednesday-tab-songs').click();
    await page.getByTestId('wednesday-song-add').click();
    await page.getByTestId('wednesday-song-title-0').fill('나의 반석이신 하나님');

    await expect(page.getByTestId('wednesday-song-file-0')).toContainText('슬라이드 5장', {
      timeout: BUILD_TIMEOUT,
    });
    await expect(page.getByTestId('wednesday-song-file-0')).toContainText('인터넷에서 받음');
  });

  test('moves on to the next hit when the first one has no file', async ({ page }) => {
    // 제목을 검색해서 위에 있는 걸 눌러 보는 것과 같습니다 — 첫 글에 첨부가
    // 없으면 그다음 것을 눌러 봅니다.
    const songFile = await sheetMusicDeck();
    const hit = (token: string, url: string) => ({
      token,
      url,
      host: new URL(url).hostname,
      title: '나의 반석이신 하나님 ppt',
      direct: false,
      score: 1,
      decision: 'auto',
    });
    await page.route(`${PROXY}/wednesday/songs?*`, (route) =>
      route.fulfill({
        json: {
          title: '나의 반석이신 하나님',
          candidates: [
            hit('dead-end', 'https://praise.tistory.com/entry/1'),
            hit('has-the-file', 'https://blog.naver.com/church/2'),
          ],
          links: [],
        },
      }),
    );
    const asked: string[] = [];
    await page.route(`${PROXY}/wednesday/songs/file`, (route) => {
      const token = String(JSON.parse(route.request().postData() ?? '{}').token ?? '');
      asked.push(token);
      if (token === 'dead-end') {
        return route.fulfill({
          status: 400,
          json: { error: '이 게시글에서 PPT 첨부를 찾지 못했습니다. 파일을 직접 올려 주세요.' },
        });
      }
      return route.fulfill({
        status: 200,
        contentType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        body: songFile,
      });
    });

    await page.getByTestId('wednesday-tab-songs').click();
    await page.getByTestId('wednesday-song-add').click();
    await page.getByTestId('wednesday-song-title-0').fill('나의 반석이신 하나님');

    await expect(page.getByTestId('wednesday-song-file-0')).toContainText('슬라이드 5장', {
      timeout: BUILD_TIMEOUT,
    });
    expect(asked).toEqual(['dead-end', 'has-the-file']);
  });

  test('links both generators to each other', async ({ page }) => {
    await page.getByTestId('nav-sunday').click();
    await expect(page.getByTestId('wizard-panel-lyrics')).toBeVisible();
    await page.getByTestId('nav-wednesday').click();
    await expect(page.getByTestId('wednesday-panel-service')).toBeVisible();
  });
});
