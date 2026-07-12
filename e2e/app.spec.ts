import { test, expect, type Page, type Download } from '@playwright/test';
import JSZip from 'jszip';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SAMPLE_PDF = path.join(HERE, '..', 'samples', 'conti-example.pdf');
const ANNOUNCEMENTS_TEXT = path.join(HERE, '..', 'tests', 'fixtures', 'announcements-sample.txt');
const LYRICS_TEMPLATE_PPTX = path.join(HERE, '..', 'public', 'template.pptx');

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

async function moveFromLyricsToDownload(page: Page): Promise<void> {
  await page.getByTestId('wizard-next-lyrics').click();
  await page.getByTestId('wizard-next-bible').click();
  await page.getByTestId('wizard-next-sermon').click();
  await page.getByTestId('wizard-next-announcement').click();
  await expect(page.getByTestId('wizard-panel-download')).toBeVisible();
}

async function moveFromBibleToDownload(page: Page): Promise<void> {
  await page.getByTestId('wizard-next-bible').click();
  await page.getByTestId('wizard-next-sermon').click();
  await page.getByTestId('wizard-next-announcement').click();
  await expect(page.getByTestId('wizard-panel-download')).toBeVisible();
}

test('moves through the five-step wizard with next and back buttons', async ({ page }) => {
  await page.goto('./');
  await expect(page.getByText('KCCP PPT Generator').first()).toBeVisible();
  await expect(page.getByTestId('wizard-panel-lyrics')).toBeVisible();
  await expect(page.getByTestId('wizard-panel-bible')).toBeHidden();
  await expect(page.getByTestId('pdf-input')).toBeAttached();

  await page.getByTestId('wizard-next-lyrics').click();
  await expect(page.getByTestId('wizard-panel-lyrics')).toBeHidden();
  await expect(page.getByTestId('wizard-panel-bible')).toBeVisible();
  await expect(page.getByTestId('bible-verse-input')).toBeVisible();

  await page.getByTestId('wizard-back-bible').click();
  await expect(page.getByTestId('wizard-panel-lyrics')).toBeVisible();
});

test('jumps directly between steps via the progress tabs', async ({ page }) => {
  await page.goto('./');
  await expect(page.getByTestId('wizard-panel-lyrics')).toBeVisible();

  // Jump forward several steps at once.
  await page.getByTestId('wizard-tab-download').click();
  await expect(page.getByTestId('wizard-panel-lyrics')).toBeHidden();
  await expect(page.getByTestId('wizard-panel-download')).toBeVisible();

  // Jump backwards to a middle step.
  await page.getByTestId('wizard-tab-bible').click();
  await expect(page.getByTestId('wizard-panel-download')).toBeHidden();
  await expect(page.getByTestId('wizard-panel-bible')).toBeVisible();

  // And back to the first step.
  await page.getByTestId('wizard-tab-lyrics').click();
  await expect(page.getByTestId('wizard-panel-lyrics')).toBeVisible();
});

test('admin panel replaces the front deck and restores the default', async ({ page }) => {
  await page.goto('./');
  await page.getByTestId('admin-open').click();
  await expect(page.getByTestId('admin-deck-status-front')).toContainText('기본 제공 파일 사용 중');

  // Any valid .pptx works as a replacement; the bundled lyrics template has 6 slides.
  await page.getByTestId('admin-deck-input-front').setInputFiles(LYRICS_TEMPLATE_PPTX);
  await expect(page.getByTestId('admin-deck-status-front')).toContainText('template.pptx');
  await expect(page.getByTestId('admin-deck-status-front')).toContainText('6장');

  // The replacement persists across a reload (IndexedDB).
  await page.reload();
  await page.getByTestId('admin-open').click();
  await expect(page.getByTestId('admin-deck-status-front')).toContainText('template.pptx');

  await page.getByTestId('admin-deck-front').getByRole('button', { name: '기본값 복원' }).click();
  await expect(page.getByTestId('admin-deck-status-front')).toContainText('기본 제공 파일 사용 중');
});

