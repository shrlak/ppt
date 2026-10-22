// Manual administration of the church's shared FreeCast library.
// Authenticate through the existing administrator flow; never save credentials.
import { gzipSync } from 'node:zlib';
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { withoutMedia } from './summary-cleanup-helper.mjs';
import { adminPassword } from '../worker/src/config.js';

process.on('uncaughtExceptionMonitor', (error) => console.log(`::error title=FreeCast maintenance failure::${error.message.replaceAll('%', '%25').replaceAll('\n', '%0A').replaceAll('\r', '%0D')}`));

const base = 'https://lyrics-ai-proxy.spencerkim1235.workers.dev/freecast';
const admin = adminPassword(process.env);
const name = `maintenance_${randomBytes(8).toString('hex')}`;
const password = randomBytes(32).toString('base64url');
let token;
let registered = false;
async function request(path, options = {}) {
  const response = await fetch(`${base}/${path}`, {
    ...options,
    headers: { Origin: 'https://shrlak.github.io', 'Content-Type': 'application/json', ...options.headers },
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) throw new Error(`FreeCast ${path.split('/')[0]} HTTP ${response.status}: ${String((await response.json().catch(() => ({}))).error ?? 'request failed').slice(0, 200)}`);
  return response.json();
}
try {
  await request('register', { method: 'POST', body: JSON.stringify({ username: name, password, adminPassword: admin }) });
  registered = true;
  token = (await request('login', { method: 'POST', body: JSON.stringify({ username: name, password }) })).token;
  if (!token) throw new Error('Missing maintenance session');
  const headers = { Authorization: `Bearer ${token}` };
  const [library, media, storage] = await Promise.all([
    request('library', { headers }), request('media', { headers }), request('storage', { headers }),
  ]);
  const normalize = (name) => String(name).normalize('NFC').replace(/[_\s]/g, '');
  const ids = library.data.media.filter((m) => normalize(m.name).includes('주의이름을부르는자요약')).map((m) => m.id);
  if (!ids.length) throw new Error('No matching summary media found');
  for (const p of library.data.presentations.filter((p) => p.online || p.folder === 'Songs')) if (ids.some((id) => JSON.stringify(p).includes(id))) throw new Error('Summary media also used by a song library; refusing to alter songs');
  const cleaned = withoutMedia(library.data, ids);
  const saved = await request('library', { method: 'PUT', headers, body: JSON.stringify({ baseVersion: library.version, data: cleaned }) });
  if (saved.conflict || saved.version !== library.version + 1) throw new Error('Concurrent edit; no blobs deleted');
  for (const id of ids) await request(`media/${encodeURIComponent(id)}`, { method: 'DELETE', headers });
  const [after, usage] = await Promise.all([request('media', { headers }), request('storage', { headers })]);
  if (after.items.some((m) => ids.includes(m.id))) throw new Error('Summary files remain');
  const songsBefore = library.data.presentations.filter((p) => p.online || p.folder === 'Songs');
  const finalLibrary = await request('library', { headers });
  const songsAfter = finalLibrary.data.presentations.filter((p) => p.online || p.folder === 'Songs');
  if (JSON.stringify(songsBefore) !== JSON.stringify(songsAfter)) throw new Error('Song library verification failed');
  console.log(`::notice title=Summary cleanup result::${JSON.stringify({ deletedCount: ids.length, deletedBytes: media.items.filter((m) => ids.includes(m.id)).reduce((n, m) => n + m.size, 0), remainingCount: after.items.length, remainingMediaBytes: usage.mediaBytes, songsPreserved: songsAfter.length })}`);
  await mkdir('maintenance-output', { recursive: true });
  await writeFile('maintenance-output/inventory.json', JSON.stringify({ library, media, storage }, null, 2));

} finally {
  // Revoke the session before deleting the temporary administrator-created account.
  try { if (token) await request('logout', { method: 'POST', headers: { Authorization: `Bearer ${token}` } }); }
  finally { if (registered) await request(`users/${encodeURIComponent(name)}`, { method: 'DELETE', headers: { 'X-Admin-Password': admin } }); }
}
