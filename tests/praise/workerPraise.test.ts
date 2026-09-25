import { describe, expect, it } from 'vitest';
import { sanitizePptDeckMetadata } from '../../worker/src/library.js';
import { sanitizePraiseEnglishEntry } from '../../worker/src/praiseEnglish.js';
import { createWorkerHarness } from '../support/workerHarness';

const files = {
  pptx: { name: 'deck.pptx', size: 10, chunkCount: 1 },
  contiPdf: null,
  sermonPptx: null,
  source: null,
  additionalFiles: null,
};

function deck(id: string, keep?: boolean) {
  return {
    id,
    uploadId: `upload-${id}`,
    name: `${id}.pptx`,
    files,
    slideCount: 10,
    songTitles: [],
    savedAt: '2026-09-20T12:00:00.000Z',
    ...(keep === undefined ? {} : { keep }),
  };
}

describe('decks kept until deleted by hand', () => {
  it('carries keep only when it is exactly true', () => {
    expect(sanitizePptDeckMetadata(deck('a', true))?.keep).toBe(true);
    expect(sanitizePptDeckMetadata(deck('b'))).not.toHaveProperty('keep');
    expect(sanitizePptDeckMetadata({ ...deck('c'), keep: 'yes' })).not.toHaveProperty('keep');
  });

  it('survives the weekly purge, while every other deck is wiped', async () => {
    const harness = createWorkerHarness();
    const { storage, tracker } = harness;
    for (const entry of [deck('weekly'), deck('praise', true)]) {
      const metadata = sanitizePptDeckMetadata(entry)!;
      await storage.put(`library:ppt:meta:${metadata.id}`, metadata);
      await storage.put(`library:ppt:chunk:${metadata.uploadId}:pptx:0`, new ArrayBuffer(10));
    }

    const record = await tracker.purgePptLibrary({ purgeKey: '2026-09-27', at: '2026-09-27T21:00:00.000Z' });
    expect(record).toMatchObject({ decks: 1, kept: 1 });

    const library = await tracker.pptLibrary();
    expect(library.decks.map((entry: { id: string }) => entry.id)).toEqual(['praise']);
    expect(library.deletedIds).toEqual(['weekly']);
    expect(await storage.get('library:ppt:chunk:upload-praise:pptx:0')).toBeInstanceOf(ArrayBuffer);
    expect(await storage.get('library:ppt:chunk:upload-weekly:pptx:0')).toBeUndefined();
  });

  it('can still be deleted by hand', async () => {
    const { storage, tracker } = createWorkerHarness();
    const metadata = sanitizePptDeckMetadata(deck('praise', true))!;
    await storage.put(`library:ppt:meta:${metadata.id}`, metadata);
    await tracker.deletePptDeck('praise');
    expect((await tracker.pptLibrary()).decks).toEqual([]);
  });
});

describe('찬양집회 영어 가사 library route', () => {
  const entry = {
    title: '주님의 선하심',
    englishTitle: 'Goodness of God',
    slides: [{ ko: ['사랑해요 주의 자비 변치 않네'], en: ['I love You Lord'] }, { ko: [], en: [] }],
  };

  it('drops empty slides and keeps the rest', () => {
    expect(sanitizePraiseEnglishEntry(entry)?.slides).toEqual([{ ko: ['사랑해요 주의 자비 변치 않네'], en: ['I love You Lord'] }]);
    expect(sanitizePraiseEnglishEntry({ title: '  ' })).toBeNull();
  });

  it('needs the administrator password to write, and serves reads to anyone', async () => {
    const harness = createWorkerHarness();
    const refused = await harness.fetch('/libraries/praise-english', {
      method: 'PUT',
      body: JSON.stringify({ entry }),
    });
    expect(refused.status).toBe(403);

    const written = await harness.fetch('/libraries/praise-english', {
      method: 'PUT',
      admin: true,
      body: JSON.stringify({ entry }),
    });
    expect(written.status).toBe(200);

    const read = await harness.fetch('/libraries/praise-english');
    const body = (await read.json()) as { entries: { title: string; englishTitle: string }[] };
    expect(body.entries).toMatchObject([{ title: '주님의 선하심', englishTitle: 'Goodness of God' }]);

    // Deleting leaves a tombstone, so a stale device cannot bring it back.
    await harness.fetch('/libraries/praise-english', {
      method: 'DELETE',
      admin: true,
      body: JSON.stringify({ title: '주님의 선하심' }),
    });
    const merged = await harness.fetch('/libraries/praise-english', {
      method: 'POST',
      admin: true,
      body: JSON.stringify({ entries: [entry] }),
    });
    const after = (await merged.json()) as { entries: unknown[]; deletedTitles: string[] };
    expect(after.entries).toEqual([]);
    expect(after.deletedTitles).toHaveLength(1);
  });

  it('is never touched by the weekly PPT purge', async () => {
    const harness = createWorkerHarness();
    await harness.fetch('/libraries/praise-english', { method: 'PUT', admin: true, body: JSON.stringify({ entry }) });
    await harness.tracker.purgePptLibrary({ purgeKey: '2026-09-27' });
    const body = (await (await harness.fetch('/libraries/praise-english')).json()) as { entries: unknown[] };
    expect(body.entries).toHaveLength(1);
  });
});
