import { test, expect, type Page, type Download } from '@playwright/test';
import JSZip from 'jszip';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SAMPLE_PDF = path.join(HERE, '..', 'samples', 'conti-example.pdf');
const ANNOUNCEMENTS_TEXT = path.join(HERE, '..', 'tests', 'fixtures', 'announcements-sample.txt');

// PDF parsing (pdf.js on scanned pages) and fetching translation JSON can be
// slow, especially in CI.
const PARSE_TIMEOUT = 30_000;

async function uploadExamplePdf(page: Page): Promise<void> {
  await expect(page.getByTestId('upload-dropzone')).toBeVisible();
  await page.getByTestId('pdf-input').setInputFiles(SAMPLE_PDF);
  // The worship info card appears once the cover page has been parsed.
  await expect(page.getByTestId('conti-info')).toBeVisible({ timeout: PARSE_TIMEOUT });
}

async function loadPptx(download: Download, saveTo: string): Promise<JSZip> {
  await download.saveAs(saveTo);
  const buffer = await fs.readFile(saveTo);
  return JSZip.loadAsync(buffer);
}

function slideFileNames(zip: JSZip): string[] {
  return Object.keys(zip.files).filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name));
}

test('loads the app shell with every section on one page', async ({ page }) => {
  await page.goto('./');
  await expect(page.getByText('KCCP PPT Generator').first()).toBeVisible();
  await expect(page.getByText('🎵 찬양')).toBeVisible();
  await expect(page.getByText('📖 성경 말씀')).toBeVisible();
  await expect(page.getByText('🎤 설교')).toBeVisible();
  await expect(page.getByText('📢 광고')).toBeVisible();
  await expect(page.getByTestId('generate-pptx')).toBeVisible();
  // Everything lives on one page — the lyrics upload and the bible verse
  // input are both present without switching tabs.
  await expect(page.getByTestId('pdf-input')).toBeAttached();
  await expect(page.getByTestId('bible-verse-input')).toBeVisible();
});

test('parses the example conti PDF and prefills songs', async ({ page }) => {
  await page.goto('./');
  await uploadExamplePdf(page);

  const contiInfo = page.getByTestId('conti-info');
  await expect(contiInfo).toContainText('하나님과 화평을 누리자', { timeout: PARSE_TIMEOUT });
  await expect(contiInfo).toContainText('7/11/26', { timeout: PARSE_TIMEOUT });

  // The final cover song is the 공동체 고백송 and is intentionally excluded.
  const songCards = page.getByTestId('song-card');
  await expect
    .poll(async () => songCards.count(), { timeout: PARSE_TIMEOUT })
    .toBeGreaterThanOrEqual(2);

  const titles = await songCards
    .getByTestId('song-title-input')
    .evaluateAll((inputs) => inputs.map((input) => (input as unknown as { value: string }).value));
  expect(titles).not.toContain('입례');

  const firstCard = songCards.first();
  await expect(firstCard.getByTestId('song-title-input')).toHaveValue('주님의 사랑', {
    timeout: PARSE_TIMEOUT,
  });
  await expect(firstCard.getByTestId('order-input')).not.toHaveValue('', {
    timeout: PARSE_TIMEOUT,
  });

  await expect(page.getByTestId('slide-count')).toContainText(/총 \d+장/, {
    timeout: PARSE_TIMEOUT,
  });
  await expect(page.getByTestId('bible-verse-input')).toHaveValue('롬5:1-11');
  await expect(page.getByTestId('bible-sermon-title-input')).toHaveValue('하나님과 화평을 누리자');
});

test('generates a valid pptx from the parsed conti alone', async ({ page }, testInfo) => {
  await page.goto('./');
  await uploadExamplePdf(page);

  // Lyrics are pre-filled from the bundled library, so generation works immediately.
  await expect(page.getByTestId('slide-count')).toContainText(/총 \d+장/, {
    timeout: PARSE_TIMEOUT,
  });

  const dlPromise = page.waitForEvent('download');
  await page.getByTestId('generate-pptx').click();
  const download = await dlPromise;

  // The app derives the file name from the conti date.
  await expect(page.getByTestId('filename-input')).toHaveValue('7.11.26 찬양 가사.pptx');

  const zip = await loadPptx(download, testInfo.outputPath('conti.pptx'));

  expect(zip.file('ppt/presentation.xml')).not.toBeNull();
  expect(zip.file('[Content_Types].xml')).not.toBeNull();

  // Combined deck = front 4 + back 21 + prayer 2 + generated content.
  const slides = slideFileNames(zip);
  expect(slides.length).toBeGreaterThanOrEqual(27);

  const presentationXml = await zip.file('ppt/presentation.xml')!.async('string');
  const sldIdCount = (presentationXml.match(/<p:sldId /g) ?? []).length;
  expect(sldIdCount).toBe(slides.length);

  const allText = (await Promise.all(slides.map((f) => zip.file(f)!.async('string')))).join('\n');
  expect(allText).toContain('주님의 사랑');
  expect(allText).toContain('기도');
});

