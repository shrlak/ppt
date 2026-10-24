import { describe, expect, it } from 'vitest';
import vm from 'node:vm';
// @ts-expect-error Worker module
import { handleRemoteWebApp } from '../../worker/src/remote-web-app.js';
// @ts-expect-error Worker module
import { handleRemoteLink } from '../../worker/src/remoteLink.js';

const root = '/freecast/team/', origin = 'https://remote.example';
const teamId = 'stage-team-computer', remoteId = 'ordinary-remote-computer';
const cookie = '__Host-freecast-team=' + teamId;
function fixture() {
  const records = new Map<string, { url: string; kind?: string; hash?: string }>([
    ['remote:' + teamId, { url: 'https://one.trycloudflare.com', kind: 'team', hash: 'a'.repeat(64) }],
    ['remote:' + remoteId, { url: 'https://one.trycloudflare.com' }],
  ]);
  return { records, REMOTE_LINKS: { get: async (key: string) => records.get(key) } };
}
const req = (path: string, headers: Record<string, string> = {}) => new Request(origin + path, { headers });

describe('separate permanent team web app', () => {
  it('has its own stable installation identity, private cookie, saved-computer keys, shell cache and pairing address', async () => {
    const page = await handleRemoteWebApp(req(root), {});
    expect(page.status).toBe(200); expect(await page.text()).toContain('FreeCast 무대팀');
    const manifest = await (await handleRemoteWebApp(req(root + 'manifest.webmanifest', { cookie }), {})).json();
    expect(manifest).toMatchObject({ id: root, name: 'FreeCast 무대팀', start_url: root + '#' + teamId, scope: root, display: 'standalone' });
    const script = await (await handleRemoteWebApp(req(root + 'launcher.js'), {})).text();
    expect(() => new vm.Script(script)).not.toThrow();
    expect(script).toContain('freecast.team.computers'); expect(script).toContain('app?view=team'); expect(script).not.toContain('app?view=remote');
    const sw = await handleRemoteWebApp(req(root + 'sw.js'), {});
    expect(sw.headers.get('service-worker-allowed')).toBe(root);
    expect(await sw.text()).toContain('freecast-team-shell-');
  });
  it('rejects ordinary remote codes in the team app and team codes in the control app', async () => {
    const state = fixture();
    const connect = (app: string, id: string) => handleRemoteWebApp(new Request(origin + app + 'connect', { method: 'POST', headers: { origin }, body: JSON.stringify({ id }) }), state);
    expect((await connect(root, remoteId)).status).toBe(404);
    expect((await connect('/freecast/remote/', teamId)).status).toBe(404);
    const paired = await connect(root, teamId);
    expect(paired.status).toBe(200); expect(paired.headers.get('set-cookie')).toContain(cookie + '; Path=/; Secure; HttpOnly; SameSite=Strict;');
    expect((await handleRemoteWebApp(req(root + 'session', { cookie: '__Host-freecast-remote=' + remoteId }), state)).status).toBe(401);
    expect((await handleRemoteWebApp(req('/freecast/remote/session', { cookie: '__Host-freecast-remote=' + teamId }), state)).status).toBe(404);
    expect((await handleRemoteWebApp(req(root + 'connect'), state)).status).toBe(405);
  });
  it('forces the team view, namespaces its assets, and resolves a changed tunnel without changing the fixed address', async () => {
    const state = fixture(), targets: string[] = [];
    expect((await handleRemoteWebApp(req(root + 'app?view=remote', { cookie }), state)).headers.get('location')).toBe(root + 'app?view=team');
    const fetcher = async (target: string) => { targets.push(target); return new Response('<script src="/assets/app.js"></script><link href="/splash.css">'); };
    const page = await handleRemoteWebApp(req(root + 'app?view=team', { cookie }), state, fetcher);
    expect(await page.text()).toContain('src="/freecast/team/assets/app.js"');
    state.records.set('remote:' + teamId, { url: 'https://two.trycloudflare.com', kind: 'team', hash: 'a'.repeat(64) });
    await handleRemoteWebApp(req(root + 'app?view=team', { cookie }), state, fetcher);
    await handleRemoteWebApp(req(root + 'assets/app.js', { cookie }), state, fetcher);
    await handleRemoteWebApp(req(root + 'remote-media/image-id', { cookie }), state, fetcher);
    expect(targets).toEqual(['https://one.trycloudflare.com/?view=team', 'https://two.trycloudflare.com/?view=team', 'https://two.trycloudflare.com/assets/app.js', 'https://two.trycloudflare.com/remote-media/image-id']);
    for (const path of [root + 'api/control/next', root + 'api/cloud/library', root + 'freecast/library']) expect(await handleRemoteWebApp(req(path, { cookie }), state)).toBeNull();
  });
  it('keeps control and team installations independent even when both cookies select different computers', async () => {
    const state = fixture(), targets: string[] = [];
    state.records.set('remote:' + teamId, { url: 'https://two.trycloudflare.com', kind: 'team', hash: 'a'.repeat(64) });
    const both = cookie + '; __Host-freecast-remote=' + remoteId;
    const fetcher = async (target: string) => { targets.push(target); return new Response('ok'); };
    await handleRemoteWebApp(req('/assets/app.js', { cookie: both }), state, fetcher);
    await handleRemoteWebApp(req(root + 'assets/app.js', { cookie: both }), state, fetcher);
    expect(targets).toEqual(['https://one.trycloudflare.com/assets/app.js', 'https://two.trycloudflare.com/assets/app.js']);
  });
  it('keeps stylesheet font and image URLs in the team namespace', async () => {
    const response = await handleRemoteWebApp(req(root + 'assets/app.css', { cookie }), fixture(), async () => new Response('@font-face{src:url(/assets/font.woff2)}.x{background:url("/backgrounds/stars.jpg")}'));
    const css = await response.text();
    expect(css).toContain('url(/freecast/team/assets/font.woff2)');
    expect(css).toContain('url("/freecast/team/backgrounds/stars.jpg")');
  });
  it('binds team WebSockets to the private team capability and refuses cookie-based role escalation', async () => {
    const state = fixture();
    expect((await handleRemoteWebApp(req('/freecast-ws', { cookie: '__Host-freecast-remote=' + teamId }), state)).status).toBe(503);
    expect((await handleRemoteWebApp(req('/freecast-team-ws', { cookie: '__Host-freecast-team=' + remoteId }), state)).status).toBe(503);
    const upgraded = { status: 101, webSocket: {} };
    expect(await handleRemoteWebApp(req('/freecast-team-ws', { cookie, Upgrade: 'websocket', Authorization: 'must-not-forward', 'x-freecast-team-key': 'forged' }), state, async (target: string, init: RequestInit) => {
      expect(target).toBe('https://one.trycloudflare.com/freecast-team-ws');
      const headers = new Headers(init.headers); expect(headers.get('x-freecast-team-key')).toBe('a'.repeat(64)); expect(headers.has('cookie')).toBe(false); expect(headers.has('authorization')).toBe(false);
      return upgraded;
    })).toBe(upgraded);
  });
  it('registers the team role with a hashed secret, preserves it across tunnel changes, and cannot silently change roles', async () => {
    const values = new Map<string, string>();
    const env = { REMOTE_LINKS: { get: async (k: string) => values.has(k) ? JSON.parse(values.get(k)!) : null, put: async (k: string, v: string) => values.set(k, v), delete: async (k: string) => values.delete(k) } };
    const update = (url: string, kind = 'team') => handleRemoteLink(new Request(origin + '/freecast/remote/' + teamId, { method: 'PUT', body: JSON.stringify({ url, kind, secret: 'test-secret-for-the-stage-team' }) }), env);
    expect(await (await update('https://one.trycloudflare.com')).json()).toMatchObject({ ok: true, kind: 'team' });
    const saved = JSON.parse(values.get('remote:' + teamId)!);
    expect(saved.hash).toMatch(/^[a-f0-9]{64}$/); expect(JSON.stringify(saved)).not.toContain('test-secret-for-the-stage-team');
    await update('https://two.trycloudflare.com');
    expect((await handleRemoteLink(req('/freecast/remote/' + teamId), env)).headers.get('location')).toBe(root + '#' + teamId);
    expect((await update('https://three.trycloudflare.com', 'remote')).status).toBe(409);
  });
});
