import { test, expect, type Locator, type Page } from '@playwright/test';
import JSZip from 'jszip';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SAMPLE_PDF = path.join(HERE, '..', 'samples', 'conti-example.pdf');
// Any portrait picture stands in for this year's flyer.
const FLYER = path.join(HERE, '..', 'tests', 'fixtures', 'sheet-page.png');
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

  test('puts each 기도 — its 기도제목, 말씀 and prayer title — after the checked songs, in order', async ({ page }, testInfo) => {
    // No English on the web for these songs, answered at once.
    await page.route('**/__proxy/praise/english**', (route) => route.fulfill({ json: { candidates: [] } }));
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('praise.html');
    for (const title of ['주님의 선하심', '감사함으로', '광야를 지나며']) await addLibrarySong(page, title);

    await page.getByTestId('praise-tab-prayer').click();
    const plan = page.getByTestId('praise-prayer-plan');
    await expect(plan.getByTestId('praise-prayer-count')).toHaveText('0번');
    // Two 기도 written ahead of time wait at the end until songs are checked.
    await plan.getByTestId('praise-prayer-count-up').click();
    await plan.getByTestId('praise-prayer-count-up').click();
    await expect(plan.getByTestId('praise-prayer-count')).toHaveText('2번');
    await expect(page.getByTestId('praise-prayer-waiting')).toContainText('기도 1, 기도 2');

    const cards = page.getByTestId('praise-prayer');
    const first = cards.nth(0);
    await first.getByTestId('praise-topics-input').fill('- 찬양집회를 통해 성령님께서 마음을 만지시도록\n- 복음의 열정이 회복되도록');
    await expect(first.getByTestId('praise-topics-hint')).toContainText('기도제목 2개');
    await expect(first.getByTestId('praise-topics-heading-en')).toHaveValue('Prayer Prompt');
    await first.getByTestId('praise-prayer-add-scripture').click();
    await first.getByTestId('praise-scripture-input').fill('행 1:8');
    await expect(first.getByTestId('praise-scripture-status')).toContainText('사도행전 1장 8절 · Acts 1:8 — 1절', {
      timeout: 30_000,
    });
    // 말씀 goes before 기도 / Prayer: 기도제목 → 말씀 → 기도.
    await first.getByRole('button', { name: '말씀 위로' }).click();
    await expect(first.getByTestId('praise-prayer-slide')).toHaveCount(3);
    await expect(first.getByTestId('praise-prayer-slide').nth(1)).toHaveAttribute('data-kind', 'scripture');
    await expect(first.getByTestId('praise-prayer-slide-count')).toHaveText('슬라이드 3장');
    // The second: 축도 alone, picked from the usual titles.
    const second = cards.nth(1);
    await second.getByTestId('praise-prayer-slide-remove').first().click();
    await second.getByTestId('praise-prayer-title-preset').selectOption({ label: '축도 / Benediction' });
    await expect(second.getByTestId('praise-prayer-title-ko')).toHaveValue('축도');
    await expect(second.getByTestId('praise-prayer-title-en')).toHaveValue('Benediction');

    // Checked out of order, the 기도 still follow the songs in order.
    const songRows = plan.getByTestId('praise-prayer-song');
    await songRows.nth(2).getByTestId('praise-prayer-song-toggle').check();
    await songRows.nth(0).getByTestId('praise-prayer-song-toggle').check();
    await expect(songRows.nth(0)).toContainText('기도 1');
    await expect(songRows.nth(2)).toContainText('기도 2');
    await expect(first.getByTestId('praise-prayer-where')).toHaveText('1. 주님의 선하심 뒤');
    await expect(second.getByTestId('praise-prayer-where')).toHaveText('3. 광야를 지나며 뒤');
    await expect(page.getByTestId('praise-prayer-waiting')).toHaveCount(0);
    await plan.scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath('praise-prayer-step.png'), fullPage: true });

    // Checking the middle song on the 영어 가사 step brings in a 기도 of its
    // own there; unchecking it takes that empty 기도 back out.
    await page.getByTestId('praise-tab-english').click();
    const middle = page.getByTestId('praise-english-song').nth(1);
    await middle.getByTestId('praise-prayer-after').check();
    await expect(middle.locator('.praise-prayer-toggle')).toContainText('기도 2');
    await page.getByTestId('praise-tab-prayer').click();
    await expect(plan.getByTestId('praise-prayer-count')).toHaveText('3번');
    await expect(songRows.nth(2)).toContainText('기도 3');
    await songRows.nth(1).getByTestId('praise-prayer-song-toggle').uncheck();
    await expect(plan.getByTestId('praise-prayer-count')).toHaveText('2번');
    await expect(second.getByTestId('praise-prayer-title-ko')).toHaveValue('축도');

    await page.getByTestId('praise-tab-download').click();
    await expect(page.getByTestId('praise-summary')).toContainText('기도 2번 (4장)');
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: BUILD_TIMEOUT }),
      page.getByTestId('praise-download').click(),
    ]);
    const saveTo = testInfo.outputPath('praise-prayer.pptx');
    await download.saveAs(saveTo);
    const texts = await slideTexts(await JSZip.loadAsync(await fs.readFile(saveTo)));

    const topics = texts.indexOf(
      '기도제목 | Prayer Prompt | 찬양집회를 통해 성령님께서 마음을 만지시도록 | 복음의 열정이 회복되도록',
    );
    expect(topics).toBeGreaterThan(0);
    expect(texts[topics - 1]).toMatch(/^주님의 선하심 \| Goodness of God \| /);
    expect(texts[topics + 1]).toBe(
      '사도행전 1장 8절 | Acts 1:8 | 사도행전 1장 8절 | 오직 성령이 너희에게 임하시면 너희가 권능을 받고 예루살렘과 온 유대와 사마리아와 땅 끝까지 이르러 내 증인이 되리라 하시니라 | Acts 1:8 | but you will receive power when the Holy Spirit has come upon you; and you shall be My witnesses both in Jerusalem and in all Judea, and Samaria, and as far as the remotest part of the earth.”',
    );
    expect(texts[topics + 2]).toBe('기도 |  | Prayer');
    expect(texts[topics + 3]).toMatch(/^감사함으로/);
    expect(texts.at(-1)).toBe('축도 |  | Benediction');
    expect(texts.at(-2)).toMatch(/^광야를 지나며/);
    // One 기도 / Prayer: the middle song's empty 기도 left with its check.
    expect(texts.filter((text) => text === '기도 |  | Prayer')).toHaveLength(1);

    // The preview draws the 기도 slides in last year's designs.
    await page.getByTestId('praise-preview').click();
    const grid = page.getByTestId('praise-preview-grid');
    await expect(grid.locator('.slide-thumb')).toHaveCount(texts.length, { timeout: BUILD_TIMEOUT });
    await grid.locator('li').nth(topics).scrollIntoViewIfNeeded();
    await grid.screenshot({ path: testInfo.outputPath('praise-prayer-preview.png') });
  });

  test('opens the deck with a poster edited on the page, ahead of the cover', async ({ page }, testInfo) => {
    await page.route('**/__proxy/praise/english**', (route) => route.fulfill({ json: { candidates: [] } }));
    await page.goto('praise.html');
    await addLibrarySong(page, '주님의 선하심');
    await page.getByTestId('praise-tab-download').click();
    await page.getByTestId('praise-date').fill('2026-09-26');
    await expect(page.getByTestId('praise-summary-poster')).toHaveText('없음');
    const before = Number((await page.getByTestId('praise-slide-count').textContent())!.replace(/\D/g, ''));

    // Switched on but empty, it waits for something to show.
    await page.getByTestId('praise-poster-enabled').check();
    await expect(page.getByTestId('praise-poster-empty')).toBeVisible();
    await expect(page.getByTestId('praise-summary-poster')).toHaveText('없음');

    // A picture and the words over it, drawn as they are typed.
    await page.getByTestId('praise-poster-input').setInputFiles(FLYER);
    await page.getByTestId('praise-poster-title').fill('EM & KM Praise Night');
    await page.getByTestId('praise-poster-details').fill('09/26/2026 7PM\nKorean Central Church of Pittsburgh');
    const preview = page.getByTestId('praise-poster-preview');
    await expect(preview.locator('img')).toBeVisible();
    await expect(preview).toContainText('EM & KM Praise Night');
    await expect(preview).toContainText('Korean Central Church of Pittsburgh');
    await expect(page.getByTestId('praise-poster-empty')).toHaveCount(0);
    await expect(page.getByTestId('praise-summary-poster')).toHaveText('맨 첫 장');
    await expect(page.getByTestId('praise-slide-count')).toHaveText(`${before + 1}장`);
    await page.getByTestId('praise-poster').screenshot({ path: testInfo.outputPath('praise-poster-card.png') });

    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: BUILD_TIMEOUT }),
      page.getByTestId('praise-download').click(),
    ]);
    const saveTo = testInfo.outputPath('praise-poster.pptx');
    await download.saveAs(saveTo);
    const zip = await JSZip.loadAsync(await fs.readFile(saveTo));
    const texts = await slideTexts(zip);
    expect(texts[0]).toBe('EM &amp; KM Praise Night | 09/26/2026 7PM | Korean Central Church of Pittsburgh');
    expect(texts[1]).toBe('09/26/2026');
    expect(zip.file('ppt/media/praise-poster.png')).not.toBeNull();

    // The real first slide: the picture with the words over it.
    await page.getByTestId('praise-preview').click();
    const grid = page.getByTestId('praise-preview-grid');
    await expect(grid).toBeVisible({ timeout: BUILD_TIMEOUT });
    await expect(grid.locator('.slide-thumb')).toHaveCount(texts.length);
    const first = grid.locator('.slide-thumb').first();
    await expect(first.locator('img')).toHaveCount(1);
    await expect(first).toContainText('EM & KM Praise Night');
    await expect(grid.locator('li').first()).toContainText('포스터');
    await grid.screenshot({ path: testInfo.outputPath('praise-poster-preview.png') });

    // Switched off, the poster leaves the deck but keeps what was entered.
    await page.getByTestId('praise-poster-enabled').uncheck();
    await expect(page.getByTestId('praise-slide-count')).toHaveText(`${before}장`);
    await page.getByTestId('praise-poster-enabled').check();
    await expect(page.getByTestId('praise-poster-title')).toHaveValue('EM & KM Praise Night');
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
    // 가사 모두 저장 saves every song that has lyrics, in one go.
    await page.getByTestId('save-all-songs').click();
    await expect(page.getByText('찬양 1곡의 가사를 라이브러리에 저장했습니다.')).toBeVisible();
    await page.getByTestId('praise-next-songs').click();
    await page
      .getByTestId('praise-english-song')
      .filter({ hasText: '춤추는 세대' })
      .getByTestId('praise-load-library')
      .click();
    // So does 한글·영어 가사 모두 저장, both languages of every song.
    await page.getByTestId('praise-save-all-english').click();
    await expect(page.getByText(/찬양 2곡의 한글·영어 가사를 저장했습니다/)).toBeVisible();

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


