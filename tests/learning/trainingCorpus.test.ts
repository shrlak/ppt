import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import {
  dataUrlByteLength,
  enforceTrainingLimit,
  exportTrainingCorpus,
  mergeTrainingExamples,
  type TrainingExampleManifest,
} from '../../src/lib/learning/trainingCorpus';
import {
  corpusStatus,
  evictableCorpusIds,
  expectedChunkBytes,
  matchCorpusChunkRoute,
  matchCorpusRecordRoute,
  sanitizeCorpusManifest,
} from '../../worker/src/trainingCorpus.js';
import { createWorkerHarness } from '../support/workerHarness';

const hash = (seed: string) =>
  [...seed].map((character) => (character.codePointAt(0)! % 16).toString(16)).join('').padEnd(64, '0');

/** JSZip cannot re-read its own Blob in Node, so go through the bytes. */
const reopen = async (blob: Blob) => JSZip.loadAsync(await blob.arrayBuffer());

const score = (line: string) => ({ order: ['I', 'V'], sections: [{ label: 'V', lines: [line] }] });

function manifest(overrides: Partial<TrainingExampleManifest> = {}): TrainingExampleManifest {
  const pageHash = overrides.pageHash ?? hash('page-a');
  return {
    id: pageHash.slice(0, 32),
    pageHash,
    feedbackId: hash('feedback'),
    createdAt: '2026-08-14T00:00:00.000Z',
    imageAvailable: true,
    image: { mimeType: 'image/webp', size: 2048, sha256: hash('image'), chunkCount: 1 },
    versions: [score('가나다라 마바사 아자차')],
    ...overrides,
  };
}

describe('mergeTrainingExamples', () => {
  it('deduplicates by page hash while preserving final-version history', () => {
    const v1 = manifest({ versions: [score('첫 번째로 저장한 가사')] });
    const v2 = manifest({ versions: [score('나중에 고쳐 저장한 가사')], createdAt: '2026-08-21T00:00:00.000Z' });
    expect(mergeTrainingExamples([v1], v2)).toMatchObject({
      pageHash: v1.pageHash,
      versions: [v1.versions[0], v2.versions[0]],
    });
  });

  it('keeps the record’s original identity and first-seen date', () => {
    const v1 = manifest();
    const v2 = manifest({ id: 'a-different-id', createdAt: '2026-09-01T00:00:00.000Z' });
    const merged = mergeTrainingExamples([v1], v2);
    expect(merged.id).toBe(v1.id);
    expect(merged.createdAt).toBe(v1.createdAt);
  });

  it('does not record the same answer twice', () => {
    const v1 = manifest();
    expect(mergeTrainingExamples([v1], manifest()).versions).toHaveLength(1);
  });

  it('clears the exported flag, since a new version has not been exported', () => {
    const exported = manifest({ exportedAt: '2026-08-15T00:00:00.000Z' });
    const next = manifest({ versions: [score('고친 가사')] });
    expect(mergeTrainingExamples([exported], next).exportedAt).toBeUndefined();
  });

  it('is the incoming record when the page is new', () => {
    const incoming = manifest({ pageHash: hash('page-b') });
    expect(mergeTrainingExamples([manifest()], incoming)).toBe(incoming);
  });
});

describe('enforceTrainingLimit', () => {
  const examples = (count: number, exportFirst = true): TrainingExampleManifest[] =>
    Array.from({ length: count }, (_, index) =>
      manifest({
        id: `record-${String(index).padStart(4, '0')}`,
        pageHash: hash(`page-${index}`),
        createdAt: new Date(Date.UTC(2026, 0, 1 + index)).toISOString(),
        ...(exportFirst && index === 0 ? { exportedAt: '2026-08-15T00:00:00.000Z' } : {}),
      }),
    );

  it('evicts only exported oldest images after the 300 image cap', () => {
    const all = examples(301);
    const oldestExported = all[0];
    const result = enforceTrainingLimit(all, 300);
    expect(result.evicted).toEqual([oldestExported.id]);
    expect(result.kept).toHaveLength(300);
  });

  it('sits over the cap rather than destroying work no artifact has taken', () => {
    // Evicting an unexported record would silently lose a correction; the
    // dashboard surfaces the overflow instead.
    const result = enforceTrainingLimit(examples(305, false), 300);
    expect(result.evicted).toEqual([]);
    expect(result.kept).toHaveLength(305);
  });

  it('does nothing while the corpus is under its cap', () => {
    expect(enforceTrainingLimit(examples(10), 300)).toMatchObject({ evicted: [] });
  });

  it('agrees with the proxy-side eviction rule (kept in lockstep)', () => {
    const all = examples(301);
    expect(evictableCorpusIds(all, 300)).toEqual(enforceTrainingLimit(all, 300).evicted);
  });
});

