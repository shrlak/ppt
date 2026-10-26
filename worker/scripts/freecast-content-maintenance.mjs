// Explicit maintenance for this church's FreeCast content only. Never print credentials or file data.
import { randomBytes, createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { adminPassword } from '../src/config.js';
const base = 'https://lyrics-ai-proxy.spencerkim1235.workers.dev';
const mode = process.env.FC_OPERATION || 'inventory';
if (!['inventory', 'clear'].includes(mode)) throw new Error('Unsupported operation');
const admin = adminPassword(process.env), name = `fc-maint-${randomBytes(10).toString('hex')}`, password = randomBytes(32).toString('base64url');
let token, registered = false, report;
async function api(path, options = {}) {
  const response = await fetch(base + '/freecast' + path, { ...options, redirect: 'error', signal: AbortSignal.timeout(30000), headers: {
    Origin: 'https://shrlak.github.io', 'content-type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...options.headers,
  } });
  const data = await response.json();
  if (!response.ok) throw new Error(`${path} returned ${response.status}`);
  return data;
}
async function sharedDigest() {
  const result = {};
  for (const path of ['/libraries/lyrics', '/libraries/ppt']) {
    const response = await fetch(base + path, { headers: { Origin: 'https://shrlak.github.io' }, redirect: 'error', signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error(`Shared library check returned ${response.status}`);
    result[path] = createHash('sha256').update(await response.text()).digest('hex');
  }
  return result;
}
try {
  const usersBefore = (await api('/users', { headers: { 'X-Admin-Password': admin } })).users.map((u) => u.username).sort();
  const sharedBefore = await sharedDigest();
  await api('/register', { method: 'POST', body: JSON.stringify({ username: name, password, adminPassword: admin }) }); registered = true;
  token = (await api('/login', { method: 'POST', body: JSON.stringify({ username: name, password }) })).token;
  const preview = await api('/clear');
  report = { operation: mode, scope: 'FreeCast content only', server: base, before: preview };
  console.log('FreeCast deletion inventory: ' + JSON.stringify(preview));
  if (mode === 'clear') {
    const expectedRevision = process.env.FC_EXPECTED_REVISION;
    // Explicit all-current authorization survives routine sync version changes. The API still
    // receives the revision just read above and rejects any change between preview and clear.
    if (!expectedRevision || (expectedRevision !== 'all-current' && expectedRevision !== preview.revision)) throw new Error('Inventory changed or no reviewed revision provided; nothing deleted');
    const result = await api('/clear', { method: 'POST', body: JSON.stringify({ password, revision: preview.revision }) }); token = result.token;
    const [after, media, library] = await Promise.all([api('/clear'), api('/media'), api('/library')]);
    if (after.mediaCount !== 0 || media.items.length !== 0 || after.presentations !== 0 || after.trash !== 0 || library.data.presentations.length || library.data.media.length || library.data.trash.length || library.data.playlists.some((p) => p.items.length)) throw new Error('Post-clear verification failed');
    const sharedAfter = await sharedDigest();
    const usersAfter = (await api('/users', { headers: { 'X-Admin-Password': admin } })).users.filter((u) => u.username !== name).map((u) => u.username).sort();
    if (usersBefore.some((name) => !usersAfter.includes(name))) throw new Error('Account preservation check failed');
    report = { ...report, after, deletedMediaBytes: preview.mediaBytes, deletedMediaCount: preview.mediaCount,
      sharedLibrariesUnchanged: JSON.stringify(sharedBefore) === JSON.stringify(sharedAfter), accountsPreserved: true };
    console.log('Verified FreeCast content cleared: ' + JSON.stringify({ files: preview.mediaCount, bytes: preview.mediaBytes, remainingFiles: after.mediaCount, remainingPresentations: after.presentations, accountsPreserved: true, sharedLibrariesUnchanged: report.sharedLibrariesUnchanged }));
  }
} finally {
  if (registered) {
    await api('/users/' + encodeURIComponent(name), { method: 'DELETE', headers: { 'X-Admin-Password': admin } });
    const users = (await api('/users', { headers: { 'X-Admin-Password': admin } })).users;
    if (users.some((u) => u.username === name)) throw new Error('Temporary account cleanup failed');
    if (report) report.temporaryAccountRemoved = true;
  }
  if (report) { await mkdir('maintenance-report', { recursive: true }); await writeFile('maintenance-report/freecast-content.json', JSON.stringify(report, null, 2)); }
}
