// FreeCast cloud library: accounts, login and one shared church library (presentations,
// themes, playlists… as JSON) plus media files, so FreeCast on any computer can open the same
// slides after signing in. Stored in its own SQLite-backed Durable Object.
//
// Routes (all JSON unless noted):
//   POST   /freecast/register      {username, password, adminPassword}  — admin password = 관리자 설정
//   POST   /freecast/login         {username, password} → {token, username}
//   POST   /freecast/logout        Authorization: Bearer <token>
//   GET    /freecast/me            → {username}
//   GET    /freecast/library       → {version, data, updated, updatedBy}  (?known=<v> → 204 if unchanged)
//   PUT    /freecast/library       {baseVersion, data} → {version} | 409 {version, data, …}
//   GET    /freecast/media         → {items: [{id, type, size, updated}]}
//   PUT    /freecast/media/<id>    raw bytes (Content-Type kept)       ≤ 50 MB
//   GET    /freecast/media/<id>    raw bytes
//   DELETE /freecast/media/<id>
//   GET    /freecast/users         admin: list accounts   DELETE /freecast/users/<name>  admin
import { DurableObject } from 'cloudflare:workers';
import { adminPassword } from './config.js';

const SESSION_DAYS = 90;
const CHUNK = 1024 * 1024;
const MAX_MEDIA = 50 * 1024 * 1024;
const MAX_LIBRARY = 30 * 1024 * 1024;
const PBKDF2_ITERATIONS = 100_000;
const USERNAME = /^[\w가-힣.@-]{2,40}$/;
const MEDIA_ID = /^[\w:-]{1,80}$/;

const enc = new TextEncoder();
const b64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function hashPassword(password, saltB64) {
  const salt = Uint8Array.from(atob(saltB64), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: PBKDF2_ITERATIONS }, key, 256);
  return btoa(String.fromCharCode(...new Uint8Array(bits)));
}

