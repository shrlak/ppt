import { test, expect, type Page } from '@playwright/test';
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
    await page.getByTestId('retreat-to-home').click();
    await expect(page.getByTestId('service-picker')).toBeVisible();

    await page.getByTestId('service-sunday').click();
    await expect(page.getByTestId('wizard-panel-lyrics')).toBeVisible();
    expect(page.url()).toContain('service=sunday');

    // Back returns to the choice, and the 찬양집회 choice opens its own page.
    await page.goBack();
    await expect(page.getByTestId('service-picker')).toBeVisible();
    await page.getByTestId('service-praise').click();
    await expect(page.getByTestId('praise-panel-songs')).toBeVisible();

    await page.getByTestId('praise-to-home').click();
    await expect(page.getByTestId('service-picker')).toBeVisible();
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

