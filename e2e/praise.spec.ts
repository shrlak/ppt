import { test, expect, type Locator, type Page } from '@playwright/test';
import JSZip from 'jszip';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SAMPLE_PDF = path.join(HERE, '..', 'samples', 'conti-example.pdf');
const PARSE_TIMEOUT = 30_000;
const BUILD_TIMEOUT = 60_000;

async function slideTexts(zip: JSZip): Promise<string[]> {
  const presentation = await zip.file('ppt/presentation.xml')!.async('string');
  const rels = await zip.file('ppt/_rels/presentation.xml.rels')!.async('string');
  const texts: string[] = [];
  for (const match of presentation.matchAll(/<p:sldId [^>]*r:id="([^"]+)"/g)) {
    const target = rels.match(new RegExp(`Id="${match[1]}"[^>]*Target="([^"]+)"`))![1];
    const xml = await zip.file(`ppt/${target}`)!.async('string');
    texts.push([...xml.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((run) => run[1]).join(' | '));
  }
  return texts;
}

async function addLibrarySong(page: Page, title: string): Promise<void> {
  await page.getByTestId('library-add-search').fill(title);
  await page.getByTestId('library-add-option').filter({ hasText: title }).first().click();
}

test.describe('service picker', () => {
  test('offers 주일예배, 찬양집회 and 수련회', async ({ page }) => {
    await page.goto('./');
    await expect(page.getByTestId('service-picker')).toBeVisible();
    await page.getByTestId('service-retreat').click();
    await expect(page.getByTestId('retreat-panel-info')).toBeVisible();
    await page.getByTestId('nav-home').click();
    await expect(page.getByTestId('service-picker')).toBeVisible();

    await page.getByTestId('service-sunday').click();
    await expect(page.getByTestId('wizard-panel-lyrics')).toBeVisible();
    expect(page.url()).toContain('service=sunday');

    // Back returns to the choice, and the 찬양집회 choice opens its own page.
    await page.goBack();
    await expect(page.getByTestId('service-picker')).toBeVisible();
    await page.getByTestId('service-praise').click();
    await expect(page.getByTestId('praise-panel-songs')).toBeVisible();

    await page.getByTestId('nav-home').click();
    await expect(page.getByTestId('service-picker')).toBeVisible();
  });

  test('offers 수요예배 as a choice of its own', async ({ page }) => {
    await page.goto('./');
    await page.getByTestId('service-wednesday').click();
    await expect(page.getByTestId('wednesday-panel-service')).toBeVisible();
  });

  test('the rail reaches every generator and marks the one you are in', async ({ page }) => {
    await page.goto('praise.html');
    await expect(page.getByTestId('nav-praise')).toHaveAttribute('aria-current', 'page');

    await page.getByTestId('nav-retreat').click();
    await expect(page.getByTestId('retreat-panel-info')).toBeVisible();
    await expect(page.getByTestId('nav-retreat')).toHaveAttribute('aria-current', 'page');
    await expect(page.getByTestId('nav-praise')).not.toHaveAttribute('aria-current', 'page');

    await page.getByTestId('nav-wednesday').click();
    await expect(page.getByTestId('wednesday-panel-service')).toBeVisible();

    await page.getByTestId('nav-sunday').click();
    await expect(page.getByTestId('wizard-panel-lyrics')).toBeVisible();
    await expect(page.getByTestId('nav-sunday')).toHaveAttribute('aria-current', 'page');
  });
});