describe('exportTrainingCorpus', () => {
  const entries = [
    { manifest: manifest({ id: 'b-second', pageHash: hash('page-b') }), image: new Uint8Array([1, 2, 3]) },
    { manifest: manifest({ id: 'a-first', pageHash: hash('page-a') }), image: new Uint8Array([4, 5, 6]) },
  ];

  it('writes a manifest, the images and a terms note', async () => {
    const zip = await reopen(await exportTrainingCorpus(entries));
    // JSZip records the implicit `images/` directory entry too.
    expect(Object.keys(zip.files).filter((name) => !name.endsWith('/')).sort()).toEqual([
      'README.md',
      `images/${hash('page-a')}.webp`,
      `images/${hash('page-b')}.webp`,
      'manifest.jsonl',
    ]);
    const readme = await zip.file('README.md')!.async('string');
    expect(readme).toContain('Do not redistribute');
  });

  it('sorts by id so the same corpus exports the same bytes twice', async () => {
    const first = await exportTrainingCorpus(entries);
    const second = await exportTrainingCorpus([...entries].reverse());
    expect(new Uint8Array(await first.arrayBuffer())).toEqual(new Uint8Array(await second.arrayBuffer()));

    const zip = await reopen(first);
    const lines = (await zip.file('manifest.jsonl')!.async('string')).trim().split('\n');
    expect(lines.map((line) => JSON.parse(line).id)).toEqual(['a-first', 'b-second']);
  });

  it('points each record at its image and names its training target', async () => {
    const zip = await reopen(await exportTrainingCorpus(entries));
    const line = JSON.parse((await zip.file('manifest.jsonl')!.async('string')).trim().split('\n')[0]);
    expect(line.image).toBe(`images/${hash('page-a')}.webp`);
    expect(line.final).toEqual(line.versions[line.versions.length - 1]);
  });

  it('records a page with no captured image as metadata only', async () => {
    const withoutImage = { manifest: manifest({ imageAvailable: false, image: undefined }) };
    const zip = await reopen(await exportTrainingCorpus([withoutImage]));
    expect(Object.keys(zip.files).filter((name) => !name.endsWith('/')).sort()).toEqual([
      'README.md',
      'manifest.jsonl',
    ]);
    const line = JSON.parse((await zip.file('manifest.jsonl')!.async('string')).trim());
    expect(line.image).toBeUndefined();
    expect(line.final).not.toBeNull();
  });
});

describe('dataUrlByteLength', () => {
  it('measures the decoded size without decoding', () => {
    expect(dataUrlByteLength('data:image/webp;base64,AAAA')).toBe(3);
    expect(dataUrlByteLength('data:image/webp;base64,AAA=')).toBe(2);
  });
});

describe('proxy-side corpus validation', () => {
  const valid = {
    id: hash('page-a').slice(0, 32),
    pageHash: hash('page-a'),
    feedbackId: hash('feedback'),
    createdAt: '2026-08-14T00:00:00.000Z',
    image: { mimeType: 'image/webp', size: 2048, sha256: hash('image'), chunkCount: 1 },
    versions: [score('가나다라 마바사')],
  };

  it('rejects a chunk count that does not follow from the declared size', () => {
    // Otherwise a one-byte upload could reserve unbounded chunk slots.
    expect(sanitizeCorpusManifest({ ...valid, image: { ...valid.image, chunkCount: 40 } })).toBeNull();
    expect(sanitizeCorpusManifest({ ...valid, image: { ...valid.image, mimeType: 'image/gif' } })).toBeNull();
  });

  it('accepts a record with no image, but not a malformed one', () => {
    expect(sanitizeCorpusManifest({ ...valid, image: undefined })).toMatchObject({ imageAvailable: false });
    expect(sanitizeCorpusManifest({ ...valid, image: { mimeType: 'image/webp' } })).toBeNull();
  });

  it('requires at least one saved answer to train on', () => {
    expect(sanitizeCorpusManifest({ ...valid, versions: [] })).toBeNull();
    expect(sanitizeCorpusManifest({ ...valid, pageHash: 'not-a-hash' })).toBeNull();
  });

  it('routes chunk and record paths, and nothing else', () => {
    expect(matchCorpusChunkRoute('/learning/corpus/abc123/chunks/2')).toEqual({ id: 'abc123', index: 2 });
    expect(matchCorpusChunkRoute('/learning/corpus/abc/chunks/x')).toBeNull();
    expect(matchCorpusRecordRoute('/learning/corpus/abc123')).toEqual({ id: 'abc123' });
    expect(matchCorpusRecordRoute('/learning/corpus/abc/../etc')).toBeNull();
  });

  it('sizes the last chunk from what is left over', () => {
    const image = { mimeType: 'image/webp' as const, size: 1024 * 1024 + 10, sha256: hash('i'), chunkCount: 2 };
    expect(expectedChunkBytes(image, 0)).toBe(1024 * 1024);
    expect(expectedChunkBytes(image, 1)).toBe(10);
  });

  it('reports counts and bytes, never content', () => {
    const status = corpusStatus([
      sanitizeCorpusManifest(valid)!,
      sanitizeCorpusManifest({ ...valid, id: 'other', diff: { titleChanged: true } })!,
    ]);
    expect(status).toMatchObject({ total: 2, verified: 1, edited: 1, bytes: 4096 });
    expect(JSON.stringify(status)).not.toContain('가나다라');
  });
});