// --- Songs saved slide by slide, read again for their parts -------------------
//
// A song only a past 찬양집회 deck knows is saved slide by slide: parts 1, 2,
// 3… On a conti with its 악보 it is read like a new song — the 악보's parts and
// 진행, then the web's words part by part — and its saved slides stand in
// until then. All lyrics here are invented.

const PROXY = '**/ppt/__proxy';

/** Last year's slides for the conti's first song, each with its English. */
const SAVED_SLIDES = [
  {
    ko: ['사랑의 주님 나를 부르시네', '그 음성 따라 나아가리'],
    en: ['Loving Lord, You call my name', 'I will follow where You lead'],
  },
  {
    ko: ['주님의 사랑 끝이 없어라', '영원히 나 노래하리'],
    en: ['Your love, O Lord, will never end', 'Forever I will sing'],
  },
  {
    ko: ['주님의 사랑 넓고 깊어라', '날마다 나 찬양하리'],
    en: ['Your love, O Lord, is wide and deep', 'Each day I will praise'],
  },
];

/** What the models read off the 악보: its parts and 진행, one syllable misread. */
const SCORE_READING = {
  pageType: 'score',
  sermonTitle: '',
  scripture: '',
  title: '주님의 사랑',
  artist: '',
  key: 'G',
  order: ['I', 'V', 'C', 'V'],
  lyricRowCount: 1,
  sections: [
    { label: 'V', lines: ['사랑의 주님 나를 부르시녜', '그 음성 따라 나아가리'] },
    { label: 'C', lines: ['주님의 사랑 끝이 없어라', '영원히 나 노래하리', '주님의 사랑 넓고 깊어라', '날마다 나 찬양하리'] },
  ],
};

