// Permanent installable FreeCast Remote. Deploy with remote-web-app.js and remote-icon.js.
// This handler runs before the church Worker's API Origin checks.
//
// One-time setup (Cloudflare dashboard, free plan):
//   1. Workers & Pages → KV → Create a namespace named REMOTE_LINKS.
//   2. The Worker → Settings → Bindings → Add → KV namespace → variable name REMOTE_LINKS.
//   3. Paste this function into the Worker and call it first thing in fetch(), before any
//      Origin check (phones opening the link send no Origin):
//
//        const link = await handleRemoteLink(request, env);
//        if (link) return link;
//
// Phones install https://<worker>/freecast/remote/ on their home screen. Saved per-computer
// links pair that device without navigating away from the permanent origin. FreeCast (PUT) updates it every time its tunnel connects; <secret>
// is stored only as a hash, so nobody else can re-point or remove the link.

import { handleRemoteWebApp } from './remote-web-app.js';

const ROUTE = /^\/freecast\/remote\/([A-Za-z0-9_-]{8,64})$/;
const TUNNEL = /^https:\/\/[a-z0-9][a-z0-9-]*\.trycloudflare\.com$/;

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

async function sha256(text) {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function handleRemoteLink(request, env) {
  const app = await handleRemoteWebApp(request, env);
  if (app) return app;
  const m = ROUTE.exec(new URL(request.url).pathname);
  if (!m) return null;
  const key = `remote:${m[1]}`;

  if (request.method === 'GET') {
    const rec = await env.REMOTE_LINKS.get(key, 'json');
    if (!rec) return new Response('이 링크는 더 이상 사용할 수 없습니다. FreeCast에서 새 링크를 확인하세요.', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } });
    return new Response(null, { status: 302, headers: { location: `/freecast/${rec.kind === 'team' ? 'team' : 'remote'}/#${m[1]}`, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' } });
  }

  if (request.method !== 'PUT' && request.method !== 'DELETE') return json(405, { error: 'method not allowed' });
  const body = (await request.json().catch(() => ({}))) ?? {};
  if (typeof body.secret !== 'string' || body.secret.length < 16) return json(400, { error: 'secret required' });
  const hash = await sha256(body.secret);
  const rec = await env.REMOTE_LINKS.get(key, 'json');
  if (rec && rec.hash !== hash) return json(403, { error: 'wrong secret' });

  if (request.method === 'DELETE') {
    if (rec) await env.REMOTE_LINKS.delete(key);
    return json(200, { ok: true });
  }
  if (body.kind != null && !['team', 'remote'].includes(body.kind)) return json(400, { error: 'bad link type' });
  const kind = body.kind === 'team' ? 'team' : 'remote';
  // An older Worker may have accepted the first team registration but omitted its kind.
  // The authenticated owner can migrate an untyped record; explicit kinds stay immutable.
  if (rec?.kind && rec.kind !== kind) return json(409, { error: 'link type cannot change' });
  if (typeof body.url !== 'string' || !TUNNEL.test(body.url)) return json(400, { error: 'bad url' });
  await env.REMOTE_LINKS.put(key, JSON.stringify({ hash, url: body.url, at: Date.now(), kind }));
  return json(200, { ok: true, ...(kind === 'team' ? { kind } : {}) });
}