function sameString(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
const fail = (error, status) => json({ error }, status);

export class FreeCastStore extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS users (username TEXT PRIMARY KEY, salt TEXT NOT NULL, hash TEXT NOT NULL, created INTEGER NOT NULL, failed INTEGER NOT NULL DEFAULT 0, locked_until INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, username TEXT NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS library_meta (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL, updated INTEGER NOT NULL, updated_by TEXT, chunks INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS library_chunks (idx INTEGER PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS media_meta (id TEXT PRIMARY KEY, type TEXT NOT NULL, size INTEGER NOT NULL, chunks INTEGER NOT NULL, updated INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS media_chunks (id TEXT NOT NULL, idx INTEGER NOT NULL, data BLOB NOT NULL, PRIMARY KEY (id, idx));
    `);
  }

  one(query, ...args) {
    return this.sql.exec(query, ...args).toArray()[0] ?? null;
  }

  sessionUser(request) {
    const token = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
    if (!token) return null;
    const row = this.one('SELECT username, expires FROM sessions WHERE token = ?', token);
    if (!row || row.expires < Date.now()) return null;
    return row.username;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/^\/freecast/, '');
    const method = request.method;
    try {
      if (path === '/register' && method === 'POST') return await this.register(request);
      if (path === '/login' && method === 'POST') return await this.login(request);
      if (path === '/users' && method === 'GET') {
        if (request.headers.get('x-fc-admin') !== '1') return fail('관리자 비밀번호가 필요합니다.', 403);
        return json({ users: this.sql.exec('SELECT username, created FROM users ORDER BY username').toArray() });
      }
      const delUser = path.match(/^\/users\/(.+)$/);
      if (delUser && method === 'DELETE') {
        if (request.headers.get('x-fc-admin') !== '1') return fail('관리자 비밀번호가 필요합니다.', 403);
        const name = decodeURIComponent(delUser[1]);
        this.sql.exec('DELETE FROM users WHERE username = ?', name);
        this.sql.exec('DELETE FROM sessions WHERE username = ?', name);
        return json({ ok: true });
      }

      const user = this.sessionUser(request);
      if (!user) return fail('로그인이 필요합니다.', 401);
      if (path === '/me') return json({ username: user });
      if (path === '/logout' && method === 'POST') {
        this.sql.exec('DELETE FROM sessions WHERE token = ?', (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, ''));
        return json({ ok: true });
      }
      if (path === '/library' && method === 'GET') return this.getLibrary(url);
      if (path === '/library' && method === 'PUT') return await this.putLibrary(request, user);
      if (path === '/media' && method === 'GET') {
        return json({ items: this.sql.exec('SELECT id, type, size, updated FROM media_meta ORDER BY updated').toArray() });
      }
      const media = path.match(/^\/media\/([^/]+)$/);
      if (media) {
        const id = decodeURIComponent(media[1]);
        if (!MEDIA_ID.test(id)) return fail('bad media id', 400);
        if (method === 'GET') return this.getMedia(id);
        if (method === 'PUT') return await this.putMedia(id, request);
        if (method === 'DELETE') {
          this.sql.exec('DELETE FROM media_chunks WHERE id = ?', id);
          this.sql.exec('DELETE FROM media_meta WHERE id = ?', id);
          return json({ ok: true });
        }
      }
      return fail('not found', 404);
    } catch (e) {
      return fail(e?.message || 'server error', 500);
    }
  }

  async register(request) {
    if (request.headers.get('x-fc-admin') !== '1') return fail('관리자 비밀번호가 올바르지 않습니다.', 403);
    const { username, password } = await request.json();
    const name = String(username ?? '').trim();
    if (!USERNAME.test(name)) return fail('아이디는 2–40자의 글자·숫자·._-@ 만 쓸 수 있습니다.', 400);
    if (typeof password !== 'string' || password.length < 6) return fail('비밀번호는 6자 이상이어야 합니다.', 400);
    const salt = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));
    const hash = await hashPassword(password, salt);
    this.sql.exec(
      'INSERT INTO users (username, salt, hash, created) VALUES (?, ?, ?, ?) ON CONFLICT(username) DO UPDATE SET salt = excluded.salt, hash = excluded.hash, failed = 0, locked_until = 0',
      name, salt, hash, Date.now(),
    );
    return json({ ok: true, username: name });
  }

  async login(request) {
    const { username, password } = await request.json();
    const name = String(username ?? '').trim();
    const row = this.one('SELECT salt, hash, failed, locked_until FROM users WHERE username = ?', name);
    if (row && row.locked_until > Date.now()) return fail('비밀번호를 여러 번 틀렸습니다. 5분 뒤에 다시 시도하세요.', 429);
    const ok = row && typeof password === 'string' && sameString(await hashPassword(password, row.salt), row.hash);
    if (!ok) {
      if (row) {
        const failed = row.failed + 1;
        this.sql.exec('UPDATE users SET failed = ?, locked_until = ? WHERE username = ?', failed >= 5 ? 0 : failed, failed >= 5 ? Date.now() + 5 * 60_000 : 0, name);
      }
      return fail('아이디 또는 비밀번호가 올바르지 않습니다.', 401);
    }
    this.sql.exec('UPDATE users SET failed = 0, locked_until = 0 WHERE username = ?', name);
    this.sql.exec('DELETE FROM sessions WHERE expires < ?', Date.now());
    const token = b64url(crypto.getRandomValues(new Uint8Array(32)));
    this.sql.exec('INSERT INTO sessions (token, username, expires) VALUES (?, ?, ?)', token, name, Date.now() + SESSION_DAYS * 86_400_000);
    return json({ token, username: name });
  }

  getLibrary(url) {
    const meta = this.one('SELECT version, updated, updated_by, chunks FROM library_meta WHERE id = 1');
    if (!meta) return json({ version: 0, data: null, updated: 0, updatedBy: null });
    if (url.searchParams.get('known') === String(meta.version)) return new Response(null, { status: 204 });
    const text = this.sql.exec('SELECT data FROM library_chunks ORDER BY idx').toArray().map((r) => r.data).join('');
    return json({ version: meta.version, data: JSON.parse(text), updated: meta.updated, updatedBy: meta.updated_by });
  }

  async putLibrary(request, user) {
    const raw = await request.text();
    if (raw.length > MAX_LIBRARY) return fail('라이브러리가 너무 큽니다.', 413);
    const { baseVersion, data } = JSON.parse(raw);
    if (!data || typeof data !== 'object') return fail('data required', 400);
    const meta = this.one('SELECT version FROM library_meta WHERE id = 1');
    const current = meta?.version ?? 0;
    if (Number(baseVersion) !== current) {
      // Someone else saved first: hand back the newer library so the app can merge and retry.
      const latest = this.getLibrary(new URL('https://x/'));
      const body = await latest.json();
      return json({ conflict: true, ...body }, 409);
    }
    const text = JSON.stringify(data);
    const version = current + 1;
    this.ctx.storage.transactionSync(() => {
      this.sql.exec('DELETE FROM library_chunks');
      for (let i = 0; i * CHUNK < text.length; i++) this.sql.exec('INSERT INTO library_chunks (idx, data) VALUES (?, ?)', i, text.slice(i * CHUNK, (i + 1) * CHUNK));
      this.sql.exec(
        'INSERT INTO library_meta (id, version, updated, updated_by, chunks) VALUES (1, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET version = excluded.version, updated = excluded.updated, updated_by = excluded.updated_by, chunks = excluded.chunks',
        version, Date.now(), user, Math.ceil(text.length / CHUNK),
      );
    });
    return json({ version });
  }

  getMedia(id) {
    const meta = this.one('SELECT type, size FROM media_meta WHERE id = ?', id);
    if (!meta) return fail('not found', 404);
    const parts = this.sql.exec('SELECT data FROM media_chunks WHERE id = ? ORDER BY idx', id).toArray().map((r) => new Uint8Array(r.data));
    const out = new Uint8Array(meta.size);
    let off = 0;
    for (const p of parts) {
      out.set(p, off);
      off += p.length;
    }
    return new Response(out, { headers: { 'Content-Type': meta.type, 'Content-Length': String(meta.size) } });
  }

  async putMedia(id, request) {
    const bytes = new Uint8Array(await request.arrayBuffer());
    if (bytes.length > MAX_MEDIA) return fail('파일이 너무 큽니다 (최대 50MB).', 413);
    const type = (request.headers.get('Content-Type') || 'application/octet-stream').slice(0, 100);
    this.ctx.storage.transactionSync(() => {
      this.sql.exec('DELETE FROM media_chunks WHERE id = ?', id);
      for (let i = 0; i * CHUNK < bytes.length; i++) this.sql.exec('INSERT INTO media_chunks (id, idx, data) VALUES (?, ?, ?)', id, i, bytes.slice(i * CHUNK, (i + 1) * CHUNK));
      this.sql.exec(
        'INSERT INTO media_meta (id, type, size, chunks, updated) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET type = excluded.type, size = excluded.size, chunks = excluded.chunks, updated = excluded.updated',
        id, type, bytes.length, Math.ceil(bytes.length / CHUNK), Date.now(),
      );
    });
    return json({ ok: true, size: bytes.length });
  }
}

/**
 * Route /freecast/* to the store. The admin password (관리자 설정) is checked here, in the
 * Worker, and passed on as an internal header the outside world cannot set.
 */
export async function handleFreecast(request, env, headers) {
  const url = new URL(request.url);
  const forward = new Headers(request.headers);
  forward.delete('x-fc-admin');
  let body = ['GET', 'HEAD'].includes(request.method) ? undefined : await request.arrayBuffer();
  const adminBearer = (request.headers.get('X-Admin-Password') || '') === adminPassword(env);
  if (url.pathname === '/freecast/register' && body) {
    let parsed = {};
    try {
      parsed = JSON.parse(new TextDecoder().decode(body));
    } catch {
      // handled by the store
    }
    if (parsed.adminPassword === adminPassword(env)) forward.set('x-fc-admin', '1');
    delete parsed.adminPassword;
    body = enc.encode(JSON.stringify(parsed));
  } else if (adminBearer) {
    forward.set('x-fc-admin', '1');
  }
  const stub = env.FREECAST_STORE.get(env.FREECAST_STORE.idFromName('church'));
  const res = await stub.fetch(new Request(url.toString(), { method: request.method, headers: forward, body }));
  const out = new Headers(res.headers);
  for (const [k, v] of Object.entries(headers)) out.set(k, v);
  return new Response(res.body, { status: res.status, headers: out });
}
