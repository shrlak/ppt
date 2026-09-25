import { test, expect, type Page } from '@playwright/test';
import JSZip from 'jszip';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const POSTER = path.join(HERE, '..', 'tests', 'fixtures', 'sheet-page.png');
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
    await grid.scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath('retreat-preview.png'), fullPage: true });

    // The work survives a reload.
    await page.reload();
    await page.getByTestId('retreat-tab-sessions').click();
    await expect(block(page, 'sermon').getByTestId('retreat-sermon-title')).toHaveValue('Go Beyond the Visible');
  });
});