test.describe('찬양집회 generator', () => {
  test('builds a bilingual deck from a conti, with last year’s English filled in', async ({ page }, testInfo) => {
    await page.goto('praise.html');
    await expect(page.getByTestId('praise-panel-songs')).toBeVisible();

    // The same conti upload as Sunday; a praise night keeps every song.
    await page.getByTestId('pdf-input').setInputFiles(SAMPLE_PDF);
    await expect(page.getByTestId('conti-info')).toBeVisible({ timeout: PARSE_TIMEOUT });
    await expect(page.getByTestId('song-card').first()).toBeVisible({ timeout: PARSE_TIMEOUT });
    await expect(page.getByTestId('song-post-sermon-toggle')).toHaveCount(0);
    const contiSongs = await page.getByTestId('song-card').count();

    // A song sung last year: its Korean from the 찬양 라이브러리 lines up
    // with last year's English even though the line breaks differ.
    await addLibrarySong(page, '주님의 선하심');
    // One the library never had: a blank song, loaded from last year's deck.
    await page.getByTestId('add-song').click();
    await page.getByTestId('song-title-input').last().fill('Who Else');
    await expect(page.getByTestId('song-card')).toHaveCount(contiSongs + 2);

    await page.getByTestId('praise-next-songs').click();
    const goodness = page.getByTestId('praise-english-song').filter({ hasText: '주님의 선하심' });
    await expect(goodness.getByTestId('praise-english-title')).toHaveValue('Goodness of God');
    await expect(goodness.getByTestId('praise-slide-english').first()).toHaveValue(/I love You Lord/);
    await expect(goodness.getByTestId('praise-english-status')).toHaveClass(/is-done/);
    await goodness.getByTestId('praise-prayer-after').check();

    const whoElse = page.getByTestId('praise-english-song').filter({ hasText: 'Who Else' });
    await whoElse.getByTestId('praise-load-library').click();
    await expect(whoElse.getByTestId('praise-english-status')).toContainText('영어 곡');

    // Typed English sticks to its slide.
    const firstSong = page.getByTestId('praise-english-song').first();
    const firstBox = firstSong.getByTestId('praise-slide-english').first();
    await firstBox.fill('Typed English line');
    await firstSong.getByTestId('praise-english-title').fill('Typed Title');

    await page.getByTestId('praise-tab-download').click();
    await page.getByTestId('praise-date').fill('2026-09-26');
    await expect(page.getByTestId('praise-file-name')).toHaveValue('0926_PraiseNight.pptx');

    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: BUILD_TIMEOUT }),
      page.getByTestId('praise-download').click(),
    ]);
    expect(download.suggestedFilename()).toBe('0926_PraiseNight.pptx');
    const saveTo = testInfo.outputPath('praise.pptx');
    await download.saveAs(saveTo);
    const texts = await slideTexts(await JSZip.loadAsync(await fs.readFile(saveTo)));

    expect(texts[0]).toBe('09/26/2026');
    expect(texts).toContain('주님의 선하심 | Goodness of God');
    const goodnessLyrics = texts.filter((text) => text.startsWith('주님의 선하심 | Goodness of God | '));
    expect(goodnessLyrics.length).toBeGreaterThan(0);
    expect(goodnessLyrics[0]).toContain('I love You Lord');
    // The 기도 slide follows the song it was asked after.
    const lastGoodness = texts.lastIndexOf(goodnessLyrics.at(-1)!);
    expect(texts[lastGoodness + 1]).toContain('Prayer');
    expect(texts).toContain('Who Else');
    expect(texts.some((text) => text.includes('Typed English line'))).toBe(true);
    expect(texts.some((text) => text.includes('| Typed Title |'))).toBe(true);

    // The preview draws the real slides, photo backgrounds included.
    await page.getByTestId('praise-preview').click();
    const grid = page.getByTestId('praise-preview-grid');
    await expect(grid).toBeVisible({ timeout: BUILD_TIMEOUT });
    await expect(grid.locator('.slide-thumb')).toHaveCount(texts.length);
    await grid.scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath('praise-preview.png'), fullPage: true });
  });

  test('fills English the conti lacks from the web by itself, with no button pressed', async ({ page }) => {
    // Made-up lyrics, served the way a 영어 가사 post comes back from the proxy.
    const asked: string[] = [];
    await page.route('**/__proxy/praise/english**', async (route) => {
      asked.push(new URL(route.request().url()).searchParams.get('title') ?? '');
      await route.fulfill({
        json: {
          title: '시험의 노래',
          query: '시험의 노래 영어 가사',
          candidates: [
            {
              url: 'https://example.tistory.com/1',
              host: 'example.tistory.com',
              title: '[영어찬양] Song of Trial, 시험의 노래, 영어 가사',
              englishTitle: 'Song of Trial',
              score: 1,
              blocks: [
                { lang: 'ko', lines: ['주 사랑 안에 나 살아가리', '그 은혜 날마다 새롭네'] },
                { lang: 'en', lines: ['In Your love I will live my days', 'Your grace is new every morning'] },
                { lang: 'ko', lines: ['주를 찬양해 영원토록', '주의 이름 높이리'] },
                { lang: 'en', lines: ['I will praise You forevermore', 'I lift Your name on high'] },
              ],
            },
          ],
        },
      });
    });

    await page.goto('praise.html');
    await page.getByTestId('add-song').click();
    const card = page.getByTestId('song-card').last();
    await card.getByTestId('song-title-input').fill('시험의 노래');
    await card.getByRole('button', { name: 'V', exact: true }).click();
    await card.getByTestId('section-textarea').last().fill('주 사랑 안에 나 살아가리\n그 은혜 날마다 새롭네');
    await card.getByRole('button', { name: 'C', exact: true }).click();
    await card.getByTestId('section-textarea').last().fill('주를 찬양해 영원토록\n주의 이름 높이리');
    // The edit is written to the 찬양 라이브러리 straight away, and says so.
    await expect(card.getByTestId('song-autosave')).toContainText('가사 자동 저장됨');

    await page.getByTestId('praise-next-songs').click();
    const song = page.getByTestId('praise-english-song').filter({ hasText: '시험의 노래' });
    const boxes = song.getByTestId('praise-slide-english');
    await expect(boxes.first()).toHaveValue(/In Your love I will live my days/, { timeout: 15_000 });
    await expect(boxes.nth(1)).toHaveValue(/I will praise You forevermore/);
    await expect(song.getByTestId('praise-english-title')).toHaveValue('Song of Trial');
    await expect(song.getByTestId('praise-english-status')).toContainText('웹에서 가져옴');
    await expect(song.getByTestId('praise-web-source')).toHaveAttribute('href', 'https://example.tistory.com/1');
    // One search for the song, by its title, and none started by hand.
    expect(asked).toEqual(['시험의 노래']);
  });

  test('lists the night’s songs on the left, and a title there takes the page to that song', async ({ page }) => {
    // No English on the web for these songs, answered at once.
    await page.route('**/__proxy/praise/english**', (route) => route.fulfill({ json: { candidates: [] } }));
    await page.setViewportSize({ width: 1440, height: 800 });
    await page.goto('praise.html');
    const list = page.getByTestId('praise-song-list');
    await expect(list).toBeVisible();
    await expect(list).toContainText('콘티를 올리거나 곡을 추가하면');

    const titles = ['갈급한 내 맘', '광야를 지나며', '주님의 선하심', '감사함으로', '거친 길 위를 걸어갈 때도'];
    for (const title of titles) await addLibrarySong(page, title);
    const items = list.getByTestId('praise-song-list-item');
    await expect(items).toHaveCount(titles.length);
    for (const [index, title] of titles.entries()) await expect(items.nth(index)).toContainText(title);
    // Its English title from last year's deck shows under the Korean one.
    await expect(items.nth(2)).toContainText('Goodness of God');

    // The list stands to the left of the step.
    const listBox = (await list.boundingBox())!;
    const mainBox = (await page.locator('#main-content').boundingBox())!;
    expect(listBox.x + listBox.width).toBeLessThanOrEqual(mainBox.x);

    const topOf = (locator: Locator) =>
      locator.evaluate((element) => Math.round(element.getBoundingClientRect().top));

    // A title pressed on the 찬양 step brings that song's card to the top.
    await items.nth(3).click();
    await expect.poll(() => topOf(page.getByTestId('song-card').nth(3))).toBeLessThan(40);
    await expect(items.nth(3)).toHaveAttribute('aria-current', 'true');
    // The list stays in view while the page scrolls.
    await expect(list).toBeInViewport();

    // Scrolling back up by hand marks the song now at the top.
    await page.getByTestId('song-card').nth(3).locator('.song-number').hover();
    await page.mouse.wheel(0, (await topOf(page.getByTestId('song-card').nth(1))) - 16);
    await expect(items.nth(1)).toHaveAttribute('aria-current', 'true');
    await expect(items.nth(3)).not.toHaveAttribute('aria-current', 'true');

    // On the 영어 가사 step it goes to the song's English card instead.
    await page.getByTestId('praise-next-songs').click();
    await expect(page.getByTestId('praise-panel-english')).toBeVisible();
    // The web lookups' notes settle first, so they don't move the cards mid-scroll.
    const lookups = page.getByTestId('praise-web-status');
    await expect(lookups.first()).toBeVisible({ timeout: 15_000 });
    await expect(lookups.filter({ hasText: '찾는 중' })).toHaveCount(0, { timeout: 15_000 });
    await items.nth(2).click();
    await expect(page.getByTestId('praise-panel-english')).toBeVisible();
    const goodness = page.getByTestId('praise-english-song').nth(2);
    await expect(goodness).toContainText('주님의 선하심');
    await expect.poll(() => topOf(goodness)).toBeLessThan(40);

    // From a step with no songs on it, the 찬양 step opens at that song.
    await page.getByTestId('praise-tab-download').click();
    await expect(items.first()).not.toHaveAttribute('aria-current', 'true');
    await items.nth(4).click();
    await expect(page.getByTestId('praise-panel-songs')).toBeVisible();
    const last = page.getByTestId('song-card').nth(4);
    await expect(last).toBeInViewport();
    await expect(items.nth(4)).toHaveAttribute('aria-current', 'true');
  });

  test('keeps both languages by itself, and the Sunday page loads only the Korean', async ({ page }) => {
    await page.goto('praise.html');
    await expect(page.getByTestId('praise-panel-songs')).toBeVisible();

    // A song from the 찬양 라이브러리: its English comes from last year's deck.
    await addLibrarySong(page, '주님의 선하심');
    // A song only last year's deck knew, loaded from it in both languages.
    await page.getByTestId('add-song').click();
    await page.getByTestId('song-title-input').last().fill('춤추는 세대');
    await page.getByTestId('praise-next-songs').click();
    await page
      .getByTestId('praise-english-song')
      .filter({ hasText: '춤추는 세대' })
      .getByTestId('praise-load-library')
      .click();

    // No save button pressed: the Korean and English are kept once they settle…
    await expect
      .poll(
        async () =>
          page.evaluate(() => {
            const saved = JSON.parse(localStorage.getItem('praise-english-library') ?? '[]') as {
              title: string;
              slides: { ko: string[]; en: string[] }[];
            }[];
            const goodness = saved.find((entry) => entry.title === '주님의 선하심');
            return Boolean(goodness?.slides.some((slide) => slide.ko.length > 0 && slide.en.length > 0));
          }),
        { timeout: 15_000 },
      )
      .toBe(true);
    // …and the Korean alone reaches the 찬양 라이브러리 the Sunday page reads.
    await expect
      .poll(
        async () =>
          page.evaluate(() =>
            (JSON.parse(localStorage.getItem('praise-lyrics-library') ?? '[]') as { title: string }[]).some(
              (entry) => entry.title === '춤추는 세대',
            ),
          ),
        { timeout: 15_000 },
      )
      .toBe(true);

    await page.goto('./?service=sunday');
    await addLibrarySong(page, '춤추는 세대');
    const card = page.getByTestId('song-card').filter({ has: page.getByTestId('song-title-input') }).last();
    const lyrics = (
      await card.getByTestId('section-textarea').evaluateAll((boxes) => boxes.map((box) => (box as HTMLTextAreaElement).value))
    ).join('\n');
    expect(lyrics).toContain('주 자비 춤추게 하네');
    expect(lyrics).not.toContain('Your mercy taught us how to dance');
  });
});

