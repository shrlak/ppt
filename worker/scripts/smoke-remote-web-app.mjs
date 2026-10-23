// Live transport check using a disposable tunnel and link, never a church computer.
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, writeFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import WebSocket, { WebSocketServer } from 'ws';

const base = 'https://lyrics-ai-proxy.spencerkim1235.workers.dev';
const id = 'smoke-' + randomBytes(12).toString('hex');
const secret = randomBytes(24).toString('hex');
const directory = await mkdtemp(join(tmpdir(), 'freecast-remote-probe-'));
const server = http.createServer((_req, res) => res.writeHead(200, { 'content-type': 'text/plain' }).end('freecast-live-proxy-probe'));
const sockets = new WebSocketServer({ server, path: '/freecast-ws' });
sockets.on('connection', (ws) => ws.on('message', (data) => ws.send('echo:' + String(data))));
let tunnel, client, registered = false;
try {
  const api = await fetch('https://api.github.com/repos/cloudflare/cloudflared/releases/latest', {
    headers: { Accept: 'application/vnd.github+json', ...(process.env.GH_TOKEN ? { Authorization: `Bearer ${process.env.GH_TOKEN}` } : {}) }, signal: AbortSignal.timeout(30000),
  });
  if (!api.ok) throw new Error(`Cloudflared release metadata HTTP ${api.status}`);
  const asset = (await api.json()).assets.find((a) => a.name === 'cloudflared-linux-amd64');
  if (!asset || !/^sha256:[a-f0-9]{64}$/.test(asset.digest)) throw new Error('Missing official cloudflared artifact digest');
  const download = await fetch(asset.browser_download_url, { signal: AbortSignal.timeout(120000) });
  if (!download.ok) throw new Error(`Cloudflared download HTTP ${download.status}`);
  const bytes = new Uint8Array(await download.arrayBuffer());
  assert.equal('sha256:' + createHash('sha256').update(bytes).digest('hex'), asset.digest, 'cloudflared checksum mismatch');
  const binary = join(directory, 'cloudflared'); await writeFile(binary, bytes); await chmod(binary, 0o700);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  tunnel = spawn(binary, ['tunnel', '--no-autoupdate', '--protocol', 'http2', '--url', `http://127.0.0.1:${server.address().port}`], { stdio: ['ignore', 'pipe', 'pipe'] });
  const tunnelUrl = await new Promise((resolve, reject) => {
    let output = ''; const timeout = setTimeout(() => reject(new Error('Test tunnel did not connect')), 90000);
    const read = (data) => { output = (output + data).slice(-10000); const match = output.match(/https:\/\/(?!api\.)[a-z0-9][a-z0-9-]*\.trycloudflare\.com/); if (match && output.includes('Registered tunnel connection')) { clearTimeout(timeout); resolve(match[0]); } };
    tunnel.stdout.on('data', read); tunnel.stderr.on('data', read);
    tunnel.on('error', (error) => { clearTimeout(timeout); reject(error); });
    tunnel.on('exit', () => { clearTimeout(timeout); reject(new Error('Test tunnel stopped before registration')); });
  });
  const saved = await fetch(`${base}/freecast/remote/${id}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ secret, url: tunnelUrl }) });
  assert.equal(saved.status, 200, 'test link registration failed'); registered = true;
  // KV can take a short time to become visible from a different edge.
  let paired;
  for (let attempt = 0; attempt < 15; attempt++) {
    paired = await fetch(`${base}/freecast/remote/connect`, { method: 'POST', headers: { Origin: base, 'content-type': 'application/json' }, body: JSON.stringify({ id }) });
    if (paired.ok) break;
    await new Promise((r) => setTimeout(r, 5000));
  }
  assert.equal(paired.status, 200, 'test web app pairing failed');
  const cookie = paired.headers.get('set-cookie')?.split(';')[0]; assert(cookie?.startsWith('__Host-freecast-remote='));
  let app;
  for (let attempt = 0; attempt < 12; attempt++) {
    app = await fetch(`${base}/freecast/remote/app?view=remote`, { headers: { Cookie: cookie }, signal: AbortSignal.timeout(20000) });
    if (app.ok && (await app.text()) === 'freecast-live-proxy-probe') break;
    app = null; await new Promise((r) => setTimeout(r, 5000));
  }
  assert(app, 'live HTTP proxy did not reach the test computer');
  client = new WebSocket(base.replace('https:', 'wss:') + '/freecast-ws', { headers: { Cookie: cookie, Origin: base }, handshakeTimeout: 30000 });
  await once(client, 'open');
  const reply = Promise.race([once(client, 'message'), new Promise((_, reject) => setTimeout(() => reject(new Error('Live WebSocket echo timed out')), 15000))]);
  client.send('remote-control-check');
  assert.equal(String((await reply)[0]), 'echo:remote-control-check');
  console.log('PASS live permanent-origin HTTP and WebSocket relay through a disposable Cloudflare tunnel');
} finally {
  client?.terminate();
  try {
    if (registered) {
      const removed = await fetch(`${base}/freecast/remote/${id}`, { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ secret }), signal: AbortSignal.timeout(30000) });
      if (!removed.ok) process.exitCode = 1;
    }
  } catch { process.exitCode = 1; }
  tunnel?.kill();
  for (const socket of sockets.clients) socket.terminate();
  sockets.close(); server.closeAllConnections(); server.close(); await rm(directory, { recursive: true, force: true });
}
