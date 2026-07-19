import { describe, expect, it } from 'vitest';
import { normalizeTitle } from '../../src/lib/storage/library';
import {
  MAX_PPT_LIBRARY_BYTES,
  PPT_CHUNK_BYTES,
  normalizeLibraryTitle,
  samePptFiles,
  sanitizeLyricsEntries,
  sanitizePptDeckMetadata,
  sanitizePptFileDescriptor,
} from '../../worker/src/library.js';

describe('shared lyrics library validation', () => {
  it('uses the exact same title identity as the browser library', () => {
    for (const title of ['주님의  사랑!', 'Celebrate The Light', '찬양-123']) {
      expect(normalizeLibraryTitle(title)).toBe(normalizeTitle(title));
    }
  });

  it('sanitizes entries and keeps the last normalized-title duplicate', () => {
    const entries = sanitizeLyricsEntries([
      { title: '주님의 사랑', key: 'E', sections: [{ label: 'C', lines: ['첫 가사'] }], order: ['C'] },
      { title: '주님의사랑', key: 'G', sections: [{ label: 'C', lines: ['새 가사'] }], order: ['C'] },
      { title: '', sections: [], order: [] },
    ]);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ title: '주님의사랑', key: 'G' });
  });
});

describe('shared PPT library validation', () => {
  it('requires the declared chunk count to match the file size', () => {
    expect(sanitizePptFileDescriptor({ name: 'deck.pptx', size: PPT_CHUNK_BYTES + 1, chunkCount: 2 }, true)).toEqual({
      name: 'deck.pptx',
      size: PPT_CHUNK_BYTES + 1,
      chunkCount: 2,
    });
    expect(sanitizePptFileDescriptor({ name: 'deck.pptx', size: PPT_CHUNK_BYTES + 1, chunkCount: 1 }, true)).toBeNull();
    expect(sanitizePptFileDescriptor({ name: 'deck.pptx', size: 0, chunkCount: 1 }, true)).toBeNull();
  });

  it('accepts valid metadata and applies the server update timestamp', () => {
    const now = new Date('2026-07-19T18:00:00.000Z');
    const files = {
      pptx: { name: '0719.pptx', size: 10, chunkCount: 1 },
      contiPdf: null,
      sermonPptx: null,
    };
    expect(
      sanitizePptDeckMetadata(
        {
          id: 'deck-1',
          uploadId: 'upload-1',
          name: '0719.pptx',
          files,
          slideCount: 32,
          songTitles: ['주님의 사랑'],
          savedAt: '2026-07-19T17:00:00.000Z',
        },
        now,
      ),
    ).toMatchObject({ id: 'deck-1', uploadId: 'upload-1', updatedAt: now.toISOString() });
    expect(samePptFiles(files, structuredClone(files))).toBe(true);
  });

  it('rejects an entry whose combined files exceed 100 MB', () => {
    const size = MAX_PPT_LIBRARY_BYTES + 1;
    expect(
      sanitizePptDeckMetadata({
        id: 'deck-1',
        uploadId: 'upload-1',
        name: 'too-large.pptx',
        files: {
          pptx: { name: 'too-large.pptx', size, chunkCount: Math.ceil(size / PPT_CHUNK_BYTES) },
          contiPdf: null,
          sermonPptx: null,
        },
        slideCount: 1,
        savedAt: new Date().toISOString(),
      }),
    ).toBeNull();
  });
});
