import { test, expect, type Page, type Download } from '@playwright/test';
import JSZip from 'jszip';
import { RECOGNITION_MODEL_CATALOG } from '../src/lib/ai/aiSettings';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SAMPLE_PDF = path.join(HERE, '..', 'samples', 'conti-example.pdf');
const ANNOUNCEMENTS_TEXT = path.join(HERE, '..', 'tests', 'fixtures', 'announcements-sample.txt');
const LYRICS_TEMPLATE_PPTX = path.join(HERE, '..', 'public', 'template.pptx');
const SERMON_PPTX = path.join(HERE, '..', 'public', 'bible-template.pptx');
const PLACEHOLDER_FRONT_PPTX = path.join(HERE, '..', 'tests', 'fixtures', 'placeholder-front-slide.pptx');
// PDF parsing (pdf.js on scanned pages) and fetching translation JSON can be
// slow, especially in CI.
const PARSE_TIMEOUT = 30_000;
// Auto-save waits out its debounce and then rebuilds the whole deck.
const AUTO_SAVE_TIMEOUT = 60_000;

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

async function masterAndLayoutIds(zip: JSZip): Promise<string[]> {
  const presentation = await zip.file('ppt/presentation.xml')!.async('string');
  const ids = [...presentation.matchAll(/<p:sldMasterId\b[^>]*\sid="([^"]+)"/g)].map(
    (match) => match[1],
  );
  for (const name of Object.keys(zip.files).filter((path) => /^ppt\/slideMasters\/[^/]+\.xml$/.test(path))) {
    const master = await zip.file(name)!.async('string');
    ids.push(...[...master.matchAll(/<p:sldLayoutId\b[^>]*\sid="([^"]+)"/g)].map((match) => match[1]));
  }
  return ids;
}

async function makeImageFixtures(page: Page): Promise<{ png: Buffer; jpeg: Buffer }> {
  const fixtures = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 8;
    canvas.height = 8;
    const context = canvas.getContext('2d')!;
    context.fillStyle = '#496554';
    context.fillRect(0, 0, canvas.width, canvas.height);
    return {
      png: canvas.toDataURL('image/png').split(',')[1],
      jpeg: canvas.toDataURL('image/jpeg', 0.9).split(',')[1],
    };
  });
  return {
    png: Buffer.from(fixtures.png, 'base64'),
    jpeg: Buffer.from(fixtures.jpeg, 'base64'),
  };
}

async function moveFromLyricsToDownload(page: Page): Promise<void> {
  await page.getByTestId('wizard-next-lyrics').click();
  await page.getByTestId('wizard-next-bible').click();
  await page.getByTestId('wizard-next-sermon').click();
  await page.getByTestId('wizard-next-announcement').click();
  await page.getByTestId('wizard-next-additional').click();
  await expect(page.getByTestId('wizard-panel-download')).toBeVisible();
}

async function moveFromBibleToDownload(page: Page): Promise<void> {
  await page.getByTestId('wizard-next-bible').click();
  await page.getByTestId('wizard-next-sermon').click();
  await page.getByTestId('wizard-next-announcement').click();
  await page.getByTestId('wizard-next-additional').click();
  await expect(page.getByTestId('wizard-panel-download')).toBeVisible();
}

// --- Shared recognition proxy stubs ------------------------------------------
//
// The bundle is built with a proxy URL pointing back at the preview server, so
// every recognition, web-lyrics and learning call is interceptable here. All
// lyric text below is invented: no real 악보 or published lyrics belong in a
// fixture.

const PROXY = '**/ppt/__proxy';

/** A page of made-up lyrics in the shape the models are asked to answer with. */
function stubScore(overrides: Record<string, unknown> = {}) {
  return {
    pageType: 'score',
    sermonTitle: '',
    scripture: '',
    title: '가나다라 마바사',
    artist: '',
    key: 'E',
    order: ['I', 'V', 'C'],
    lyricRowCount: 1,
    sections: [
      { label: 'V', lines: ['가나다라 마바사 아자차', '카타파하 그 이름 높이'] },
      { label: 'C', lines: ['높이 높이 노래해', '영원토록 노래해'] },
    ],
    ...overrides,
  };
}

interface ProxyStubs {
  /** Answer every model with this, indexed by image position. */
  score?: (imageIndex: number) => Record<string, unknown>;
  /** Body for GET /lyrics. Omit for "the web found nothing". */
  lyrics?: Record<string, unknown>;
  /** Rows for GET /learning/models. */
  models?: Record<string, unknown>[];
}

/** Count of requests each proxy route received, for asserting what ran. */
interface ProxyCounts {
  gemini: number;
  openrouter: number;
  lyrics: number;
}

async function stubRecognitionProxy(page: Page, stubs: ProxyStubs = {}): Promise<ProxyCounts> {
  const counts: ProxyCounts = { gemini: 0, openrouter: 0, lyrics: 0 };
  const score = stubs.score ?? (() => stubScore());

  const batchBody = (imageCount: number) =>
    JSON.stringify({
      results: Array.from({ length: imageCount }, (_, imageIndex) => ({ imageIndex, ...score(imageIndex) })),
    });

  // The bundled starter library already holds the sample conti's songs, and a
  // saved song skips recognition entirely. Emptying it is what makes these
  // tests exercise the recognition path at all.
  await page.route('**/ppt/library.json', (route) => route.fulfill({ json: [] }));
  await page.route(`${PROXY}/settings`, (route) => route.fulfill({ json: {} }));
  await page.route(`${PROXY}/learning/models`, (route) =>
    route.fulfill({ json: { models: stubs.models ?? [] } }),
  );

  await page.route(`${PROXY}/gemini/**`, async (route) => {
    counts.gemini += 1;
    const payload = route.request().postDataJSON() as { contents?: { parts?: unknown[] }[] };
    const images = (payload.contents?.[0]?.parts ?? []).filter(
      (part) => !!(part as { inlineData?: unknown }).inlineData,
    ).length;
    await route.fulfill({
      json: { candidates: [{ content: { parts: [{ text: batchBody(Math.max(1, images)) }] } }] },
    });
  });

  await page.route(`${PROXY}/openrouter`, async (route) => {
    counts.openrouter += 1;
    const payload = route.request().postDataJSON() as { messages?: { content?: unknown[] }[] };
    const images = (payload.messages?.[0]?.content ?? []).filter(
      (part) => (part as { type?: string }).type === 'image_url',
    ).length;
    await route.fulfill({
      json: { choices: [{ message: { content: batchBody(Math.max(1, images)) } }] },
    });
  });

  await page.route(`${PROXY}/lyrics*`, async (route) => {
    counts.lyrics += 1;
    await route.fulfill({ json: stubs.lyrics ?? { candidates: [], links: [] } });
  });

  return counts;
}

