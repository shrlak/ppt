import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { FreeCastStore } from '../../worker/src/freecast.js';

const password = 'member-password';
async function harness() {
  const db = new DatabaseSync(':memory:'); let fail = false;
  const sql = { exec(query: string, ...args: (string | number | Uint8Array)[]) {
    if (fail && query.startsWith('INSERT INTO library_chunks')) throw new Error('simulated write failure');
    if (query.includes('CREATE TABLE')) { db.exec(query); return { toArray: () => [] }; }
    const statement = db.prepare(query);
    if (/^\s*SELECT/.test(query)) return { toArray: () => statement.all(...args) };
    statement.run(...args); return { toArray: () => [] };
  } };
  const store = new FreeCastStore({ storage: { sql, transactionSync(fn: () => void) {
    db.exec('BEGIN'); try { fn(); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; }
  } } }, {});
  const request = (path: string, token?: string, method = 'GET', body?: unknown) => store.fetch(new Request('https://church.test/freecast' + path, {
    method, headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}),
  }));
  await store.fetch(new Request('https://church.test/freecast/register', { method: 'POST', headers: { 'x-fc-admin': '1' }, body: JSON.stringify({ username: 'member', password }) }));
  const token = (await (await request('/login', undefined, 'POST', { username: 'member', password })).json()).token;
  const data = { version: 1, presentations: [{ id: 'protected', protected: true, slides: [{ mediaId: 'asset' }] }], playlists: [{ id: 'pl', name: '예배', items: [] }], media: [{ id: 'asset' }], trash: [{ id: 'trash' }], themes: [{ id: 't' }], sunday: { frontId: 'protected' } };
  sql.exec('INSERT INTO library_meta VALUES (1, 7, 0, ?, 1)', 'member');
  sql.exec('INSERT INTO library_chunks VALUES (0, ?)', JSON.stringify(data));
  sql.exec('INSERT INTO media_meta VALUES (?, ?, 3, 1, 0)', 'asset', 'image/png');
  sql.exec('INSERT INTO media_chunks VALUES (?, 0, ?)', 'asset', new Uint8Array([1, 2, 3]));
  const preview = async () => (await (await request('/clear', token)).json());
  const clear = async (revision?: string, pass = password) => request('/clear', token, 'POST', { password: pass, revision: revision ?? (await preview()).revision });
  const files = () => db.prepare('SELECT COUNT(*) AS n FROM media_meta').get()!.n;
  return { db, store, token, request, preview, clear, files, fail: () => { fail = true; } };
}

describe('password-confirmed FreeCast-only clear', () => {
  it('requires a logged-in session and correct password before changing any data', async () => {
    const h = await harness(); try {
      expect((await h.request('/clear')).status).toBe(401);
      expect((await h.request('/clear', undefined, 'POST', { password })).status).toBe(401);
      expect((await h.clear(undefined, 'wrong')).status).toBe(403);
      expect(h.files()).toBe(1); expect((await h.request('/library', h.token)).status).toBe(200);
    } finally { h.db.close(); }
  });
  it('lets an ordinary member clear protected decks, playlists, trash and all blob chunks, while preserving accounts', async () => {
    const h = await harness(); try {
      const p = await h.preview(); expect(p).toMatchObject({ server: 'https://church.test', presentations: 1, playlists: 1, trash: 1, mediaCount: 1, mediaBytes: 3 });
      const response = await h.clear(p.revision); expect(response.status).toBe(200); const result = await response.json();
      expect(result.data).toMatchObject({ presentations: [], media: [], trash: [], protectionChanges: [], sunday: { frontId: null, backId: null, prayerId: null } });
      expect(result.data.playlists[0].items).toEqual([]); expect(result.version).toBe(8); expect(result.data.cloudResetId).toBeTruthy();
      expect(h.files()).toBe(0); expect(h.db.prepare('SELECT COUNT(*) AS n FROM media_chunks').get()!.n).toBe(0);
      expect(h.db.prepare('SELECT COUNT(*) AS n FROM users').get()!.n).toBe(1);
      expect((await h.request('/me', h.token)).status).toBe(401); expect((await h.request('/me', result.token)).status).toBe(200);
    } finally { h.db.close(); }
  });
  it('rejects changed library/media inventory even when library version did not change', async () => {
    const h = await harness(); try {
      const p = await h.preview();
      expect((await h.store.fetch(new Request('https://church.test/freecast/media/new', { method: 'PUT', headers: { Authorization: 'Bearer ' + h.token }, body: 'new' }))).status).toBe(200);
      expect((await h.clear(p.revision)).status).toBe(409); expect(h.files()).toBe(2);
    } finally { h.db.close(); }
  });
  it('rate-limits password guessing and deletes nothing on lockout', async () => {
    const h = await harness(); try {
      for (let i = 0; i < 5; i++) expect((await h.clear(undefined, 'wrong')).status).toBe(403);
      expect((await h.clear()).status).toBe(429); expect(h.files()).toBe(1);
    } finally { h.db.close(); }
  });
  it('rolls back data, session revocation and reset generation when a write fails', async () => {
    const h = await harness(); try {
      h.fail(); expect((await h.clear()).status).toBe(500); expect(h.files()).toBe(1);
      expect((await h.request('/me', h.token)).status).toBe(200);
      expect(h.db.prepare('SELECT reset_id FROM freecast_state').get()!.reset_id).toBe(null);
      expect(h.db.prepare('SELECT version FROM library_meta').get()!.version).toBe(7);
    } finally { h.db.close(); }
  });
  it('blocks old clients from resurrecting files after re-login, and permits current generation writes', async () => {
    const h = await harness(); try {
      const result = await (await h.clear()).json();
      const login = await (await h.request('/login', undefined, 'POST', { username: 'member', password })).json();
      expect((await h.request('/library', login.token, 'PUT', { baseVersion: result.version, data: { presentations: [{ id: 'old' }] } })).status).toBe(409);
      expect((await h.store.fetch(new Request('https://church.test/freecast/media/old', { method: 'PUT', headers: { Authorization: 'Bearer ' + login.token }, body: 'old' }))).status).toBe(409);
      expect(h.files()).toBe(0);
      expect((await h.request('/library', login.token, 'PUT', { baseVersion: result.version, data: result.data })).status).toBe(200);
      expect((await h.store.fetch(new Request('https://church.test/freecast/media/new', { method: 'PUT', headers: { Authorization: 'Bearer ' + login.token, 'X-Freecast-Reset-Id': result.data.cloudResetId }, body: 'new' }))).status).toBe(200);
    } finally { h.db.close(); }
  });
  it('rejects an old upload whose body finishes arriving after the clear transaction', async () => {
    const h = await harness(); let controller!: ReadableStreamDefaultController<Uint8Array>;
    try {
      const stream = new ReadableStream<Uint8Array>({ start(c) { controller = c; } });
      const pending = h.store.fetch(new Request('https://church.test/freecast/media/late', { method: 'PUT', headers: { Authorization: 'Bearer ' + h.token }, body: stream, duplex: 'half' } as RequestInit));
      expect((await h.clear()).status).toBe(200);
      controller.enqueue(new Uint8Array([1])); controller.close();
      expect((await pending).status).toBe(401); expect(h.files()).toBe(0);
    } finally { h.db.close(); }
  });
});