describe('the corpus over the proxy', () => {
  const manifestBody = (line: string, exported?: string) => ({
    id: hash('page-a').slice(0, 32),
    pageHash: hash('page-a'),
    feedbackId: hash('feedback'),
    createdAt: '2026-08-14T00:00:00.000Z',
    image: { mimeType: 'image/webp', size: 3, sha256: hash('image'), chunkCount: 1 },
    versions: [score(line)],
    ...(exported ? { exportedAt: exported } : {}),
  });

  it('stores a record, accepts its image, and hands it back', async () => {
    const harness = createWorkerHarness();
    const put = await harness.fetch('/learning/corpus', {
      method: 'PUT',
      admin: true,
      body: JSON.stringify({ manifest: manifestBody('가나다라 마바사') }),
    });
    expect(put.status).toBe(200);

    const id = hash('page-a').slice(0, 32);
    const chunk = await harness.fetch(`/learning/corpus/${id}/chunks/0`, {
      method: 'PUT',
      admin: true,
      body: new Uint8Array([1, 2, 3]),
    });
    expect(chunk.status).toBe(200);

    const download = await harness.fetch(`/learning/corpus/${id}/chunks/0`, { admin: true });
    expect(new Uint8Array(await download.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('refuses every corpus route without the administrator password', async () => {
    const harness = createWorkerHarness();
    const id = hash('page-a').slice(0, 32);
    for (const [path, init] of [
      ['/learning/corpus', { method: 'GET' }],
      ['/learning/corpus', { method: 'PUT', body: JSON.stringify({ manifest: manifestBody('x') }) }],
      [`/learning/corpus/${id}/chunks/0`, { method: 'GET' }],
      [`/learning/corpus/${id}`, { method: 'DELETE' }],
    ] as const) {
      expect((await harness.fetch(path, init)).status).toBe(403);
    }
  });

  it('rejects a chunk whose length does not match the manifest', async () => {
    const harness = createWorkerHarness();
    await harness.fetch('/learning/corpus', {
      method: 'PUT',
      admin: true,
      body: JSON.stringify({ manifest: manifestBody('가나다라 마바사') }),
    });
    const id = hash('page-a').slice(0, 32);
    const wrong = await harness.fetch(`/learning/corpus/${id}/chunks/0`, {
      method: 'PUT',
      admin: true,
      body: new Uint8Array([1, 2, 3, 4, 5]),
    });
    expect(wrong.status).toBe(400);
    const outOfRange = await harness.fetch(`/learning/corpus/${id}/chunks/7`, {
      method: 'PUT',
      admin: true,
      body: new Uint8Array([1]),
    });
    expect(outOfRange.status).toBe(400);
  });

  it('adds a version instead of a second record when a page is verified again', async () => {
    const harness = createWorkerHarness();
    for (const line of ['첫 번째로 저장한 가사', '나중에 고쳐 저장한 가사']) {
      await harness.fetch('/learning/corpus', {
        method: 'PUT',
        admin: true,
        body: JSON.stringify({ manifest: manifestBody(line) }),
      });
    }
    const listed = (await (await harness.fetch('/learning/corpus/manifests', { admin: true })).json()) as {
      manifests: { versions: unknown[] }[];
    };
    expect(listed.manifests).toHaveLength(1);
    expect(listed.manifests[0].versions).toHaveLength(2);
  });

  it('marks records exported and deletes them with their chunks', async () => {
    const harness = createWorkerHarness();
    const id = hash('page-a').slice(0, 32);
    await harness.fetch('/learning/corpus', {
      method: 'PUT',
      admin: true,
      body: JSON.stringify({ manifest: manifestBody('가나다라 마바사') }),
    });
    await harness.fetch(`/learning/corpus/${id}/chunks/0`, {
      method: 'PUT',
      admin: true,
      body: new Uint8Array([1, 2, 3]),
    });

    const marked = await harness.fetch('/learning/corpus/exported', {
      method: 'POST',
      admin: true,
      body: JSON.stringify({ ids: [id] }),
    });
    expect(await marked.json()).toMatchObject({ marked: 1 });

    await harness.fetch(`/learning/corpus/${id}`, { method: 'DELETE', admin: true });
    const status = (await (await harness.fetch('/learning/corpus', { admin: true })).json()) as { total: number };
    expect(status.total).toBe(0);
    expect((await harness.storage.list({ prefix: 'learning:corpus:chunk:' })).size).toBe(0);
  });

  it('survives the weekly PPT purge untouched', async () => {
    // A corpus wiped every Sunday could never train anything.
    const harness = createWorkerHarness();
    await harness.fetch('/learning/corpus', {
      method: 'PUT',
      admin: true,
      body: JSON.stringify({ manifest: manifestBody('가나다라 마바사') }),
    });
    await harness.tracker.purgePptLibrary({ at: '2026-08-16T21:00:00.000Z', trigger: 'manual' });
    const status = (await (await harness.fetch('/learning/corpus', { admin: true })).json()) as { total: number };
    expect(status.total).toBe(1);
  });
});
