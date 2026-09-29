import { test, expect, type Page } from '@playwright/test';
import JSZip from 'jszip';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const POSTER = path.join(HERE, '..', 'tests', 'fixtures', 'sheet-page.png');
const EXAMPLE_CONTI = path.join(HERE, '..', 'samples', 'conti-example.pdf');
const BUILD_TIMEOUT = 60_000;

async function slideTexts(zip: JSZip): Promise<string[]> {
  const presentation = await zip.file('ppt/presentation.xml')!.async('string');
  const rels = await zip.file('ppt/_rels/presentation.xml.rels')!.async('string');
  const texts: string[] = [];
  for (const match of presentation.matchAll(/<p:sldId [^>]*r:id="([^"]+)"/g)) {
    const target = rels.match(new RegExp(`Id="${match[1]}"[^>]*Target="([^"]+)"`))![1];
    const xml = await zip.file(`ppt/${target}`)!.async('string');
    texts.push([...xml.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((run) => run[1]).filter(Boolean).join(' | '));
  }
  return texts;
}

const PROXY = '**/ppt/__proxy';

/**
 * Answer the recognition proxy the e2e bundle is built with: the page at
 * position i of every request reads as "악보 곡 {i+1}", with made-up lyrics
 * (no real 악보 or published lyrics belong in a fixture).
 */
async function stubRecognition(page: Page): Promise<{ requests: number }> {
  const seen = { requests: 0 };
  const body = (images: number) =>
    JSON.stringify({
      results: Array.from({ length: Math.max(1, images) }, (_, imageIndex) => ({
        imageIndex,
        pageType: 'score',
        sermonTitle: '',
        scripture: '',
        title: `악보 곡 ${imageIndex + 1}`,
        artist: '',
        key: 'G',
        order: ['V', 'C'],
        lyricRowCount: 1,
        sections: [
          { label: 'V', lines: ['가나다라 마바사 아자차', '카타파하 그 이름 높이'] },
          { label: 'C', lines: ['높이 높이 노래해', '영원토록 노래해'] },
        ],
      })),
    });
  await page.route(`${PROXY}/settings`, (route) => route.fulfill({ json: {} }));
  await page.route(`${PROXY}/learning/models`, (route) => route.fulfill({ json: { models: [] } }));
  await page.route(`${PROXY}/gemini/**`, async (route) => {
    seen.requests += 1;
    const payload = route.request().postDataJSON() as { contents?: { parts?: unknown[] }[] };
    const images = (payload.contents?.[0]?.parts ?? []).filter((part) => !!(part as { inlineData?: unknown }).inlineData).length;
    await route.fulfill({ json: { candidates: [{ content: { parts: [{ text: body(images) }] } }] } });
  });
  await page.route(`${PROXY}/openrouter`, async (route) => {
    seen.requests += 1;
    const payload = route.request().postDataJSON() as { messages?: { content?: unknown[] }[] };
    const images = (payload.messages?.[0]?.content ?? []).filter((part) => (part as { type?: string }).type === 'image_url').length;
    await route.fulfill({ json: { choices: [{ message: { content: body(images) } }] } });
  });
  return seen;
}

function block(page: Page, kind: string) {
  return page.locator(`[data-testid="retreat-block"][data-kind="${kind}"]`);
}

