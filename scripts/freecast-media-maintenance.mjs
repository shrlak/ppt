// Manual administration of the church's shared FreeCast library.
// Authenticate through the existing administrator flow; never save credentials.
import { gzipSync } from 'node:zlib';
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { planCleanup, withoutMedia } from './freecast-media-cleanup.mjs';
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
  const plan = planCleanup(library, media.items);
  const cleaned = withoutMedia(library.data, plan.remove);
  for (const id of plan.protectedPresentationIds) {
    if (JSON.stringify(cleaned.presentations.find((p) => p.id === id)) !== JSON.stringify(library.data.presentations.find((p) => p.id === id))) throw new Error('Protected service changed during planning');
  }
  console.log(`::notice title=FreeCast cleanup plan::${JSON.stringify({ ...plan, remove: plan.remove.length, keep: plan.keep.map((id) => ({ id, name: library.data.media.find((m) => m.id === id)?.name ?? id })) })}`);
  const expected = process.env.APPLY_FINGERPRINT || '';
  if (expected) {
    if (expected !== plan.fingerprint) throw new Error('Inventory changed since review; refusing deletion');
    const entry = { id: randomBytes(16).toString('hex'), at: Date.now(), action: 'media/remove', detail: `1025 주일예배·필수 미디어 보존, 나머지 ${plan.remove.length}개 삭제`, device: { id: 'church-cloud-maintenance', name: '교회 클라우드 관리', userName: '', platform: 'server' }, account: 'administrator' };
    cleaned.activity = [...(cleaned.activity ?? []), entry].slice(-2000);
    cleaned.lastModified = entry;
    // Optimistic version check occurs on the server before changing metadata.
    const saved = await request('library', { method: 'PUT', headers, body: JSON.stringify({ baseVersion: library.version, data: cleaned }) });
    if (saved.conflict || saved.version !== library.version + 1) throw new Error('Concurrent library edit; no files deleted');
    let deletedCount = 0;
    for (const id of plan.remove) {
      if (deletedCount % 10 === 0) {
        const latest = await request('library', { headers });
        const livePlan = planCleanup(latest, media.items);
        if (livePlan.keep.some((id) => plan.remove.includes(id))) throw new Error(`A deletion target is now used by the protected service; stopped after ${deletedCount} files`);
      }
      await request(`media/${encodeURIComponent(id)}`, { method: 'DELETE', headers });
      deletedCount++;
    }
    const [afterLibrary, afterMedia, afterStorage] = await Promise.all([request('library', { headers }), request('media', { headers }), request('storage', { headers })]);
    if (afterMedia.items.some((m) => plan.remove.includes(m.id))) throw new Error('Some deleted media is still present');
    for (const id of plan.keep) {
      const before = media.items.find((m) => m.id === id);
      if (before && !afterMedia.items.some((m) => m.id === id && m.size === before.size)) throw new Error('Protected media verification failed');
    }
    for (const id of plan.protectedPresentationIds) {
      if (!afterLibrary.data.presentations.some((p) => p.id === id)) throw new Error('Protected presentation verification failed');
    }
    const remainingPlan = planCleanup(afterLibrary, afterMedia.items);
    if (remainingPlan.remove.length) throw new Error('Unprotected media reappeared during cleanup');
    const result = { deletedCount, deletedBytes: plan.bytesToDelete, remainingMediaCount: afterMedia.items.length, remainingMediaBytes: afterStorage.mediaBytes, beforeDatabaseBytes: storage.freecastBytes, afterDatabaseBytes: afterStorage.freecastBytes, protectedPresentationsVerified: plan.protectedPresentationIds.length, version: afterLibrary.version };
    console.log(`::notice title=FreeCast cleanup result::${JSON.stringify(result)}`);
  }
  await mkdir('maintenance-output', { recursive: true });
  await writeFile('maintenance-output/inventory.json', JSON.stringify({ library, media, storage }, null, 2));
  const report = { version: library.version, playlists: library.data?.playlists, presentations: library.data?.presentations?.map(({ id, title, folder }) => ({ id, title, folder })), mediaCount: media.items?.length, storedMediaBytes: storage.mediaBytes, files: library.data?.media };
  const reportBytes = gzipSync(Buffer.from(JSON.stringify(report))).toString('base64');
  for (let i = 0; i < reportBytes.length; i += 2000) console.log(`::notice title=FreeCast inventory ${String(i / 2000).padStart(3, '0')}::${reportBytes.slice(i, i + 2000)}`);

} finally {
  // Revoke the session before deleting the temporary administrator-created account.
  try { if (token) await request('logout', { method: 'POST', headers: { Authorization: `Bearer ${token}` } }); }
  finally { if (registered) await request(`users/${encodeURIComponent(name)}`, { method: 'DELETE', headers: { 'X-Admin-Password': admin } }); }
}
