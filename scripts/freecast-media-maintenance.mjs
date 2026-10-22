// Manual administration of the church's shared FreeCast library.
// Authenticate through the existing administrator flow; never save credentials.
import { gzipSync } from 'node:zlib';
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { adminPassword } from '../worker/src/config.js';

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
  if (!response.ok) throw new Error(`FreeCast ${path.split('/')[0]} HTTP ${response.status}`);
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
  await mkdir('maintenance-output', { recursive: true });
  await writeFile('maintenance-output/inventory.json', JSON.stringify({ library, media, storage }, null, 2));
  const report = { version: library.version, playlists: library.data?.playlists, presentations: library.data?.presentations?.map(({ id, title, folder }) => ({ id, title, folder })), mediaCount: media.items?.length, storedMediaBytes: storage.mediaBytes, files: library.data?.media };
  const reportBytes = gzipSync(Buffer.from(JSON.stringify(report))).toString('base64');
  for (let i = 0; i < reportBytes.length; i += 2000) console.log(`::notice title=FreeCast inventory ${String(i / 2000).padStart(3, '0')}::${reportBytes.slice(i, i + 2000)}`);

} finally {
  // Revoke the session before deleting the temporary administrator-created account.
  if (token) await request('logout', { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
  if (registered) await request(`users/${encodeURIComponent(name)}`, { method: 'DELETE', headers: { 'X-Admin-Password': admin } });
}