/** A scored web candidate as the proxy would return it. */
function webCandidate(overrides: Record<string, unknown> = {}) {
  return {
    id: 'ccm:ccm.co.kr/song/1',
    title: '가나다라 마바사',
    artist: '어느 사역팀',
    lines: ['가나다라 마바사 아자차', '카타파하 그 이름 높이', '높이 높이 노래해', '영원토록 노래해'],
    url: 'https://ccm.co.kr/song/1',
    host: 'ccm.co.kr',
    source: 'ccm',
    sourceTrust: 0.9,
    score: 0.72,
    titleScore: 1,
    artistScore: 0,
    lyricsScore: 0.6,
    decision: 'review',
    ...overrides,
  };
}

/** Unlock 관리자 설정 and leave the panel open. */
async function unlockAdmin(page: Page): Promise<void> {
  await page.getByTestId('admin-open').click();
  await page.getByTestId('admin-password').fill('kccpmedia1980');
  await page.getByTestId('admin-unlock').click();
}

/**
 * Let a shared-library delete succeed.
 *
 * The e2e bundle is built with a proxy URL, so deleting a saved deck now also
 * asks the shared server to drop it — and refuses to delete the local copy if
 * that call fails, rather than resurrecting the deck on the next sync. Tests
 * that delete therefore have to answer that one call. Everything else is left
 * unrouted and 404s, which every caller already falls back from.
 */
async function allowSharedLibraryDeletes(page: Page): Promise<void> {
  await page.route(`${PROXY}/libraries/ppt/*`, async (route) => {
    if (route.request().method() !== 'DELETE') return route.fallback();
    await route.fulfill({ json: { ok: true } });
  });
}

/**
 * Recognize the first song and wait for the whole staged flow to settle.
 *
 * Automatic recognition is deliberately skipped under browser automation, so
 * the tests press the same button a user would.
 */
async function recognizeFirstSong(page: Page) {
  const card = page.getByTestId('song-card').first();
  await expect(card).toBeVisible({ timeout: PARSE_TIMEOUT });
  await card.getByTestId('recognize-btn').click();
  await expect(card.getByTestId('recog-running')).toHaveCount(0, { timeout: PARSE_TIMEOUT });
  await expect(card.getByTestId('recog-done').or(card.locator('.recog-error'))).toBeVisible({
    timeout: PARSE_TIMEOUT,
  });
  return card;
}

