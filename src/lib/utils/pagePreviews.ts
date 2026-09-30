// The 악보 previews on the song cards: a conti's score pages, drawn small
// enough to show at once.

/**
 * Width (CSS px) a score page is drawn at for its card. The card shows it
 * 260px wide, and full width on a phone, so this stays sharp on a high-density
 * screen either way.
 */
export const PREVIEW_RENDER_WIDTH = 700;

/**
 * How many pages are drawn side by side. Two keeps the pdf.js worker reading
 * the next page while the one before it is being painted, without splitting
 * the main thread so many ways that the first card waits on all of them.
 */
export const PREVIEW_CONCURRENCY = 2;

export interface PageRenderer {
  renderPage(pageNumber: number, maxWidth?: number, format?: 'jpeg' | 'png'): Promise<string>;
}

/**
 * Draw each page's preview and hand it over the moment it is ready.
 *
 * Pages start in the order given, so the first song's 악보 comes first, and a
 * page that fails is skipped rather than holding up the ones after it — a
 * preview is only ever a convenience.
 */
export async function renderPagePreviews(
  doc: PageRenderer,
  pages: readonly number[],
  onPage: (page: number, url: string) => void,
  { width = PREVIEW_RENDER_WIDTH, concurrency = PREVIEW_CONCURRENCY } = {},
): Promise<void> {
  let next = 0;
  const lane = async () => {
    while (next < pages.length) {
      const page = pages[next++];
      try {
        onPage(page, await doc.renderPage(page, width));
      } catch {
        // Best-effort: the card keeps saying the preview is on its way.
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, pages.length)) }, lane));
}