test('manual flow without a PDF', async ({ page }, testInfo) => {
  await page.goto('./');

  const librarySelect = page.getByTestId('library-add-select');
  await expect(librarySelect).toBeVisible();
  // The library loads asynchronously; wait until real options exist beyond a placeholder.
  await expect(librarySelect.locator('option').nth(1)).toBeAttached({ timeout: PARSE_TIMEOUT });

  const labels = await librarySelect.locator('option').allTextContents();
  const songIndex = labels.findIndex((label) => label.includes('주님의 사랑'));
  await librarySelect.selectOption({ index: songIndex >= 0 ? songIndex : 1 });

  const songCards = page.getByTestId('song-card');
  await expect(songCards).toHaveCount(1, { timeout: PARSE_TIMEOUT });
  await expect(songCards.first().getByTestId('song-title-input')).not.toHaveValue('');

  const dlPromise = page.waitForEvent('download');
  await page.getByTestId('generate-pptx').click();
  const download = await dlPromise;

  const zip = await loadPptx(download, testInfo.outputPath('manual.pptx'));
  expect(slideFileNames(zip).length).toBeGreaterThanOrEqual(2);
});

test('auto-recognition settings: pick an engine and persist the Gemini key', async ({ page }) => {
  await page.goto('./');

  await page.getByTestId('ai-settings-open').click();
  const keyInput = page.getByTestId('gemini-key-input');
  await expect(keyInput).toBeVisible();

  // The key field belongs to the Gemini engine; switching to on-device OCR hides it.
  await page.locator('.ai-engine', { hasText: '브라우저 OCR' }).click();
  await expect(keyInput).toBeHidden();

  // Back to Gemini, enter a key, close, and reopen — it is remembered locally.
  await page.locator('.ai-engine', { hasText: 'Gemini' }).click();
  await expect(keyInput).toBeVisible();
  await keyInput.fill('AIza-test-key');
  await page.getByRole('button', { name: '닫기' }).click();

  await page.getByTestId('ai-settings-open').click();
  await expect(page.getByTestId('gemini-key-input')).toHaveValue('AIza-test-key');
});

test('generates a bible verse slide deck alone', async ({ page }, testInfo) => {
  await page.goto('./');

  await page.getByTestId('bible-verse-input').fill('요3:16');
  await expect(page.getByTestId('bible-verse-preview')).toContainText('요한복음 3:16');

  const dlPromise = page.waitForEvent('download');
  await page.getByTestId('generate-pptx').click();
  const download = await dlPromise;

  const zip = await loadPptx(download, testInfo.outputPath('bible.pptx'));
  expect(zip.file('ppt/presentation.xml')).not.toBeNull();
  const slides = slideFileNames(zip);
  expect(slides.length).toBeGreaterThan(0);

  const allText = (await Promise.all(slides.map((f) => zip.file(f)!.async('string')))).join('\n');
  expect(allText).toContain('요한복음 3:16');
  expect(allText).not.toContain('{{BODY}}');
});

test('generates one combined deck from lyrics, bible verses, and announcements together', async ({
  page,
}, testInfo) => {
  await page.goto('./');
  await uploadExamplePdf(page);

  await page.getByTestId('bible-verse-input').fill('요3:16');
  await expect(page.getByTestId('bible-verse-preview')).toContainText('요한복음 3:16');

  const announcementsText = await fs.readFile(ANNOUNCEMENTS_TEXT, 'utf-8');
  await page.getByTestId('announcement-input').fill(announcementsText);
  await expect(page.getByTestId('announcement-preview')).toContainText('새가족 환영');

  await expect(page.getByTestId('slide-count')).toContainText('말씀 1구절');
  await expect(page.getByTestId('slide-count')).toContainText('광고 5건');

  const dlPromise = page.waitForEvent('download');
  await page.getByTestId('generate-pptx').click();
  const download = await dlPromise;

  const zip = await loadPptx(download, testInfo.outputPath('combined.pptx'));
  const slides = slideFileNames(zip);
  // Fixed slides (front 4 + back 21 + prayer 2 + announcement title 1) + generated content.
  expect(slides.length).toBeGreaterThanOrEqual(28 + 5);

  const presentationXml = await zip.file('ppt/presentation.xml')!.async('string');
  expect((presentationXml.match(/<p:sldId /g) ?? []).length).toBe(slides.length);
  // Two slide masters: the service template's own, plus the lyrics/bible decks' merged-in ones.
  expect((presentationXml.match(/<p:sldMasterId /g) ?? []).length).toBeGreaterThanOrEqual(2);

  const allText = (await Promise.all(slides.map((f) => zip.file(f)!.async('string')))).join('\n');
  expect(allText).toContain('빛주사랑'); // fixed intro slide
  expect(allText).toContain('주님의 사랑'); // lyrics
  expect(allText).toContain('요한복음 3:16'); // bible verse
  expect(allText).toContain('새가족 환영'); // announcement item
  expect(allText).toContain('기도'); // fixed prayer slides
  expect(allText).toContain('공동체 고백송'); // mandatory back slides
});
