// Read connection health without logging private connection codes, owner secrets or tunnel URLs.
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const WebSocket = require('ws');
const base = 'https://lyrics-ai-proxy.spencerkim1235.workers.dev';
const account = process.env.CLOUDFLARE_ACCOUNT_ID;
const token = process.env.CLOUDFLARE_API_TOKEN;
async function api(path) {
  const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(account)}/storage/kv/namespaces${path}`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`KV diagnostic API HTTP ${r.status}`);
  return r;
}
const spaces = await (await api('?per_page=100')).json();
const space = spaces.result.filter(n => ['REMOTE_LINKS', 'lyrics-ai-proxy-REMOTE_LINKS'].includes(n.title));
if (space.length !== 1) throw new Error('Expected one remote-link namespace');
const keys = await (await api(`/${space[0].id}/keys?prefix=remote%3A&limit=100`)).json();
console.log(`Checking ${keys.result.length} registered computer links (up to 100)`);
for (const key of keys.result) {
  const id = key.name.slice('remote:'.length);
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(id)) continue;
  const record = await (await api(`/${space[0].id}/values/${encodeURIComponent(key.name)}`)).json();
  const report = { computer: createHash('sha256').update(id).digest('hex').slice(0, 8), registeredMinutesAgo: Math.round((Date.now() - record.at) / 60000) };
  const cookie = `__Host-freecast-remote=${id}`;
  for (const [name, target, headers] of [['tunnelHttp', record.url + '/?view=remote', {}], ['proxyHttp', base + '/freecast/remote/app?view=remote', { Cookie: cookie }]]) {
    try {
      const r = await fetch(target, { headers, redirect: 'manual', signal: AbortSignal.timeout(20000) });
      report[name] = r.status;
      const html = await r.text();
      report[name + 'App'] = html.includes('id="root"');
    } catch { report[name] = 'unreachable'; }
  }
  await new Promise(resolve => {
    let done = false, ws;
    const finish = () => { if (done) return; done = true; clearTimeout(timer); ws?.terminate(); resolve(); };
    const timer = setTimeout(() => { report.relay ??= 'timeout'; finish(); }, 20000);
    ws = new WebSocket(base.replace('https:', 'wss:') + '/freecast-ws', { headers: { Cookie: cookie, Origin: base }, handshakeTimeout: 15000 });
    ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', role: 'remote' })));
    ws.on('message', raw => {
      let m; try { m = JSON.parse(String(raw)); } catch { return; }
      if (m.type === 'welcome') report.relay = 'connected';
      if (m.type === 'host-status') { report.hostConnected = m.connected; finish(); }
      if (m.type === 'error') { report.relay = 'rejected'; finish(); }
    });
    ws.on('unexpected-response', (_request, response) => { report.relay = `HTTP ${response.statusCode}`; response.resume(); finish(); });
    ws.on('error', () => { report.relay ??= 'unreachable'; finish(); });
    ws.on('close', () => { report.relay ??= 'closed'; finish(); });
  });
  console.log(JSON.stringify(report));
  console.log(`::notice title=Remote connection health::${JSON.stringify(report)}`);
}
