import { REMOTE_ICON } from './remote-icon.js';

const ROOT = '/freecast/remote/';
const ID = /^[A-Za-z0-9_-]{8,64}$/;
const TUNNEL = /^https:\/\/[a-z0-9][a-z0-9-]*\.trycloudflare\.com$/;
const COOKIE = '__Host-freecast-remote';
const iconSvg = '<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512"><rect width="512" height="512" rx="92" fill="#13161e"/><g transform="translate(53 78)"><rect x="0" y="73" width="295" height="283" fill="#4bc789"/><path d="M313 70 407 0V233L313 350Z" fill="#fde718"/><rect x="249" y="129" width="112" height="15" fill="white"/></g></svg>';
const headers = { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff' };
const reply = (body, type, status = 200, extra = {}) => new Response(body, { status, headers: { ...headers, 'content-type': type, ...extra } });
const json = (data, status = 200, extra = {}) => reply(JSON.stringify(data), 'application/json', status, extra);
function selected(request) {
  const value = (request.headers.get('cookie') || '').split(';').map((s) => s.trim()).find((s) => s.startsWith(COOKIE + '='))?.slice(COOKIE.length + 1);
  return value && ID.test(value) ? value : null;
}

const html = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="theme-color" content="#13161e"><meta name="apple-mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-title" content="FreeCast Remote"><meta name="apple-mobile-web-app-status-bar-style" content="black"><meta name="referrer" content="no-referrer"><title>FreeCast Remote</title><link rel="manifest" href="${ROOT}manifest.webmanifest"><link rel="apple-touch-icon" href="${ROOT}icon.png"><link rel="icon" href="${ROOT}icon.png"><link rel="stylesheet" href="${ROOT}style.css"></head><body><header><strong>FreeCast Remote</strong><button id="devices" hidden>컴퓨터 변경</button></header><p id="status" role="status" aria-live="polite"></p><main><section id="setup"><h1>예배 컴퓨터 연결</h1><p>컴퓨터의 FreeCast → 설정 → 인터넷 리모컨에서 QR 코드를 스캔하거나 연결 링크를 붙여 넣으세요.</p><form id="pair"><label>연결 링크 또는 연결 코드<input id="link" required autocomplete="off" autocapitalize="off" spellcheck="false"></label><label>컴퓨터 이름<input id="name" maxlength="60" placeholder="예: 교회 Mac · 방송실 Windows"></label><button type="submit">이 컴퓨터 연결</button></form><div id="saved"></div><h2>iPhone에 설치</h2><p>Safari에서 공유 버튼 → <b>홈 화면에 추가</b>를 선택하세요. 이후 홈 화면의 FreeCast Remote를 열면 됩니다.</p><p>이 웹앱 주소는 고정입니다. 컴퓨터의 터널 주소가 바뀌어도 다시 설치할 필요가 없습니다.</p><button id="install" hidden>리모컨 앱 설치</button><button id="resume" hidden>리모컨으로 돌아가기</button></section><iframe id="remote" title="FreeCast 리모컨" hidden allow="autoplay; fullscreen"></iframe><div id="offline" hidden role="alert">인터넷 연결이 끊겼습니다. 연결되면 자동으로 다시 시도합니다.</div></main><script src="${ROOT}launcher.js" defer></script></body></html>`;

const css = `:root{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#eee;background:#13161e;color-scheme:dark}*{box-sizing:border-box}[hidden]{display:none!important}html,body{margin:0;height:100%;overflow:hidden}body{height:100vh;height:100dvh;display:flex;flex-direction:column;padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)}header{display:flex;align-items:center;justify-content:space-between;padding:6px 12px;gap:12px;flex:none}header strong{font-size:14px}button,input{font:inherit;color:inherit;border:1px solid #444;border-radius:7px;padding:9px;background:#252830}button{cursor:pointer}button:disabled{opacity:.5}#status{margin:0;padding:0 12px;font-size:13px}#status:empty{display:none}main{position:relative;flex:1;min-height:0}#setup{height:100%;overflow:auto;max-width:560px;margin:auto;padding:16px}h1{font-size:22px}h2{font-size:17px;margin-top:28px}p{line-height:1.6;color:#c4c6cc}form,label{display:grid;gap:8px}form{gap:16px;margin:24px 0}input{min-width:0;width:100%;font-size:16px}form button{background:#32875a}#saved{display:flex;flex-wrap:wrap;gap:8px}iframe{width:100%;height:100%;border:0;display:block;background:#13161e}#offline{position:absolute;inset:0;display:grid;place-items:center;text-align:center;padding:28px;background:rgba(19,22,30,.96)}header button{font-size:12px;padding:5px 8px}`;

function launcher() {
  const root = '/freecast/remote/';
  const $ = (id) => document.getElementById(id);
  const frame = $('remote');
  let current = null, pending = false, installedPrompt = null;
  let profiles = [];
  try { profiles = JSON.parse(localStorage.getItem('freecast.remote.computers') || '[]').filter((p) => p && /^[A-Za-z0-9_-]{8,64}$/.test(p.id) && typeof p.name === 'string').slice(0, 20); } catch { /* private mode */ }
  const status = (text) => { $('status').textContent = text; };
  function saved() {
    $('saved').replaceChildren();
    for (const p of profiles) {
      const button = document.createElement('button'); button.textContent = p.name || '저장한 컴퓨터';
      button.addEventListener('click', () => connect(p.id, p.name)); $('saved').append(button);
    }
  }
  function showRemote() {
    if (!current) return;
    $('setup').hidden = true; frame.hidden = false; $('devices').hidden = false;
    $('resume').hidden = false;
    if (!frame.getAttribute('src')) frame.src = root + 'app?view=remote';
    status('');
  }
  async function connect(id, name) {
    if (pending) return;
    pending = true; status('컴퓨터 연결을 확인하고 있습니다…');
    try {
      const res = await fetch(root + 'connect', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id }), cache: 'no-store' });
      if (!res.ok) throw new Error(res.status === 404 ? '등록된 연결을 찾지 못했습니다. 컴퓨터에서 인터넷 리모컨을 켜 주세요.' : '컴퓨터 연결을 확인하지 못했습니다. 잠시 뒤 다시 시도하세요.');
      current = id;
      profiles = [{ id, name: (name || profiles.find((p) => p.id === id)?.name || '예배 컴퓨터').slice(0, 60) }, ...profiles.filter((p) => p.id !== id)].slice(0, 20);
      try { localStorage.setItem('freecast.remote.computers', JSON.stringify(profiles)); } catch { /* cookie still remembers selection */ }
      saved(); frame.removeAttribute('src'); showRemote();
      // Refresh the personalized installation start URL after the device is paired.
      document.querySelector('link[rel="manifest"]').href = root + 'manifest.webmanifest?paired=' + Date.now();
    } catch (e) { status(e.message); $('setup').hidden = false; frame.hidden = true; }
    finally { pending = false; }
  }
  function parse(value) {
    if (/^[A-Za-z0-9_-]{8,64}$/.test(value)) return value;
    const url = new URL(value);
    if (url.origin !== location.origin) throw new Error('FreeCast 설정에 표시된 고정 연결 링크를 입력해 주세요.');
    const id = url.hash.slice(1) || url.pathname.split('/').filter(Boolean).pop();
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(id)) throw new Error('연결 코드를 확인해 주세요.');
    return id;
  }
  $('pair').addEventListener('submit', (e) => { e.preventDefault(); try { connect(parse($('link').value.trim()), $('name').value.trim()); } catch (error) { status(error.message); } });
  $('devices').addEventListener('click', () => { frame.hidden = true; $('setup').hidden = false; status(''); });
  $('resume').addEventListener('click', showRemote);
  let lastLoad = Date.now();
  frame.addEventListener('load', () => { lastLoad = Date.now(); });
  // Recover a shell whose assets failed during a tunnel restart. Live remotes reconnect their socket themselves.
  setInterval(() => {
    if (frame.hidden || !navigator.onLine || document.hidden || Date.now() - lastLoad < 45000) return;
    try { if (frame.contentDocument?.querySelector('.remote-root')) return; } catch { /* retry the trusted local route */ }
    lastLoad = Date.now(); frame.src = root + 'app?view=remote';
  }, 15000);
  function online() { $('offline').hidden = navigator.onLine; }
  window.addEventListener('online', () => { online(); if (!current && !pending && profiles.length) connect(profiles[0].id, profiles[0].name); }); window.addEventListener('offline', online); online(); saved();
  window.addEventListener('beforeinstallprompt', (event) => { event.preventDefault(); installedPrompt = event; $('install').hidden = false; });
  $('install').addEventListener('click', async () => { if (installedPrompt) { await installedPrompt.prompt(); installedPrompt = null; $('install').hidden = true; } });
  if ('serviceWorker' in navigator) navigator.serviceWorker.register(root + 'sw.js', { scope: root }).catch(() => {});
  const incoming = location.hash.slice(1);
  const validIncoming = /^[A-Za-z0-9_-]{8,64}$/.test(incoming);
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  history.replaceState(null, '', root);
  if (validIncoming) $('link').value = incoming;
  if (validIncoming && !standalone) connect(incoming, '');
  else fetch(root + 'session', { cache: 'no-store' }).then(async (r) => {
    if (r.ok) { current = (await r.json()).id; showRemote(); }
    else if (profiles.length) connect(profiles[0].id, profiles[0].name);
    else if (validIncoming) connect(incoming, '');
  }).catch(() => status('인터넷 연결을 확인해 주세요.'));
}
const js = `(${launcher.toString()})();`;
const sw = `const CACHE='freecast-remote-shell-v1',ROOT='${ROOT}',FILES=[ROOT,ROOT+'launcher.js',ROOT+'style.css',ROOT+'icon.png'];self.addEventListener('install',e=>{e.waitUntil(caches.open(CACHE).then(c=>c.addAll(FILES)).then(()=>self.skipWaiting()))});self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k.startsWith('freecast-remote-shell-')&&k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim()))});self.addEventListener('fetch',e=>{const u=new URL(e.request.url);if(e.request.method!=='GET'||u.origin!==self.location.origin||!FILES.includes(u.pathname))return;e.respondWith(fetch(e.request).then(r=>{if(!r.ok)throw Error('offline');const copy=r.clone();e.waitUntil(caches.open(CACHE).then(c=>c.put(u.pathname,copy)));return r}).catch(()=>caches.match(u.pathname).then(r=>r||Response.error())))});`;