test('parses the example conti PDF and prefills songs', async ({ page }) => {
  await page.goto('./');
  await uploadExamplePdf(page);

  const contiInfo = page.getByTestId('conti-info');
  await expect(contiInfo).toContainText('하나님과 화평을 누리자', { timeout: PARSE_TIMEOUT });
  await expect(contiInfo).toContainText('7/11/26', { timeout: PARSE_TIMEOUT });

  // Every cover song is included — only Celebrate the Light (the 공동체
  // 고백송, supplied by the back slides) would be excluded, and this conti
  // doesn't list it. The 입례 song stays in.
  const songCards = page.getByTestId('song-card');
  await expect
    .poll(async () => songCards.count(), { timeout: PARSE_TIMEOUT })
    .toBeGreaterThanOrEqual(3);

  const titles = await songCards
    .getByTestId('song-title-input')
    .evaluateAll((inputs) => inputs.map((input) => (input as unknown as { value: string }).value));
  expect(titles).toContain('입례');
  expect(titles).not.toContain('Celebrate the Light');

  const firstCard = songCards.first();
  await expect(firstCard.getByTestId('song-title-input')).toHaveValue('주님의 사랑', {
    timeout: PARSE_TIMEOUT,
  });
  await expect(firstCard.getByTestId('order-input')).not.toHaveValue('', {
    timeout: PARSE_TIMEOUT,
  });

  await page.getByTestId('wizard-next-lyrics').click();
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

  await moveFromLyricsToDownload(page);
  await expect(page.getByTestId('slide-count')).toContainText(/총 \d+장/, {
    timeout: PARSE_TIMEOUT,
  });

  const dlPromise = page.waitForEvent('download');
  await page.getByTestId('generate-pptx').click();
  const download = await dlPromise;

  // The Saturday conti date is named after that week's Sunday.
  await expect(page.getByTestId('filename-input')).toHaveValue('0712.pptx');
  expect(download.suggestedFilename()).toBe('0712.pptx');

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

  const librarySearch = page.getByTestId('library-add-search');
  await expect(librarySearch).toBeVisible();
  await librarySearch.click();
  // The library loads asynchronously; wait until real options exist beyond a placeholder.
  const options = page.getByTestId('library-add-option');
  await expect(options.first()).toBeAttached({ timeout: PARSE_TIMEOUT });

  await librarySearch.fill('주님의 사랑');
  const match = options.filter({ hasText: '주님의 사랑' });
  if (await match.count()) {
    await match.first().click();
  } else {
    await librarySearch.fill('');
    await options.first().click();
  }

  const songCards = page.getByTestId('song-card');
  await expect(songCards).toHaveCount(1, { timeout: PARSE_TIMEOUT });
  await expect(songCards.first().getByTestId('song-title-input')).not.toHaveValue('');

  await moveFromLyricsToDownload(page);
  const dlPromise = page.waitForEvent('download');
  await page.getByTestId('generate-pptx').click();
  const download = await dlPromise;

  const zip = await loadPptx(download, testInfo.outputPath('manual.pptx'));
  expect(slideFileNames(zip).length).toBeGreaterThanOrEqual(2);
});

test('generates a bible verse slide deck alone', async ({ page }, testInfo) => {
  await page.goto('./');

  await page.getByTestId('wizard-next-lyrics').click();
  await page.getByTestId('bible-verse-input').fill('요3:16');
  await expect(page.getByTestId('bible-verse-preview')).toContainText('요한복음 3:16');

  await moveFromBibleToDownload(page);
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

  await page.getByTestId('wizard-next-lyrics').click();
  await page.getByTestId('bible-verse-input').fill('요3:16');
  await expect(page.getByTestId('bible-verse-preview')).toContainText('요한복음 3:16');

  await page.getByTestId('wizard-next-bible').click();
  await page.getByTestId('wizard-next-sermon').click();
  const announcementsText = await fs.readFile(ANNOUNCEMENTS_TEXT, 'utf-8');
  await page.getByTestId('announcement-input').fill(announcementsText);
  await expect(page.getByTestId('announcement-preview')).toContainText('새가족 환영');

  await page.getByTestId('wizard-next-announcement').click();
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
