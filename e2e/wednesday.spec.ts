import { test, expect, type Page } from '@playwright/test';
import JSZip from 'jszip';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// Stands in for a downloaded 찬양 PPT. It is a real four-slide deck at another
// slide size, so the rescale path runs here too.
const SONG_PPTX = path.join(HERE, '..', 'public', 'front-slides.pptx');
const PROXY = 'http://localhost:4173/ppt/__proxy';
// Reading the 개역개정 file and building the deck are both slower in CI.
const BUILD_TIMEOUT = 60_000;

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
    await expect(page.getByTestId('wednesday-song-file-0')).toContainText('슬라이드 4장');

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

    // 표지 · 인트로 · 경배와 찬양 · [찬양 제목 + 곡 4장] · 기도 · 말씀 · 본문 4장
    // · 설교 · 기도 · 합심기도 · 마지막
    expect(texts).toHaveLength(18);
    expect(texts[0]).toContain('2026년 9월 16일');
    expect(texts[0]).toContain('나의 힘이 되신 여호와여');
    expect(texts[2]).toContain('경배와 찬양');
    expect(texts[3]).toContain('나의 반석이신 하나님');
    expect(texts[8]).toContain('기 도');
    expect(texts[10]).toContain('나의 힘이신 여호와여 내가 주를 사랑하나이다');
    expect(texts[17]).toContain('성령으로 봉사하는 교회');
    // Placeholders never reach the screen.
    expect(texts.join('\n')).not.toContain('{{');

    // The 설교 구분 장 is where the pastor's own slides go in afterwards.
    await expect(page.getByTestId('wednesday-slide-list')).toContainText(
      '설교 슬라이드는 이 뒤에 직접 넣으세요',
    );
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
    await expect(page.getByTestId('wednesday-song-file-0')).toContainText('슬라이드 4장');
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
    await expect(page.getByTestId('wednesday-song-file-0')).toContainText('슬라이드 4장');
  });

  test('offers the search hits the proxy is willing to fetch', async ({ page }) => {
    const songFile = await fs.readFile(SONG_PPTX);
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

    await page.getByTestId('wednesday-tab-songs').click();
    await page.getByTestId('wednesday-song-add').click();
    await page.getByTestId('wednesday-song-title-0').fill('없는 곡');
    await page.getByTestId('wednesday-song-search-0').click();

    await expect(page.getByTestId('wednesday-song-message-0')).toContainText('찾지 못했습니다');
    // The upload path is still right there.
    await expect(page.getByTestId('wednesday-song-upload-0')).toBeVisible();
  });

  test('links both generators to each other', async ({ page }) => {
    await page.getByTestId('wednesday-to-sunday').click();
    await expect(page.getByTestId('wizard-panel-lyrics')).toBeVisible();
    await page.getByTestId('wednesday-link').click();
    await expect(page.getByTestId('wednesday-panel-service')).toBeVisible();
  });
});
