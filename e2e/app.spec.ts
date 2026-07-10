import { test, expect, type Page, type Download } from '@playwright/test';
import JSZip from 'jszip';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SAMPLE_PDF = path.join(HERE, '..', 'samples', 'conti-example.pdf');

// PDF parsing (pdf.js on scanned pages) can be slow, especially in CI.
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

test('loads the app shell', async ({ page }) => {
  await page.goto('./');
  await expect(page.getByText('찬양 가사 슬라이드 생성기').first()).toBeVisible();
  await expect(page.getByTestId('generate-pptx')).toBeVisible();
});

test('parses the example conti PDF and prefills songs', async ({ page }) => {
  await page.goto('./');
  await uploadExamplePdf(page);

  const contiInfo = page.getByTestId('conti-info');
  await expect(contiInfo).toContainText('하나님과 화평을 누리자', { timeout: PARSE_TIMEOUT });
  await expect(contiInfo).toContainText('7/11/26', { timeout: PARSE_TIMEOUT });

  // Cover lists 3 songs; a 4th stub may be created from the extra music page.
  const songCards = page.getByTestId('song-card');
  await expect
    .poll(async () => songCards.count(), { timeout: PARSE_TIMEOUT })
    .toBeGreaterThanOrEqual(3);

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
});

test('generates a valid pptx from the parsed conti', async ({ page }, testInfo) => {
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
  // Headless Chromium reports non-ASCII blob download names as the literal
  // fallback "download"; real browsers use the Korean file name.
  const suggested = download.suggestedFilename();
  expect(suggested).toMatch(/\.pptx$|^download$/);

  const zip = await loadPptx(download, testInfo.outputPath('conti.pptx'));

  expect(zip.file('ppt/presentation.xml')).not.toBeNull();
  expect(zip.file('[Content_Types].xml')).not.toBeNull();

  const slides = slideFileNames(zip);
  expect(slides.length).toBeGreaterThanOrEqual(10);

  const slide1 = await zip.file('ppt/slides/slide1.xml')!.async('string');
  expect(slide1).toContain('주님의 사랑');

  const presentationXml = await zip.file('ppt/presentation.xml')!.async('string');
  const sldIdCount = (presentationXml.match(/<p:sldId /g) ?? []).length;
  expect(sldIdCount).toBe(slides.length);

  const notesSlides = Object.keys(zip.files).filter((name) =>
    name.startsWith('ppt/notesSlides/'),
  );
  expect(notesSlides).toHaveLength(0);
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
