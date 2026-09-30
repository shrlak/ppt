import { describe, expect, it } from 'vitest';
import { PREVIEW_RENDER_WIDTH, renderPagePreviews } from '../../src/lib/utils/pagePreviews';

/** A document whose pages take the given time (ms) to draw, recording what it was asked. */
function fakeDoc(delays: Record<number, number>, failing: number[] = []) {
  const started: number[] = [];
  const widths: number[] = [];
  let running = 0;
  let peak = 0;
  return {
    started,
    widths,
    peak: () => peak,
    async renderPage(page: number, width?: number): Promise<string> {
      started.push(page);
      widths.push(width ?? 0);
      running++;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, delays[page] ?? 0));
      running--;
      if (failing.includes(page)) throw new Error('draw failed');
      return `page-${page}`;
    },
  };
}

describe('renderPagePreviews', () => {
  it('hands over each page as soon as it is drawn, not after the slow one before it', async () => {
    const doc = fakeDoc({ 3: 5, 4: 60, 5: 5, 6: 5 });
    const shown: number[] = [];
    await renderPagePreviews(doc, [3, 4, 5, 6], (page, url) => {
      expect(url).toBe(`page-${page}`);
      shown.push(page);
    });
    expect(shown).toEqual([3, 5, 6, 4]);
    expect(doc.started).toEqual([3, 4, 5, 6]);
  });

  it('draws two pages at a time, at the preview width', async () => {
    const doc = fakeDoc({ 1: 10, 2: 10, 3: 10, 4: 10, 5: 10 });
    await renderPagePreviews(doc, [1, 2, 3, 4, 5], () => undefined);
    expect(doc.peak()).toBe(2);
    expect(new Set(doc.widths)).toEqual(new Set([PREVIEW_RENDER_WIDTH]));
  });

  it('skips a page that fails to draw and still draws the rest', async () => {
    const doc = fakeDoc({}, [4]);
    const shown: number[] = [];
    await expect(renderPagePreviews(doc, [3, 4, 5], (page) => shown.push(page))).resolves.toBeUndefined();
    expect(shown).toEqual([3, 5]);
  });

  it('settles at once when there is nothing to draw', async () => {
    const doc = fakeDoc({});
    await renderPagePreviews(doc, [], () => undefined);
    expect(doc.started).toEqual([]);
  });
});