test.describe('수련회 generator', () => {
  test('builds a session deck in the retreat design, songs filled from last year', async ({ page }, testInfo) => {
    await page.goto('retreat.html');
    await expect(page.getByTestId('retreat-panel-info')).toBeVisible();
    await expect(page.getByTestId('retreat-title')).toHaveValue('2026 빛주사랑 겨울 수련회');
    await page.getByTestId('retreat-title').fill('2027 빛주사랑 겨울 수련회');
    await page.getByTestId('retreat-next-info').click();

    // The first session is 금요일 저녁예배, in last year's order of service.
    await expect(page.getByTestId('retreat-session-tab')).toHaveCount(3);
    await page.getByTestId('retreat-session-date').fill('2027-01-15');
    await page.getByTestId('retreat-poster-input').setInputFiles(POSTER);

    const praise = block(page, 'songs').first();
    await praise.getByTestId('retreat-add-song-input').fill('주 안에서 기뻐해');
    await praise.getByTestId('retreat-add-song').click();
    await expect(praise.getByTestId('retreat-song-source')).toContainText('작년 수련회 가사');
    await expect(praise.getByTestId('retreat-song-lyrics')).toHaveValue(/주님 주신 기쁨으로 기뻐하라/);

    await block(page, 'scripture').getByTestId('retreat-passage').fill('마14:22-24');
    await expect(block(page, 'scripture').getByTestId('retreat-passage-hint')).toContainText('Matthew 14:22-24', {
      timeout: 30_000,
    });
    await block(page, 'sermon').getByTestId('retreat-sermon-title').fill('Go Beyond the Visible');
    await block(page, 'announcements').getByTestId('retreat-announcements').fill('1. <환영합니다>\n책자 p. 33 참고');

    await page.getByTestId('retreat-next-sessions').click();
    const row = page.getByTestId('retreat-download-row').first();
    await expect(row.getByTestId('retreat-file-name')).toHaveValue('0115_Retreat_Evening.pptx');

    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: BUILD_TIMEOUT }),
      row.getByTestId('retreat-download').click(),
    ]);
    expect(download.suggestedFilename()).toBe('0115_Retreat_Evening.pptx');
    // The PPT just made is in the 라이브러리 too.
    await expect(row.getByTestId('retreat-auto-save-status')).toHaveAttribute('data-state', 'saved', { timeout: BUILD_TIMEOUT });
    const saveTo = testInfo.outputPath('retreat.pptx');
    await download.saveAs(saveTo);
    const texts = await slideTexts(await JSZip.loadAsync(await fs.readFile(saveTo)));

    expect(texts[0]).toBe(''); // the poster cover
    expect(texts[1]).toBe('“2027 |  빛주사랑 겨울 수련회” | 피츠버그 한인 중앙교회 대학청년부');
    expect(texts[2]).toBe('찬양');
    expect(texts[3]).toBe('주 안에서 기뻐해');
    expect(texts[4]).toContain('주님 주신 기쁨으로 기뻐하라');
    expect(texts).toContain('설교말씀 | 마태복음 14장 22-24절');
    expect(texts.some((text) => text.startsWith('22 | ') && text.includes('Matthew 14:22-24'))).toBe(true);
    expect(texts).toContain('설교 | “Go Beyond the Visible”');
    expect(texts).toContain('기도회');
    expect(texts).toContain('축도');
    expect(texts.at(-1)).toContain('1. &lt;환영합니다&gt; | 책자 p. 33 참고 | 2027 빛주사랑 겨울 수련회');

    // The preview draws the real slides, photo backgrounds included.
    await row.getByTestId('retreat-preview').click();
    const grid = row.getByTestId('retreat-preview-grid');
    await expect(grid.locator('.slide-thumb')).toHaveCount(texts.length, { timeout: BUILD_TIMEOUT });
    // A preview is a generated PPT as well, and is saved the same way.
    await expect(row.getByTestId('retreat-auto-save-status')).toHaveAttribute('data-state', 'saved', { timeout: BUILD_TIMEOUT });
    await grid.scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath('retreat-preview.png'), fullPage: true });

    // The work survives a reload.
    await page.reload();
    await page.getByTestId('retreat-tab-sessions').click();
    await expect(block(page, 'sermon').getByTestId('retreat-sermon-title')).toHaveValue('Go Beyond the Visible');
  });

  test('reads songs off a 악보-only conti of several PDFs, and keeps the files and songs with the decks', async ({ page }) => {
    const models = await stubRecognition(page);
    // A second one-page PDF, printed by the browser itself. Both go in as
    // bytes, not paths: of two paths, one under this test's Korean output
    // folder, only one reached the page.
    await page.setContent('<p>Retreat conti, page two</p>');
    const second = await page.pdf();

    await page.goto('retreat.html');
    await page.getByTestId('retreat-conti-input').setInputFiles([
      { name: 'conti-example.pdf', mimeType: 'application/pdf', buffer: await fs.readFile(EXAMPLE_CONTI) },
      { name: 'conti-2.pdf', mimeType: 'application/pdf', buffer: second },
    ]);
    const files = page.getByTestId('retreat-conti-files').locator('li');
    await expect(files).toHaveText(['conti-example.pdf', 'conti-2.pdf'], { timeout: 30_000 });

    // No song table anywhere: every 악보 page is read, titles first, then lyrics.
    await expect(page.getByText(/곡 표가 없어 악보에서 \d+곡을 읽었습니다/)).toBeVisible({ timeout: BUILD_TIMEOUT });
    const scoreSongs = page.getByTestId('retreat-score-songs').locator('li');
    await expect(scoreSongs.first()).toHaveText(/악보 곡 1\s*악보에서 읽은 가사/);
    await expect(scoreSongs.nth(1)).toHaveText(/악보 곡 2\s*악보에서 읽은 가사/);
    expect(models.requests).toBeGreaterThan(0);
    await expect(page.locator('.toast-error')).toHaveCount(0);

    // A song typed into a 집회 takes the lyrics its 악보 page was read as.
    await page.getByTestId('retreat-tab-sessions').click();
    const praise = block(page, 'songs').first();
    await praise.getByTestId('retreat-add-song-input').fill('악보 곡 2');
    await praise.getByTestId('retreat-add-song').click();
    await expect(praise.getByTestId('retreat-song-source')).toContainText('악보에서 읽은 가사');
    await expect(praise.getByTestId('retreat-song-lyrics')).toHaveValue(/가나다라 마바사/);

    // Both files and the songs read are saved with the deck, and come back with 편집.
    await page.getByTestId('retreat-tab-download').click();
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: BUILD_TIMEOUT }),
      page.getByTestId('retreat-download-row').first().getByTestId('retreat-download').click(),
    ]);
    await download.path();
    await expect(page.getByTestId('retreat-download-row').first().getByTestId('retreat-download')).toHaveText(/PPT 다운로드/, {
      timeout: BUILD_TIMEOUT,
    });

    page.once('dialog', (dialog) => void dialog.accept());
    await page.getByTestId('retreat-reset').click();
    await expect(page.getByTestId('retreat-conti-files')).toHaveCount(0);
    await expect(page.getByTestId('retreat-score-songs')).toHaveCount(0);

    await page.getByRole('button', { name: '라이브러리' }).click();
    await page.getByTestId('library-entry-edit').first().click();
    await page.getByTestId('retreat-tab-info').click();
    await expect(files).toHaveText(['conti-example.pdf', 'conti-2.pdf']);
    await expect(scoreSongs.first()).toHaveText(/악보 곡 1/);

    // A file can be taken out again.
    await page.getByRole('button', { name: 'conti-2.pdf 빼기' }).click();
    await expect(files).toHaveText(['conti-example.pdf']);
  });
});
