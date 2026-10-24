import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { FreeCastStore } from '../../worker/src/freecast.js';
import { reconcileDeletedMedia } from '../../worker/src/mediaCleanup.js';

const original = () => ({ presentations: [{ id: 'service', slides: [{ mediaId: 'only' }, { mediaId: 'shared' }] }, { id: 'song', folder: 'Songs', slides: [{ mediaId: 'shared' }] }], media: [{ id: 'only' }, { id: 'shared' }], playlists: [{ id: 'songs', name: '찬양 목록' }] });

function harness() {
  const db = new DatabaseSync(':memory:');
  let failWrite = false;
  const sql = { exec(query: string, ...args: (string | number | Uint8Array)[]) {
    if (failWrite && query.startsWith('INSERT INTO library_chunks')) throw new Error('simulated storage failure');
    if (query.includes('CREATE TABLE')) { db.exec(query); return { toArray: () => [] }; }
    const statement = db.prepare(query);
    if (/^\s*SELECT/.test(query)) return { toArray: () => statement.all(...args) };
    statement.run(...args); return { toArray: () => [] };
  } };
  const store = new FreeCastStore({ storage: { sql, transactionSync(fn: () => void) {
    db.exec('BEGIN'); try { fn(); db.exec('COMMIT'); } catch (error) { db.exec('ROLLBACK'); throw error; }
  } } }, {});
  store.sessionUser = () => 'member';
  sql.exec('INSERT INTO library_meta VALUES (1, 1, 0, ?, 1)', 'member');
  sql.exec('INSERT INTO library_chunks VALUES (0, ?)', JSON.stringify(original()));
  for (const id of ['only', 'shared']) { sql.exec('INSERT INTO media_meta VALUES (?, ?, 1, 1, 0)', id, 'image/png'); sql.exec('INSERT INTO media_chunks VALUES (?, 0, ?)', id, new Uint8Array([1])); }
  const update = (version: number, data: unknown = { ...original(), presentations: original().presentations.slice(1) }) => store.fetch(new Request('https://test/freecast/library', { method: 'PUT', body: JSON.stringify({ baseVersion: version, data }) }));
  const mediaIds = () => db.prepare('SELECT id FROM media_meta ORDER BY id').all().map((r) => r.id);
  return { db, update, mediaIds, fail: () => { failWrite = true; } };
}
describe('server media deletion with library writes', () => {
  it('atomically deletes only exclusive blobs and metadata, preserving songs and their media', async () => {
    const h = harness();
    try {
      const response = await h.update(1);
      expect(response.status).toBe(200);
      expect((await response.json()).data.media).toEqual([{ id: 'shared' }]);
      expect(h.mediaIds()).toEqual(['shared']);
      expect(h.db.prepare('SELECT id FROM media_chunks').all()).toEqual([{ id: 'shared' }]);
    } finally { h.db.close(); }
  });
  it('never deletes blobs on a version conflict', async () => {
    const h = harness(); try { expect((await h.update(0)).status).toBe(409); expect(h.mediaIds()).toEqual(['only', 'shared']); } finally { h.db.close(); }
  });
  it('rolls back both blob deletion and library update if storage fails', async () => {
    const h = harness(); h.fail();
    try { expect((await h.update(1)).status).toBe(500); expect(h.mediaIds()).toEqual(['only', 'shared']); expect(h.db.prepare('SELECT version FROM library_meta').get()?.version).toBe(1); } finally { h.db.close(); }
  });
  it('repairs media metadata when another device reused an asset', () => {
    const before = original();
    const after = { ...before, media: [], presentations: [{ id: 'song', slides: [{ mediaId: 'only' }, { mediaId: 'shared' }] }] };
    const result = reconcileDeletedMedia(before, after);
    expect(result.deletedIds).toEqual([]);
    expect(result.data.media).toEqual(before.media);
  });
  const trashed = () => ({ ...original(), presentations: original().presentations.slice(1), trash: [{ id: 'deleted-service', kind: 'presentation', presentation: original().presentations[0], deletedAt: 100, expiresAt: 100 + 30 * 86400000 }] });
  it('keeps soft-deleted media in the database while retained by trash', async () => {
    const h = harness();
    try {
      expect((await h.update(1, trashed())).status).toBe(200);
      expect(h.mediaIds()).toEqual(['only', 'shared']);
      expect(h.db.prepare('SELECT id FROM media_chunks ORDER BY id').all()).toEqual([{ id: 'only' }, { id: 'shared' }]);
    } finally { h.db.close(); }
  });
  it('atomically deletes exclusive blobs when the trash is purged, even though no live decks were removed in that update', async () => {
    const h = harness();
    try {
      await h.update(1, trashed());
      const response = await h.update(2, { ...trashed(), trash: [], media: [{ id: 'shared' }] });
      expect(response.status).toBe(200);
      expect(h.mediaIds()).toEqual(['shared']);
      expect(h.db.prepare('SELECT id FROM media_chunks').all()).toEqual([{ id: 'shared' }]);
      expect(JSON.parse(String(h.db.prepare('SELECT data FROM library_chunks').get()?.data)).trash).toEqual([]);
    } finally { h.db.close(); }
  });
  it('preserves blobs used by another trash entry or a restored slide', () => {
    const before = trashed();
    const another = { ...before.trash[0], id: 'another' };
    expect(reconcileDeletedMedia(before, { ...before, trash: [another] }).deletedIds).toEqual([]);
    const restored = { ...before, trash: [], presentations: original().presentations };
    expect(reconcileDeletedMedia(before, restored).deletedIds).toEqual([]);
  });
  it('rolls back trash purge and blob deletion together on a failed library write', async () => {
    const h = harness();
    try {
      await h.update(1, trashed()); h.fail();
      expect((await h.update(2, { ...trashed(), trash: [] })).status).toBe(500);
      expect(h.mediaIds()).toEqual(['only', 'shared']);
      expect(h.db.prepare('SELECT version FROM library_meta').get()?.version).toBe(2);
      expect(JSON.parse(String(h.db.prepare('SELECT data FROM library_chunks').get()?.data)).trash).toHaveLength(1);
    } finally { h.db.close(); }
  });
});