async function stubSavedSlideSong(page: Page, webLines: string[] | null): Promise<void> {
  // The 찬양 라이브러리 lacks the song; only last year's deck has it.
  await page.route('**/ppt/library.json', (route) => route.fulfill({ json: [] }));
  await page.route('**/ppt/praise-english.json', (route) =>
    route.fulfill({ json: [{ title: '주님의 사랑', englishTitle: 'Love of the Lord', slides: SAVED_SLIDES }] }),
  );
  await page.route(`${PROXY}/settings`, (route) => route.fulfill({ json: {} }));
  await page.route(`${PROXY}/learning/models`, (route) => route.fulfill({ json: { models: [] } }));
  const answer = (images: number) =>
    JSON.stringify({ results: Array.from({ length: Math.max(1, images) }, (_, imageIndex) => ({ imageIndex, ...SCORE_READING })) });
  await page.route(`${PROXY}/gemini/**`, async (route) => {
    const payload = route.request().postDataJSON() as { contents?: { parts?: unknown[] }[] };
    const images = (payload.contents?.[0]?.parts ?? []).filter((part) => !!(part as { inlineData?: unknown }).inlineData);
    await route.fulfill({ json: { candidates: [{ content: { parts: [{ text: answer(images.length) }] } }] } });
  });
  await page.route(`${PROXY}/openrouter`, async (route) => {
    const payload = route.request().postDataJSON() as { messages?: { content?: unknown[] }[] };
    const images = (payload.messages?.[0]?.content ?? []).filter((part) => (part as { type?: string }).type === 'image_url');
    await route.fulfill({ json: { choices: [{ message: { content: answer(images.length) } }] } });
  });
  await page.route(`${PROXY}/lyrics*`, (route) =>
    route.fulfill({
      json: {
        candidates: webLines
          ? [
              {
                id: 'ccm:ccm.co.kr/song/7',
                title: '주님의 사랑',
                artist: '어느 사역팀',
                lines: webLines,
                url: 'https://ccm.co.kr/song/7',
                host: 'ccm.co.kr',
                source: 'ccm',
                sourceTrust: 0.9,
                score: 0.95,
                titleScore: 1,
                artistScore: 0,
                lyricsScore: 0.9,
                decision: 'auto',
              },
            ]
          : [],
        links: [],
      },
    }),
  );
  await page.route('**/__proxy/praise/english**', (route) => route.fulfill({ json: { candidates: [] } }));
}