const offline = `<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="15"><style>body{background:#13161e;color:#eee;font:16px system-ui;padding:24px;line-height:1.6}</style><h2>컴퓨터에 다시 연결하고 있습니다</h2><p>컴퓨터에서 FreeCast와 인터넷 리모컨을 켜 주세요. 이 화면은 자동으로 다시 연결합니다.</p></html>`;

export async function handleRemoteWebApp(request, env, fetchFn = fetch) {
  const url = new URL(request.url), path = url.pathname;
  if (path === ROOT || path === ROOT.slice(0, -1)) {
    if (request.method !== 'GET') return json({ error: 'method not allowed' }, 405);
    return reply(html, 'text/html; charset=utf-8');
  }
  if (request.method === 'GET') {
    if (path === ROOT + 'style.css') return reply(css, 'text/css; charset=utf-8');
    if (path === ROOT + 'launcher.js') return reply(js, 'text/javascript; charset=utf-8');
    if (path === ROOT + 'sw.js') return reply(sw, 'text/javascript; charset=utf-8', 200, { 'service-worker-allowed': ROOT });
    if (path === ROOT + 'icon.png') return reply(Uint8Array.from(atob(REMOTE_ICON), (c) => c.charCodeAt(0)), 'image/png');
    if (path === ROOT + 'icon.svg') return reply(iconSvg, 'image/svg+xml');
    if (path === ROOT + 'manifest.webmanifest') return json({ id: ROOT, name: 'FreeCast Remote', short_name: 'FreeCast', lang: 'ko', start_url: ROOT + (selected(request) ? '#' + selected(request) : ''), scope: ROOT, display: 'standalone', background_color: '#13161e', theme_color: '#13161e', icons: [{ src: ROOT + 'icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }, { src: ROOT + 'icon.png', sizes: '256x256', type: 'image/png', purpose: 'any' }] }, 200, { 'content-type': 'application/manifest+json' });
    if (path === ROOT + 'session') return selected(request) ? json({ id: selected(request) }) : json({ error: 'not paired' }, 401);
  }
  if (path === ROOT + 'connect') {
    if (request.method !== 'POST') return json({ error: 'method not allowed' }, 405);
    if (request.headers.get('origin') !== url.origin) return json({ error: 'origin not allowed' }, 403);
    const body = await request.json().catch(() => ({}));
    if (typeof body.id !== 'string' || !ID.test(body.id)) return json({ error: 'bad connection code' }, 400);
    const record = await env.REMOTE_LINKS?.get('remote:' + body.id, 'json');
    if (!record || !TUNNEL.test(record.url)) return json({ error: 'not registered' }, 404);
    return json({ ok: true }, 200, { 'set-cookie': `${COOKIE}=${body.id}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=315360000` });
  }
  const app = path === ROOT + 'app';
  const asset = /^\/(assets|backgrounds|templates)\//.test(path) || /^\/(favicon|church-logo-text|media-team-logo)\.png$/.test(path) || path === '/splash.js' || path === '/splash.css';
  const relay = path === '/freecast-ws';
  const media = /^\/remote-media\/[\w.-]{1,100}$/.test(path);
  if (!app && !asset && !relay && !media) return null;
  if (app && url.searchParams.get('view') !== 'remote') return reply(null, 'text/plain', 302, { location: ROOT + 'app?view=remote' });
  const id = selected(request);
  if (!id) return app ? reply(offline, 'text/html; charset=utf-8', 401) : json({ error: 'not paired' }, 401);
  if (request.method !== 'GET') return json({ error: 'method not allowed' }, 405);
  const record = await env.REMOTE_LINKS?.get('remote:' + id, 'json');
  if (!record || !TUNNEL.test(record.url)) return app ? reply(offline, 'text/html; charset=utf-8', 503) : json({ error: 'computer unavailable' }, 503);
  const target = app ? record.url + '/?view=remote' : record.url + path + url.search;
  const forward = new Headers();
  for (const key of ['accept', 'range', 'upgrade', 'connection', 'sec-websocket-key', 'sec-websocket-version', 'sec-websocket-protocol', 'sec-websocket-extensions']) if (request.headers.has(key)) forward.set(key, request.headers.get(key));
  try {
    const response = await fetchFn(target, { method: 'GET', headers: forward, redirect: 'manual', ...(app ? { signal: AbortSignal.timeout(15000) } : {}) });
    if (response.status === 101) return response;
    if (app && !response.ok) return reply(offline, 'text/html; charset=utf-8', 503);
    const out = new Headers(response.headers); out.delete('set-cookie'); out.set('cache-control', 'private, no-store'); out.set('referrer-policy', 'no-referrer');
    return new Response(response.body, { status: response.status, headers: out });
  } catch { return app ? reply(offline, 'text/html; charset=utf-8', 503) : json({ error: 'computer unavailable' }, 503); }
}