test('moves through the six-step wizard with next and back buttons', async ({ page }) => {
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

test('adds, reorders, and removes files on the new 추가 자료 page', async ({ page }) => {
  await page.goto('./');
  await page.getByTestId('wizard-tab-additional').click();
  await expect(page.getByTestId('additional-files-section')).toBeVisible();

  const fixtureImages = await makeImageFixtures(page);

  await page.getByTestId('additional-files-input').setInputFiles([
    { name: 'first.png', mimeType: 'image/png', buffer: fixtureImages.png },
    { name: 'second.jpg', mimeType: 'image/jpeg', buffer: fixtureImages.jpeg },
  ]);
  const rows = page.getByTestId('additional-file-row');
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText('first.png');
  await expect(rows.nth(1)).toContainText('second.jpg');

  await rows.nth(1).getByTestId('additional-file-up').click();
  await expect(rows.nth(0)).toContainText('second.jpg');
  await rows.nth(0).getByTestId('additional-file-delete').click();
  await expect(rows).toHaveCount(1);
  await expect(rows.nth(0)).toContainText('first.png');
});

test('appends image and PPTX uploads after the final Back/End slide in chosen order', async ({
  page,
}, testInfo) => {
  await page.goto('./');
  await page.getByTestId('wizard-tab-additional').click();
  const fixtureImages = await makeImageFixtures(page);
  await page.getByTestId('additional-files-input').setInputFiles([
    { name: 'post-end.png', mimeType: 'image/png', buffer: fixtureImages.png },
    {
      name: 'post-end.pptx',
      mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      buffer: await fs.readFile(LYRICS_TEMPLATE_PPTX),
    },
  ]);
  await expect(page.getByTestId('additional-file-row')).toHaveCount(2);
  await page.getByTestId('wizard-next-additional').click();

  const downloadPromise = page.waitForEvent('download');
  await page.getByTestId('generate-pptx').click();
  const zip = await loadPptx(await downloadPromise, testInfo.outputPath('post-end-order.pptx'));

  expect(slideFileNames(zip)).toHaveLength(34);
  expect(await zip.file('ppt/slides/slide28.xml')!.async('string')).toContain('<p:pic>');
  expect(await zip.file('ppt/slides/slide29.xml')!.async('string')).toContain('주님의 사랑');
});

test('editor view shows slides and all five content editors together', async ({ page }) => {
  await page.goto('./');
  await uploadExamplePdf(page);

  // Type an announcement before switching views, so both editors have content.
  await page.getByTestId('wizard-tab-announcement').click();
  await page.getByTestId('announcement-input').fill('1. <새가족 환영>\n오늘 처음 오신 분들을 환영합니다!');
  await expect(page.getByTestId('announcement-preview')).toBeVisible();

  await page.getByTestId('view-mode-toggle').click();
  await expect(page.getByTestId('slide-overview')).toBeVisible();
  // The step tabs and per-step next/back navigation make no sense in this view.
  await expect(page.getByTestId('wizard-tab-lyrics')).toHaveCount(0);

  // The left panel debounces, then rebuilds the full deck and renders the
  // real production slides (not a text summary) — wait for that to settle.
  await expect(page.getByTestId('slide-overview-loading')).toHaveCount(0, { timeout: PARSE_TIMEOUT });

  // 찬양 가사 AND 광고 are both reachable in the same right-hand column —
  // the SAME LyricsGenerator/AnnouncementSection instances the wizard uses,
  // not a duplicate, so nothing the user already typed is lost.
  await expect(page.getByTestId('wizard-panel-lyrics')).toBeVisible();
  await expect(page.getByTestId('song-card').first()).toBeVisible();
  // 성경 말씀 (설교 제목 및 본문) is reachable too, auto-filled from the conti.
  await expect(page.getByTestId('wizard-panel-bible')).toBeVisible();
  await expect(page.getByTestId('bible-verse-input')).not.toHaveValue('');
  // 설교 PPT 업로드 is reachable too — the same SermonUploadSection instance
  // the wizard uses, not a duplicate.
  await expect(page.getByTestId('wizard-panel-sermon')).toBeVisible();
  await expect(page.getByTestId('sermon-upload-section')).toBeVisible();
  await expect(page.getByTestId('wizard-panel-announcement')).toBeVisible();
  await expect(page.getByTestId('announcement-input')).toHaveValue(/새가족 환영/);
  await expect(page.getByTestId('wizard-panel-additional')).toBeVisible();
  await expect(page.getByTestId('additional-files-section')).toBeVisible();

  // Uploaded/typed content survives the switch (no remount, no data loss).
  await expect(page.getByTestId('conti-info')).toBeVisible();

  // The left slide list mirrors the real deck order, one row per actual
  // rendered slide (front slides now expand to one row each, not a summary),
  // and each row shows the real slide's shapes/text — not a placeholder.
  const firstFrontThumb = page.getByTestId('slide-overview-row-front').first().locator('.slide-thumb');
  await expect(firstFrontThumb).toBeVisible();
  await expect(firstFrontThumb.locator('.slide-thumb-text, .slide-thumb-picture').first()).toBeAttached();
  await expect(page.getByTestId('slide-overview-row-announcement')).toContainText('새가족 환영');

  // Several of the bundled Back slides carry no picture/background of their
  // own — only the slide layout does (a corner logo) — so every Back row's
  // thumbnail must inherit it, not just the ones with an explicit picture.
  const backRows = page.getByTestId('slide-overview-row-back');
  const backRowCount = await backRows.count();
  expect(backRowCount).toBeGreaterThan(0);
  for (let i = 0; i < backRowCount; i++) {
    await expect(backRows.nth(i).locator('.slide-thumb-picture').first()).toBeAttached();
  }

  // Clicking an announcement row focuses the shared textarea.
  await page.getByTestId('slide-overview-row-announcement').getByRole('button').click();
  await expect(page.getByTestId('announcement-input')).toBeFocused();

  // Clicking a 말씀 row focuses the 성경 구절 input in the same right-hand column.
  await page.getByTestId('slide-overview-row-bible').first().getByRole('button').click();
  await expect(page.getByTestId('bible-verse-input')).toBeFocused();

  // 설교 PPT can be uploaded directly from 편집기, without switching back to
  // the wizard, and the slide list picks it up like any other section.
  await page.getByTestId('sermon-input').setInputFiles(SERMON_PPTX);
  await expect(page.getByText('업로드됨: bible-template.pptx')).toBeVisible();
  await expect(page.getByTestId('slide-overview-loading')).toHaveCount(0, { timeout: PARSE_TIMEOUT });
  await expect(page.getByTestId('slide-overview-row-sermon').first()).toBeVisible();

  // Clicking a 설교 row scrolls the sermon upload section into view.
  await page.getByTestId('slide-overview-row-sermon').first().getByRole('button').click();
  await expect(page.getByTestId('sermon-upload-section')).toBeInViewport();

  // The whole deck can be downloaded or saved to the 라이브러리 without leaving
  // 편집기 — a toolbar next to the slide list, not just the wizard's last step.
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByTestId('editor-generate-pptx').click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/\.pptx$/);

  await page.getByTestId('editor-save-to-library').click();
  await expect(page.getByText(/라이브러리에 저장했습니다/)).toBeVisible({ timeout: PARSE_TIMEOUT });

  // Switching back to 단계별 보기 restores the normal wizard (still the same
  // underlying state — the song list and announcement text are untouched).
  await page.getByTestId('view-mode-toggle').click();
  await expect(page.getByTestId('slide-overview')).toHaveCount(0);
  await expect(page.getByTestId('wizard-tab-lyrics')).toBeVisible();
});

test('editor view keeps balanced gutters and stacks before the editing column gets cramped', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('./');
  await page.getByTestId('view-mode-toggle').click();

  const wide = await page.evaluate(() => {
    const app = document.querySelector<HTMLElement>('.app')!.getBoundingClientRect();
    const header = document.querySelector<HTMLElement>('.header-inner')!.getBoundingClientRect();
    const overview = document.querySelector<HTMLElement>('.slide-overview')!.getBoundingClientRect();
    const main = document.querySelector<HTMLElement>('#main-content')!.getBoundingClientRect();
    return {
      appLeft: app.left,
      appRight: app.right,
      headerLeft: header.left,
      headerRight: header.right,
      overviewWidth: overview.width,
      mainWidth: main.width,
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  });
  expect(Math.abs(wide.appLeft - wide.headerLeft)).toBeLessThan(1);
  expect(Math.abs(wide.appRight - wide.headerRight)).toBeLessThan(1);
  expect(wide.overviewWidth).toBe(312);
  expect(wide.mainWidth).toBeGreaterThanOrEqual(900);
  expect(wide.overflow).toBe(0);

  await page.setViewportSize({ width: 1100, height: 900 });
  const compact = await page.evaluate(() => {
    const overview = document.querySelector<HTMLElement>('.slide-overview')!.getBoundingClientRect();
    const main = document.querySelector<HTMLElement>('#main-content')!.getBoundingClientRect();
    return { overviewLeft: overview.left, mainLeft: main.left, overviewBottom: overview.bottom, mainTop: main.top, mainWidth: main.width };
  });
  expect(Math.abs(compact.overviewLeft - compact.mainLeft)).toBeLessThan(1);
  expect(compact.mainTop).toBeGreaterThanOrEqual(compact.overviewBottom);
  expect(compact.mainWidth).toBeGreaterThan(900);
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

  // Password-gated: a wrong password is rejected, the right one unlocks.
  await page.getByTestId('admin-password').fill('wrong-password');
  await page.getByTestId('admin-unlock').click();
  await expect(page.getByTestId('admin-password-error')).toBeVisible();
  await page.getByTestId('admin-password').fill('kccpmedia1980');
  await page.getByTestId('admin-unlock').click();

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

test('a real PowerPoint deck\'s placeholder text inherits position/size/font from its layout and master', async ({
  page,
}) => {
  await page.goto('./');
  await page.getByTestId('admin-open').click();
  await page.getByTestId('admin-password').fill('kccpmedia1980');
  await page.getByTestId('admin-unlock').click();
  // This fixture's only slide is a title placeholder with NO position, size,
  // or font of its own — exactly how a real PowerPoint deck (unlike this
  // app's own Google-Slides-exported templates, which bake those onto every
  // shape) authors a title. It must inherit position/size from its layout
  // and font size from its master, not render missing or mispositioned.
  await page.getByTestId('admin-deck-input-front').setInputFiles(PLACEHOLDER_FRONT_PPTX);
  await expect(page.getByTestId('admin-deck-status-front')).toContainText('placeholder-front-slide.pptx');
  await page.getByRole('dialog').getByRole('button', { name: '닫기' }).click();

  await page.getByTestId('wizard-tab-announcement').click();
  await page.getByTestId('announcement-input').fill('1. <공지>\n안내 문구');
  await page.getByTestId('view-mode-toggle').click();
  await expect(page.getByTestId('slide-overview-loading')).toHaveCount(0, { timeout: PARSE_TIMEOUT });

  const titleShape = page.getByTestId('slide-overview-row-front').first().locator('.slide-thumb-text');
  await expect(titleShape).toContainText('플레이스홀더 제목');
  const width = await titleShape.evaluate((el) => parseFloat((el as any).style.width));
  // The layout's own xfrm (7772400 EMU wide) at the 248px-wide thumbnail
  // scale is ~211px — distinct from the master's differing xfrm (~223px)
  // and from a missing/0-width box, so this pins down which part the box
  // actually came from rather than just "some" box happening to be non-zero.
  expect(width).toBeGreaterThan(205);
  expect(width).toBeLessThan(217);
  const fontSize = await titleShape
    .locator('.slide-thumb-run')
    .first()
    .evaluate((el) => parseFloat((el as any).style.fontSize));
  // The master's titleStyle default (44pt) at thumbnail scale is ~15px —
  // distinct from the 18pt no-inheritance-found fallback (~6px).
  expect(fontSize).toBeGreaterThan(12);
  expect(fontSize).toBeLessThan(18);

  // Leave the app in its default state for later tests.
  await page.getByTestId('view-mode-toggle').click();
  await page.getByTestId('admin-open').click();
  await page.getByTestId('admin-deck-front').getByRole('button', { name: '기본값 복원' }).click();
  await expect(page.getByTestId('admin-deck-status-front')).toContainText('기본 제공 파일 사용 중');
});

test('PPT library saves a generated deck with its source files and can re-download or delete it later', async ({
  page,
}) => {
  await allowSharedLibraryDeletes(page);
  await page.goto('./');
  // Check the library is empty before there is anything to auto-save.
  await page.getByTestId('library-open').click();
  await expect(page.getByTestId('library-empty')).toBeVisible();
  await page.getByRole('dialog').getByRole('button', { name: '닫기' }).click();

  await uploadExamplePdf(page);

  await page.getByTestId('wizard-tab-download').click();
  await page.getByTestId('save-to-library').click();
  await expect(page.getByText(/라이브러리에 저장했습니다/)).toBeVisible();

  await page.getByTestId('library-open').click();
  const entry = page.getByTestId('library-entry');
  await expect(entry).toBeVisible();
  await expect(entry).toContainText('.pptx');
  await expect(entry).toContainText('장'); // slide count
  await expect(entry).toContainText('주님의 사랑'); // song title summary

  // Both the merged deck and the original conti PDF can be pulled back down.
  const [pptxDownload] = await Promise.all([
    page.waitForEvent('download'),
    entry.getByRole('button', { name: 'PPTX 다운로드' }).click(),
  ]);
  expect(pptxDownload.suggestedFilename()).toMatch(/\.pptx$/);
  const [pdfDownload] = await Promise.all([
    page.waitForEvent('download'),
    entry.getByRole('button', { name: '콘티 PDF' }).click(),
  ]);
  expect(pdfDownload.suggestedFilename()).toMatch(/\.pdf$/);

  // The entry survives a reload — it's real IndexedDB, not in-memory state.
  await page.reload();
  await page.getByTestId('library-open').click();
  await expect(page.getByTestId('library-entry')).toBeVisible();

  page.once('dialog', (dialog) => dialog.accept());
  await page.getByTestId('library-entry-delete').click();
  await expect(page.getByTestId('library-empty')).toBeVisible();
});

test('saving the same file name twice overwrites the library entry instead of adding a copy', async ({ page }) => {
  await page.goto('./');
  await uploadExamplePdf(page);
  await moveFromLyricsToDownload(page);

  // The file name comes from the conti date, so a second save reuses it.
  await page.getByTestId('save-to-library').click();
  await expect(page.getByText(/라이브러리에 저장했습니다/)).toBeVisible();

  await page.getByTestId('library-open').click();
  const savedName = (await page.getByTestId('library-entry').locator('.library-entry-name').innerText()).trim();
  await page.getByRole('dialog').getByRole('button', { name: '닫기' }).click();

  await page.getByTestId('save-to-library').click();
  await expect(page.getByText(/같은 이름의 기존 PPT를 덮어쓰고/)).toBeVisible();

  await page.getByTestId('library-open').click();
  await expect(page.getByTestId('library-entry')).toHaveCount(1);
  await expect(page.getByTestId('library-entry')).toContainText(savedName);

  // Still one entry after a reload — the first copy was replaced in storage,
  // not just hidden from the list.
  await page.reload();
  await page.getByTestId('library-open').click();
  await expect(page.getByTestId('library-entry')).toHaveCount(1);
});

test('every edit auto-saves into the library, always updating the same entry', async ({ page }) => {
  // Each auto-save rebuilds and stores the whole deck, and this test waits
  // through several of them.
  test.slow();
  await page.goto('./');
  await uploadExamplePdf(page);

  // No save button is ever pressed here: parsing the conti is itself an edit,
  // so the deck lands in the library on its own.
  const status = page.getByTestId('auto-save-status');
  await expect(status).toHaveAttribute('data-state', 'saved', { timeout: AUTO_SAVE_TIMEOUT });

  await page.getByTestId('library-open').click();
  const entry = page.getByTestId('library-entry');
  await expect(entry).toHaveCount(1);
  const savedName = (await entry.locator('.library-entry-name').innerText()).trim();
  await page.getByRole('dialog').getByRole('button', { name: '닫기' }).click();

  // A later edit updates that same entry rather than adding one per edit.
  await page.getByTestId('wizard-tab-announcement').click();
  await page.getByTestId('announcement-input').fill('1. <자동 저장 광고>\n자동으로 저장된 내용입니다.');
  await expect(status).toHaveAttribute('data-state', 'pending');
  await expect(status).toHaveAttribute('data-state', 'saved', { timeout: AUTO_SAVE_TIMEOUT });

  await page.getByTestId('library-open').click();
  await expect(page.getByTestId('library-entry')).toHaveCount(1);
  await expect(page.getByTestId('library-entry')).toContainText(savedName);
  await page.getByRole('dialog').getByRole('button', { name: '닫기' }).click();

  // The auto-saved entry is real storage, and reopening it restores the edit —
  // and stays idle, because re-saving the inputs it just restored is not an edit.
  await page.reload();
  await page.getByTestId('library-open').click();
  await page.getByTestId('library-entry').getByTestId('library-entry-edit').click();
  await expect(page.getByRole('dialog')).toHaveCount(0, { timeout: PARSE_TIMEOUT });
  await page.getByTestId('wizard-tab-announcement').click();
  await expect(page.getByTestId('announcement-input')).toHaveValue(/자동 저장 광고/);
  await expect(status).toHaveAttribute('data-state', 'idle', { timeout: AUTO_SAVE_TIMEOUT });

  await page.getByTestId('library-open').click();
  await expect(page.getByTestId('library-entry')).toHaveCount(1);
});

test('library 편집 reopens a saved deck in the six-step wizard and re-saves over the same entry', async ({ page }) => {
  await page.goto('./');
  await uploadExamplePdf(page);
  const savedSongTitle = await page
    .getByTestId('song-card')
    .first()
    .getByTestId('song-title-input')
    .inputValue();

  await page.getByTestId('wizard-next-lyrics').click();
  await page.getByTestId('bible-verse-input').fill('요3:16');
  await page.getByTestId('wizard-next-bible').click();
  await page.getByTestId('wizard-next-sermon').click();
  await page.getByTestId('announcement-input').fill('1. <저장 전 광고>\n첫 번째 내용입니다.');
  await page.getByTestId('wizard-next-announcement').click();
  const fixtureImages = await makeImageFixtures(page);
  await page.getByTestId('additional-files-input').setInputFiles({
    name: '복원할-추가자료.png',
    mimeType: 'image/png',
    buffer: fixtureImages.png,
  });
  await expect(page.getByTestId('additional-file-row')).toHaveCount(1);
  await page.getByTestId('wizard-next-additional').click();

  await page.getByTestId('save-to-library').click();
  // Building the deck loads translation data and re-zips every piece.
  await expect(page.getByText(/라이브러리에 저장했습니다/)).toBeVisible({ timeout: PARSE_TIMEOUT });

  // Reload first, so what comes back is read from storage rather than state
  // the wizard still happens to be holding.
  await page.reload();
  await expect(page.getByTestId('announcement-input')).toHaveValue('');

  await page.getByTestId('library-open').click();
  const entry = page.getByTestId('library-entry');
  const savedName = (await entry.locator('.library-entry-name').innerText()).trim();
  expect(savedName).toMatch(/\.pptx$/);
  await entry.getByTestId('library-entry-edit').click();

  // The library modal gives way to the wizard, back on its first step, with
  // every input restored — no slide list, no second editor.
  await expect(page.getByRole('dialog')).toHaveCount(0, { timeout: PARSE_TIMEOUT });
  await expect(page.getByTestId('wizard-panel-lyrics')).toBeVisible();
  await expect(page.getByTestId('song-card').first().getByTestId('song-title-input')).toHaveValue(
    savedSongTitle,
  );

  await page.getByTestId('wizard-tab-bible').click();
  await expect(page.getByTestId('bible-verse-input')).toHaveValue('요3:16');
  await page.getByTestId('wizard-tab-announcement').click();
  await expect(page.getByTestId('announcement-input')).toHaveValue(/저장 전 광고/);
  await page.getByTestId('wizard-tab-additional').click();
  await expect(page.getByTestId('additional-file-row')).toContainText('복원할-추가자료.png');

  await page.getByTestId('wizard-tab-download').click();
  await expect(page.getByTestId('editing-deck-banner')).toContainText(savedName);
  await expect(page.getByTestId('filename-input')).toHaveValue(savedName);

  // Editing and saving updates the entry that was opened instead of adding one.
  await page.getByTestId('wizard-tab-announcement').click();
  await page.getByTestId('announcement-input').fill('1. <수정된 광고>\n두 번째 내용입니다.');
  await page.getByTestId('wizard-tab-download').click();
  await page.getByTestId('save-to-library').click();
  await expect(page.getByText(/수정했습니다/)).toBeVisible({ timeout: PARSE_TIMEOUT });

  await page.getByTestId('library-open').click();
  await expect(page.getByTestId('library-entry')).toHaveCount(1);

  // And the edit is what a second 편집 brings back.
  await page.getByTestId('library-entry').getByTestId('library-entry-edit').click();
  await expect(page.getByRole('dialog')).toHaveCount(0, { timeout: PARSE_TIMEOUT });
  await page.getByTestId('wizard-tab-announcement').click();
  await expect(page.getByTestId('announcement-input')).toHaveValue(/수정된 광고/);
});

test('admin panel lists the complete concurrent recognition model pool', async ({ page }) => {
  await page.goto('./');
  await page.getByTestId('admin-open').click();
  await page.getByTestId('admin-password').fill('kccpmedia1980');
  await page.getByTestId('admin-unlock').click();

  const rows = page.getByTestId('admin-recognition-order').locator('.admin-engine');
  await expect(page.getByRole('heading', { name: '가사 인식 동시 실행 모델' })).toBeVisible();
  // The two primary models lead the priority-ordered list; everything after
  // is an assistant model. Both the labels and the leading pair come from the
  // catalog, so changing the pool does not mean editing hard-coded names here.
  await expect(rows).toHaveCount(RECOGNITION_MODEL_CATALOG.length);
  await expect(rows).toContainText(RECOGNITION_MODEL_CATALOG.map((entry) => entry.label));
  await expect(rows.first()).toContainText(RECOGNITION_MODEL_CATALOG[0].label);
  await expect(rows.nth(1)).toContainText(RECOGNITION_MODEL_CATALOG[1].label);
  await expect(page.getByTestId('admin-recognition-order').getByRole('button')).toHaveCount(0);
});

test('admin panel edits the excluded-title list and persists it', async ({ page }) => {
  await page.goto('./');
  await page.getByTestId('admin-open').click();
  await page.getByTestId('admin-password').fill('kccpmedia1980');
  await page.getByTestId('admin-unlock').click();

  const textarea = page.getByTestId('admin-excluded-titles');
  await expect(textarea).toHaveValue(/공동체 고백송/);
  await textarea.fill('공동체 고백송\n예배 전 준비 찬양\n파송의 노래');
  await page.getByTestId('admin-excluded-save').click();

  await page.reload();
  await page.getByTestId('admin-open').click();
  await expect(page.getByTestId('admin-excluded-titles')).toHaveValue(/파송의 노래/);
});

test('usage page shows AI usage next to the admin button', async ({ page }) => {
  await page.goto('./');
  await page.getByTestId('usage-open').click();
  await expect(page.getByTestId('admin-ai-usage')).toBeVisible();
});

test('score click opens the split view: whole conti left, lyric editor right', async ({ page }) => {
  await page.goto('./');
  await uploadExamplePdf(page);

  // Wait for a score preview to render, then click it.
  const firstScoreImg = page.locator('.score-pane img').first();
  await expect(firstScoreImg).toBeVisible({ timeout: PARSE_TIMEOUT });
  await firstScoreImg.click();

  await expect(page.getByTestId('split-view')).toBeVisible();
  // The left pane lists every PDF page (the sample conti has 6), not just one.
  await expect
    .poll(async () => page.locator('.split-page').count(), { timeout: PARSE_TIMEOUT })
    .toBeGreaterThan(1);
  await expect(page.locator('.split-page-active')).toHaveCount(1);

  // The right pane is the clicked song's editor; edits persist to the list.
  const editor = page.getByTestId('split-view-editor').getByTestId('song-card-editor');
  await expect(editor).toBeVisible();
  // Recognition can be triggered and monitored from inside the split view.
  await expect(editor.getByTestId('recognize-btn')).toBeVisible();
  if ((await editor.getByTestId('section-textarea').count()) === 0) {
    await editor.getByRole('button', { name: 'V', exact: true }).click();
  }
  const textarea = editor.getByTestId('section-textarea').first();
  // 4 lines fit one slide at the default 4 lines/slide, so the blank line is
  // what forces the 2-slide split.
  await textarea.fill('첫 줄\n둘째 줄\n\n셋째 줄\n넷째 줄');
  const editedSlides = editor.locator('.mini-slide.lyrics').filter({ hasText: /(첫|둘째|셋째|넷째) 줄/ });
  await expect(editedSlides).toHaveCount(2);
  await expect(editedSlides.nth(0)).toContainText('둘째 줄');
  await expect(editedSlides.nth(0)).not.toContainText('셋째 줄');
  await expect(editedSlides.nth(1)).toContainText('셋째 줄');

  await page.keyboard.press('Escape');
  await expect(page.getByTestId('split-view')).toBeHidden();
  await expect(
    page.getByTestId('song-card').first().getByTestId('section-textarea').first(),
  ).toHaveValue(/셋째 줄/);
});

test('typing a library title into a blank song pulls up its saved lyrics', async ({ page }) => {
  await page.goto('./');
  await page.getByTestId('add-song').click();

  const card = page.getByTestId('song-card').first();
  // Wait for the bundled library to load before relying on title matching.
  await expect(page.getByTestId('library-add-search')).toBeVisible();
  await expect
    .poll(async () => {
      await card.getByTestId('song-title-input').fill('입례');
      await card.getByTestId('song-title-input').blur();
      return card.getByTestId('section-textarea').count();
    }, { timeout: PARSE_TIMEOUT })
    .toBeGreaterThan(0);

  await expect(card.getByTestId('section-textarea').first()).not.toHaveValue('');
  await expect(card.getByTestId('order-input')).not.toHaveValue('');
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
  await page.getByTestId('wizard-next-additional').click();
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

test('keeps PowerPoint ids valid with a parsed conti and an uploaded sermon deck', async ({
  page,
}, testInfo) => {
  await page.goto('./');
  await uploadExamplePdf(page);
  await page.getByTestId('wizard-next-lyrics').click();
  await page.getByTestId('wizard-next-bible').click();

  await page.getByTestId('sermon-input').setInputFiles(SERMON_PPTX);
  await expect(page.getByText('업로드됨: bible-template.pptx')).toBeVisible();
  await page.getByTestId('wizard-next-sermon').click();
  await page.getByTestId('wizard-next-announcement').click();
  await page.getByTestId('wizard-next-additional').click();

  const dlPromise = page.waitForEvent('download');
  await page.getByTestId('generate-pptx').click();
  const download = await dlPromise;
  const zip = await loadPptx(download, testInfo.outputPath('conti-with-sermon.pptx'));
  const ids = await masterAndLayoutIds(zip);
  const slides = slideFileNames(zip);
  const allText = (await Promise.all(slides.map((name) => zip.file(name)!.async('string')))).join('\n');

  expect(ids.length).toBeGreaterThan(1);
  expect(new Set(ids).size).toBe(ids.length);
  expect(allText).toContain('주님의 사랑');
  expect(allText).toContain('{{SERMON_TITLE}}');
  expect(allText).toContain('공동체 고백송');
});

test.describe('web lyrics candidate review', () => {
  test('waits for a choice, applies the chosen page, and keeps the printed order', async ({ page }) => {
    const counts = await stubRecognitionProxy(page, {
      // Two plausible pages: neither is clearly ahead, so neither may apply
      // itself — several different worship songs share a title.
      lyrics: {
        candidates: [
          webCandidate(),
          webCandidate({
            id: 'ccmpia:ccmpia.com/song/2',
            host: 'ccmpia.com',
            source: 'ccmpia',
            url: 'https://ccmpia.com/song/2',
            title: '가나다라 마바사 (다른 편곡)',
            lines: ['가나다라 마바사 아자차', '전혀 다른 둘째 줄', '높이 높이 노래해', '영원토록 노래해'],
            score: 0.68,
          }),
        ],
        links: [],
      },
    });

    await page.goto('./');
    await uploadExamplePdf(page);
    const card = await recognizeFirstSong(page);

    // The card says what it is waiting for, in words rather than by colour.
    await expect(card.getByTestId('song-trust')).toHaveText(/웹 확인/);
    const review = card.getByTestId('web-review');
    await expect(review).toBeVisible();
    await expect(review.getByTestId('web-candidate')).toHaveCount(2);
    await expect(review.getByTestId('web-candidate').first()).toContainText('ccm.co.kr');
    await expect(review.getByTestId('web-candidate').first()).toContainText('%');

    // Nothing has been applied yet: the models' own reading is still showing.
    const firstPart = card.getByTestId('section-textarea').first();
    await expect(firstPart).toHaveValue(/가나다라 마바사 아자차/);
    const orderBefore = await card.getByTestId('order-input').inputValue();

    await review.getByTestId('web-candidate').first().click();

    await expect(card.getByTestId('order-input')).toHaveValue(orderBefore);
    await expect(firstPart).toHaveValue(/가나다라 마바사 아자차/);
    expect(counts.lyrics).toBeGreaterThan(0);
  });

  test('a rejected candidate leaves the recognized lyrics untouched', async ({ page }) => {
    await stubRecognitionProxy(page, { lyrics: { candidates: [webCandidate()], links: [] } });

    await page.goto('./');
    await uploadExamplePdf(page);
    const card = await recognizeFirstSong(page);

    const before = await card.getByTestId('section-textarea').first().inputValue();
    await card.getByTestId('web-candidate-none').click();

    await expect(card.getByTestId('web-review')).toBeHidden();
    await expect(card.getByTestId('section-textarea').first()).toHaveValue(before);
  });

  test('an auto candidate fills the lyrics in without asking', async ({ page }) => {
    await stubRecognitionProxy(page, {
      // One strong, clearly-ahead page: no question to put to the user.
      lyrics: {
        candidates: [
          webCandidate({
            decision: 'auto',
            score: 0.95,
            lines: ['가나다라 마바사 아자차', '카타파하 그 이름 높이', '높이 높이 노래해', '영원토록 노래해'],
          }),
        ],
        links: [],
      },
    });

    await page.goto('./');
    await uploadExamplePdf(page);
    const card = await recognizeFirstSong(page);

    await expect(card.getByTestId('web-review')).toHaveCount(0);
    await expect(card.getByTestId('section-textarea').first()).toHaveValue(/가나다라 마바사 아자차/);
  });
});

test.describe('learning admin dashboard', () => {
  /** Measured accuracy for every catalog model, best last so ranking shows. */
  const modelRows = RECOGNITION_MODEL_CATALOG.map((entry, index) => ({
    modelKey: `${entry.engine}:${entry.model}`,
    samples: 40,
    title: 0.9,
    artist: 0.8,
    artistSamples: 20,
    order: 0.9,
    lyrics: 0.7 + index * 0.02,
    successRate: 1,
    latencyMs: 1200,
    updatedAt: new Date().toISOString(),
    baseline: 0.8,
    paused: false,
  }));

  const corpusManifest = {
    id: 'a'.repeat(32),
    pageHash: 'a'.repeat(64),
    feedbackId: 'b'.repeat(64),
    createdAt: '2026-08-14T00:00:00.000Z',
    imageAvailable: false,
    versions: [{ order: ['I', 'V'], sections: [{ label: 'V', lines: ['가나다라 마바사 아자차'] }] }],
  };

  test('admin can inspect model roles and export verified training data', async ({ page }) => {
    await page.route(`${PROXY}/settings`, (route) => route.fulfill({ json: { bugsScrapingAllowed: false } }));
    await page.route(`${PROXY}/learning/models`, (route) => route.fulfill({ json: { models: modelRows } }));
    await page.route(`${PROXY}/learning/corpus`, (route) =>
      route.fulfill({
        json: { total: 140, verified: 120, edited: 20, withImage: 100, exported: 0, bytes: 51_200, limit: 300 },
      }),
    );
    await page.route(`${PROXY}/learning/corpus/manifests`, (route) =>
      route.fulfill({ json: { manifests: [corpusManifest] } }),
    );
    await page.route(`${PROXY}/learning/corpus/exported`, (route) =>
      route.fulfill({ json: { marked: 1, status: {} } }),
    );

    await page.goto('./');
    await unlockAdmin(page);

    // Three models read every page; the rest wait in reserve.
    await expect(page.getByTestId('learning-model-champion')).toHaveCount(3);
    await expect(page.getByTestId('training-corpus-count')).toContainText('검증 120');
    // Enough verified pages, none exported yet: a training run is worth doing.
    await expect(page.getByTestId('training-recommended')).toBeVisible();
    // Permission to read Bugs is deployment state, shown but not offered.
    await expect(page.getByTestId('bugs-permission')).toContainText('비활성');

    const download = page.waitForEvent('download');
    await page.getByTestId('training-export').click();
    expect((await download).suggestedFilename()).toMatch(/lyrics-training-.*\.zip/);
  });

  test('says so plainly when nothing has been measured yet', async ({ page }) => {
    await page.route(`${PROXY}/learning/models`, (route) => route.fulfill({ json: { models: [] } }));
    await page.route(`${PROXY}/learning/corpus`, (route) =>
      route.fulfill({
        json: { total: 0, verified: 0, edited: 0, withImage: 0, exported: 0, bytes: 0, limit: 300 },
      }),
    );

    await page.goto('./');
    await unlockAdmin(page);

    // Catalog roles stand in until measurement takes over.
    await expect(page.getByTestId('learning-model-champion')).toHaveCount(3);
    await expect(page.getByTestId('admin-learning-models')).toContainText('아직 측정된 표본이 없습니다');
    await expect(page.getByTestId('training-recommended')).toHaveCount(0);
  });

  test('stays readable at 320px without overflowing sideways', async ({ page }) => {
    await page.route(`${PROXY}/learning/models`, (route) => route.fulfill({ json: { models: modelRows } }));
    await page.setViewportSize({ width: 320, height: 720 });
    await page.goto('./');
    await unlockAdmin(page);

    await expect(page.getByTestId('admin-learning-models')).toBeVisible();
    const overflows = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    );
    expect(overflows).toBe(false);
  });
});

test.describe('adaptive learning loop', () => {
  test('escalates, reviews, verifies, and then re-reads the page before reusing the saved copy', async ({ page }) => {
    // Champion 0 reads the page one syllable differently from the other two,
    // which is what sends the page to a challenger.
    const correct = ['가나다라 마바사 아자차', '카타파하 그 이름 높이'];
    const misread = ['가나다라 마바사 아자차', '카타파하 그 이름 높히'];
    const counts = await stubRecognitionProxy(page, {
      score: () => stubScore(),
      lyrics: {
        candidates: [
          webCandidate({ lines: [...correct, '높이 높이 노래해', '영원토록 노래해'] }),
          webCandidate({
            id: 'ccmpia:other',
            host: 'ccmpia.com',
            source: 'ccmpia',
            url: 'https://ccmpia.com/other',
            title: '가나다라 마바사 (다른 편곡)',
            lines: [...correct, '전혀 다른 후렴'],
            score: 0.67,
          }),
        ],
        links: [],
      },
    });

    // Per-model answers, so one champion disagrees and a challenger settles it.
    const answered: string[] = [];
    const bodyFor = (model: string) =>
      JSON.stringify({
        results: [
          {
            imageIndex: 0,
            ...stubScore({
              sections: [
                { label: 'V', lines: model === 'gemini-3.6-flash' ? misread : correct },
                { label: 'C', lines: ['높이 높이 노래해', '영원토록 노래해'] },
              ],
            }),
          },
        ],
      });

    await page.route(`${PROXY}/gemini/**`, async (route) => {
      const model = decodeURIComponent(new URL(route.request().url()).pathname.split('/').pop() ?? '');
      answered.push(model);
      await route.fulfill({ json: { candidates: [{ content: { parts: [{ text: bodyFor(model) }] } }] } });
    });
    await page.route(`${PROXY}/openrouter`, async (route) => {
      const model = (route.request().postDataJSON() as { model?: string }).model ?? '';
      answered.push(model);
      await route.fulfill({ json: { choices: [{ message: { content: bodyFor(model) } }] } });
    });

    await page.goto('./');
    await uploadExamplePdf(page);
    const card = await recognizeFirstSong(page);

    // Three champions read the page; a challenger was brought in for it.
    const champions = RECOGNITION_MODEL_CATALOG.filter((entry) => entry.role === 'champion');
    for (const champion of champions) {
      expect(answered.filter((model) => model === champion.model).length).toBeGreaterThan(0);
    }
    const challengerCalls = RECOGNITION_MODEL_CATALOG.filter((entry) => entry.role === 'challenger').filter(
      (entry) => answered.includes(entry.model),
    );
    expect(challengerCalls.length).toBeGreaterThan(0);

    // Two plausible pages, so the user picks rather than one applying itself.
    await card.getByTestId('web-candidate').first().click();
    await expect(card.getByTestId('web-review')).toBeHidden();

    // Correct one line by hand, then save: that makes it an edited ground truth.
    const verse = card.getByTestId('section-textarea').first();
    await verse.fill(`${correct[0]}\n카타파하 그 이름 높여`);
    await card.getByRole('button', { name: '라이브러리에 저장' }).click();
    await expect(card.getByTestId('song-trust')).toHaveText(/검증됨/);

    // Reload with the same conti: a saved entry no longer stands in for the
    // page on its title alone. Nothing is loaded before the page has been
    // read, and the saved copy is used only where it says the same thing —
    // here the hand-corrected line is one syllable from what the models read,
    // so the page's own reading is what lands.
    // `answered` is what says the models were asked: this test's own routes
    // replace the counting ones, so counts stay flat however often they run.
    answered.length = 0;
    await page.reload();
    await uploadExamplePdf(page);
    const reopened = page.getByTestId('song-card').first();
    await expect(reopened).toBeVisible({ timeout: PARSE_TIMEOUT });
    await expect(reopened.getByTestId('section-textarea')).toHaveCount(0);

    await recognizeFirstSong(page);
    expect(answered.length).toBeGreaterThan(0);
    await reopened.getByTestId('web-candidate').first().click();
    await expect(reopened.getByTestId('section-textarea').first()).toHaveValue(
      new RegExp(correct[1]),
    );
  });
});
