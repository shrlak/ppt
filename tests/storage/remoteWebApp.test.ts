import { describe, expect, it } from 'vitest';
import vm from 'node:vm';
// @ts-expect-error Worker module is plain JavaScript
import { handleRemoteWebApp } from '../../worker/src/remote-web-app.js';
// @ts-expect-error Worker module is plain JavaScript
import { handleRemoteLink } from '../../worker/src/remoteLink.js';

const origin = 'https://remote.example';
const root = '/freecast/remote/';
const id = 'computer12345';
const cookie = `__Host-freecast-remote=${id}`;
const req = (path: string, headers: Record<string, string> = {}) => new Request(origin + path, { headers });
function env() {
  const records = new Map([[`remote:${id}`, { url: 'https://one.trycloudflare.com' }]]);
  return { records, REMOTE_LINKS: { get: async (key: string) => records.get(key) } };
}

describe('permanent remote web app', () => {
  it('serves a stable installable home page without a computer or Origin header', async () => {
    const response = await handleRemoteWebApp(req(root), {});
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('apple-mobile-web-app-capable');
    const manifest = await (await handleRemoteWebApp(req(root + 'manifest.webmanifest'), {})).json();
    expect(manifest).toMatchObject({ id: root, start_url: root, display: 'standalone', scope: root });
    expect(manifest.icons.some((i: { sizes: string }) => i.sizes === 'any')).toBe(true);
    const paired = await (await handleRemoteWebApp(req(root + 'manifest.webmanifest', { cookie }), {})).json();
    expect(paired.start_url).toBe(root + '#' + id);
    expect(paired.id).toBe(manifest.id);
  });
  it('keeps the remote shell installed and retries a disconnected computer promptly', async () => {
    const launcher = await (await handleRemoteWebApp(req(root + 'launcher.js'), {})).text();
    expect(launcher).toContain('retry = setTimeout(recover, 3000)');
    expect(launcher).toContain('Date.now() - lastLoad >= 20000');
    const fallback = await handleRemoteWebApp(req(root + 'app?view=remote', { cookie }), env(), async () => { throw new Error('computer unavailable'); });
    expect(await fallback.text()).toContain('http-equiv="refresh" content="10"');
  });
  it('pairs only from its own origin and keeps the selected capability in a secure private cookie', async () => {
    const pair = (from: string, value: string) => new Request(origin + root + 'connect', { method: 'POST', headers: { origin: from }, body: JSON.stringify({ id: value }) });
    expect((await handleRemoteWebApp(pair('https://other.example', id), env())).status).toBe(403);
    expect((await handleRemoteWebApp(pair(origin, 'https://evil.example'), env())).status).toBe(400);
    expect((await handleRemoteWebApp(pair(origin, 'missing12345'), env())).status).toBe(404);
    const response = await handleRemoteWebApp(pair(origin, id), env());
    expect(response.status).toBe(200);
    expect(response.headers.get('set-cookie')).toContain(`${cookie}; Path=/; Secure; HttpOnly; SameSite=Strict;`);
  });
  it('forgets only this browser selection and preserves shared computer registrations', async () => {
    const state = env();
    const forget = (from: string, value: string) => new Request(origin + root + 'forget', { method: 'POST', headers: { origin: from, cookie }, body: JSON.stringify({ id: value }) });
    expect((await handleRemoteWebApp(forget('https://other.example', id), state)).status).toBe(403);
    expect((await handleRemoteWebApp(forget(origin, 'invalid'), state)).status).toBe(400);
    expect((await handleRemoteWebApp(req(root + 'forget', { cookie }), state)).status).toBe(405);
    expect((await handleRemoteWebApp(forget(origin, 'otherComputer123'), state)).headers.get('set-cookie')).toBeNull();
    const response = await handleRemoteWebApp(forget(origin, id), state);
    expect(response.status).toBe(200);
    expect(response.headers.get('set-cookie')).toContain('__Host-freecast-remote=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0');
    expect(state.records.has('remote:' + id)).toBe(true);
  });
  it('checks that a remembered session still has a registered computer', async () => {
    expect((await handleRemoteWebApp(req(root + 'session'), env())).status).toBe(401);
    const state = env();
    expect(await (await handleRemoteWebApp(req(root + 'session', { cookie }), state)).json()).toEqual({ id });
    state.records.delete('remote:' + id);
    expect((await handleRemoteWebApp(req(root + 'session', { cookie }), state)).status).toBe(404);
  });
  it('distinguishes lost pairing, a removed link and an unreachable computer', async () => {
    const missing = await handleRemoteWebApp(req(root + 'app?view=remote'), env());
    expect(missing.status).toBe(401);
    expect(await missing.text()).toContain('data-remote-error="not-paired"');
    const state = env(); state.records.clear();
    expect(await (await handleRemoteWebApp(req(root + 'app?view=remote', { cookie }), state)).text()).toContain('data-remote-error="not-registered"');
    const unavailable = await handleRemoteWebApp(req(root + 'app?view=remote', { cookie }), env(), async () => new Response('bad gateway', { status: 502 }));
    const html = await unavailable.text();
    expect(html).toContain('data-remote-error="unreachable"');
    expect(html).toContain('HTTP 502');
    expect(html).toContain('다시 연결');
    expect(html).not.toContain('trycloudflare.com');
  });
  it('re-resolves the tunnel while keeping the same public app and WebSocket paths', async () => {
    expect((await handleRemoteWebApp(req(root + 'app?view=operator', { cookie }), env())).headers.get('location')).toBe(root + 'app?view=remote');
    const state = env(); const targets: string[] = [];
    const fetcher = async (target: string) => { targets.push(target); return new Response('<html>remote</html>'); };
    await handleRemoteWebApp(req(root + 'app?view=remote', { cookie }), state, fetcher);
    state.records.set('remote:' + id, { url: 'https://two.trycloudflare.com' });
    await handleRemoteWebApp(req(root + 'app?view=remote', { cookie }), state, fetcher);
    expect(targets).toEqual(['https://one.trycloudflare.com/?view=remote', 'https://two.trycloudflare.com/?view=remote']);
    const upgraded = { status: 101, webSocket: {} };
    expect(await handleRemoteWebApp(req('/freecast-ws', { cookie, Upgrade: 'websocket' }), state, async (target: string) => { expect(target).toBe('https://two.trycloudflare.com/freecast-ws'); return upgraded; })).toBe(upgraded);
  });
  it('never forwards cookies or authorization to a computer and does not proxy console APIs', async () => {
    const state = env();
    for (const path of ['/api/cloud/library', '/api/control/next', '/freecast/library', '/usage']) expect(await handleRemoteWebApp(req(path, { cookie }), state)).toBeNull();
    expect((await handleRemoteWebApp(req('/assets/app.js'), state)).status).toBe(401);
    await handleRemoteWebApp(req('/assets/app.js', { cookie, Authorization: 'private-session' }), state, async (_url: string, init: RequestInit) => {
      const forward = new Headers(init.headers);
      expect(forward.get('cookie')).toBeNull(); expect(forward.get('authorization')).toBeNull();
      return new Response('script', { headers: { 'set-cookie': 'untrusted=1' } });
    }).then((r: Response) => { expect(r.headers.get('set-cookie')).toBeNull(); expect(r.headers.get('cache-control')).toBe('private, no-store'); });
  });
  it('shows an automatic retry page while a computer is stopped without exposing an arbitrary target', async () => {
    const response = await handleRemoteWebApp(req(root + 'app?view=remote', { cookie }), env(), async () => { throw new Error('offline'); });
    expect(response.status).toBe(503); expect(await response.text()).toContain('http-equiv="refresh"');
    const state = env(); state.records.set('remote:' + id, { url: 'https://not-a-tunnel.example' });
    expect((await handleRemoteWebApp(req('/freecast-ws', { cookie }), state)).status).toBe(503);
  });
  it('never caches relay, media, pairing or computer responses in its offline shell', async () => {
    const script = await (await handleRemoteWebApp(req(root + 'sw.js'), {})).text();
    const handlers: Record<string, (e: unknown) => void> = {};
    const context = vm.createContext({ URL, Response, fetch: async () => new Response('shell'), caches: { open: async () => ({ put: async () => undefined }) }, self: { location: { origin }, addEventListener: (name: string, fn: (e: unknown) => void) => { handlers[name] = fn; } } });
    vm.runInContext(script, context);
    for (const path of [root + 'app?view=remote', root + 'connect', root + 'forget', root + 'session', '/freecast-ws', '/remote-media/m_one']) {
      let intercepted = false;
      handlers.fetch({ request: req(path), respondWith: () => { intercepted = true; } });
      expect(intercepted).toBe(false);
    }
    let intercepted: Promise<Response> | undefined;
    handlers.fetch({ request: req(root), respondWith: (p: Promise<Response>) => { intercepted = p; }, waitUntil: () => undefined });
    expect((await intercepted!).status).toBe(200);
  });
  it('keeps registered links without a TTL and leaves their saved address on the stable origin', async () => {
    let options: unknown = 'unset'; let record: unknown = null;
    const state = { REMOTE_LINKS: { get: async () => record, put: async (_key: string, value: string, opts?: unknown) => { record = JSON.parse(value); options = opts; } } };
    await handleRemoteLink(new Request(origin + root + id, { method: 'PUT', body: JSON.stringify({ secret: 'a'.repeat(24), url: 'https://one.trycloudflare.com' }) }), state);
    expect(options).toBeUndefined();
    const saved = await handleRemoteLink(req(root + id), state);
    expect(saved.headers.get('location')).toBe(root + '#' + id);
  });
});