async function sectionsOf(card: Locator): Promise<{ labels: string[]; texts: string[] }> {
  const labels = await card
    .locator('.section-label')
    .evaluateAll((inputs) => inputs.map((input) => (input as HTMLInputElement).value));
  const texts = await card
    .getByTestId('section-textarea')
    .evaluateAll((boxes) => boxes.map((box) => (box as HTMLTextAreaElement).value));
  return { labels, texts };
}

async function recognizeFirstSong(page: Page): Promise<Locator> {
  const card = page.getByTestId('song-card').first();
  // Automatic recognition is skipped under browser automation: press the button a user could.
  await card.getByTestId('recognize-btn').click();
  await expect(card.getByTestId('recog-running')).toHaveCount(0, { timeout: PARSE_TIMEOUT });
  await expect(card.getByTestId('recog-done')).toBeVisible({ timeout: PARSE_TIMEOUT });
  return card;
}

test.describe('찬양집회 songs saved slide by slide', () => {
  test('reads the 악보 for the parts, then puts the web lyrics in part by part', async ({ page }) => {
    // The page prints the verse, then the chorus twice, as stanzas.
    const verse = ['사랑의 주님 나를 부르시네', '그 음성 따라 나아가리'];
    const chorus = ['주님의 사랑 끝이 없어라', '영원히 나 노래하리', '주님의 사랑 넓고 깊어라', '날마다 나 찬양하리'];
    await stubSavedSlideSong(page, [...verse, '', ...chorus, '', ...chorus]);
    await page.goto('praise.html');
    await page.getByTestId('pdf-input').setInputFiles(SAMPLE_PDF);
    await expect(page.getByTestId('conti-info')).toBeVisible({ timeout: PARSE_TIMEOUT });

    // Until the 악보 is read, last year's slides stand in.
    const card = page.getByTestId('song-card').first();
    await expect(card.getByTestId('song-title-input')).toHaveValue('주님의 사랑');
    expect((await sectionsOf(card)).labels).toEqual(['1', '2', '3']);

    await recognizeFirstSong(page);
    const { labels, texts } = await sectionsOf(card);
    expect(labels).toEqual(['V', 'C']);
    expect(texts).toEqual([verse.join('\n'), chorus.join('\n')]);
    await expect(card.getByTestId('order-input')).toHaveValue('I-V-C-V');

    // The English of last year's slides follows the Korean into its parts.
    await page.getByTestId('praise-next-songs').click();
    const english = page.getByTestId('praise-english-song').filter({ hasText: '주님의 사랑' });
    await expect(english.getByTestId('praise-english-title')).toHaveValue('Love of the Lord');
    const boxes = english.getByTestId('praise-slide-english');
    await expect(boxes).toHaveCount(3);
    await expect(boxes.nth(0)).toHaveValue(SAVED_SLIDES[0].en.join('\n'));
    await expect(boxes.nth(1)).toHaveValue(SAVED_SLIDES[1].en.join('\n'));
    await expect(boxes.nth(2)).toHaveValue(SAVED_SLIDES[2].en.join('\n'));
  });

  test('with no page on the web, lays its own saved words over the 악보’s parts', async ({ page }) => {
    await stubSavedSlideSong(page, null);
    await page.goto('praise.html');
    await page.getByTestId('pdf-input').setInputFiles(SAMPLE_PDF);
    await expect(page.getByTestId('conti-info')).toBeVisible({ timeout: PARSE_TIMEOUT });

    const card = await recognizeFirstSong(page);
    const { labels, texts } = await sectionsOf(card);
    expect(labels).toEqual(['V', 'C']);
    // The misread syllable is gone: the words are the ones the deck projected.
    expect(texts).toEqual([
      SAVED_SLIDES[0].ko.join('\n'),
      [...SAVED_SLIDES[1].ko, ...SAVED_SLIDES[2].ko].join('\n'),
    ]);
    await expect(card.getByTestId('order-input')).toHaveValue('I-V-C-V');
    await expect(page.getByText("'주님의 사랑'의 저장된 가사를 악보의 파트 2개에 나눠 넣었습니다.")).toBeVisible();
  });
});
