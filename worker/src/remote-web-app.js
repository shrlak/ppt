import { REMOTE_ICON, REMOTE_ICON_192, REMOTE_ICON_180 } from './remote-icon.js';

const ROOT = '/freecast/remote/';
const ID = /^[A-Za-z0-9_-]{8,64}$/;
const TUNNEL = /^https:\/\/[a-z0-9][a-z0-9-]*\.trycloudflare\.com$/;
const COOKIE = '__Host-freecast-remote';
const iconSvg = '<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512"><image width="512" height="512" href="data:image/png;base64,' + REMOTE_ICON + '"/></svg>';
const headers = { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff' };
const reply = (body, type, status = 200, extra = {}) => new Response(body, { status, headers: { ...headers, 'content-type': type, ...extra } });
const json = (data, status = 200, extra = {}) => reply(JSON.stringify(data), 'application/json', status, extra);
function selected(request) {
  const value = (request.headers.get('cookie') || '').split(';').map((s) => s.trim()).find((s) => s.startsWith(COOKIE + '='))?.slice(COOKIE.length + 1);
  return value && ID.test(value) ? value : null;
}

const html = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="theme-color" content="#13161e"><meta name="apple-mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-title" content="FreeCast Remote"><meta name="apple-mobile-web-app-status-bar-style" content="default"><meta name="referrer" content="no-referrer"><title>FreeCast Remote</title><link rel="manifest" href="${ROOT}manifest.webmanifest"><link rel="apple-touch-icon" sizes="180x180" href="${ROOT}apple-touch-icon.png?v=remote-2"><link rel="icon" type="image/png" href="${ROOT}icon-192.png?v=remote-2"><link rel="stylesheet" href="${ROOT}style.css"></head><body><header><strong>FreeCast Remote</strong><div class="header-actions"><button id="appearance" aria-label="밝은 화면으로 전환">☀ 밝게</button><button id="devices" hidden>컴퓨터 변경</button></div></header><p id="status" role="status" aria-live="polite"></p><main><section id="setup"><h1>예배 컴퓨터 연결</h1><p>컴퓨터의 FreeCast → 설정 → 인터넷 리모컨에서 QR 코드를 스캔하거나 연결 링크를 붙여 넣으세요.</p><form id="pair"><label>연결 링크 또는 연결 코드<input id="link" required autocomplete="off" autocapitalize="off" spellcheck="false"></label><label>컴퓨터 이름<input id="name" maxlength="60" placeholder="예: 교회 Mac · 방송실 Windows"></label><button type="submit">이 컴퓨터 연결</button></form><div id="saved"></div><h2>iPhone에 설치</h2><p>Safari에서 공유 버튼 → <b>홈 화면에 추가</b>를 선택하세요. 이후 홈 화면의 FreeCast Remote를 열면 됩니다.</p><p>이 웹앱 주소는 고정입니다. 컴퓨터의 터널 주소가 바뀌어도 다시 설치할 필요가 없습니다.</p><button id="install" hidden>리모컨 앱 설치</button><button id="resume" hidden>리모컨으로 돌아가기</button></section><iframe id="remote" title="FreeCast 리모컨" hidden allow="autoplay; fullscreen"></iframe><div id="offline" hidden role="alert">인터넷 연결이 끊겼습니다. 연결되면 자동으로 다시 시도합니다.</div></main><script src="${ROOT}launcher.js" defer></script></body></html>`;

const css = `:root{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:var(--text);background:var(--bg);color-scheme:dark;--bg:#13161e;--text:#eee;--muted:#c4c6cc;--control:#252830;--line:#444;--overlay:rgba(19,22,30,.96)}:root[data-remote-appearance="light"]{color-scheme:light;--bg:#f5f6f8;--text:#202b3a;--muted:#566477;--control:#fff;--line:#cbd2dc;--overlay:rgba(245,246,248,.96)}*{box-sizing:border-box}[hidden]{display:none!important}html,body{margin:0;width:100%;height:100%;overflow:hidden;overscroll-behavior:none}body{position:fixed;inset:0;height:100vh;height:100dvh;display:flex;flex-direction:column;padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)}header{position:relative;isolation:isolate;min-height:44px;background:var(--bg);display:flex;align-items:center;justify-content:space-between;padding:6px 12px;gap:12px;flex:none}header strong{font-size:14px;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}button,input{font:inherit;color:inherit;border:1px solid var(--line);border-radius:7px;padding:9px;background:var(--control)}button{cursor:pointer}button:disabled{opacity:.5}#status{margin:0;padding:0 12px;font-size:13px}#status:empty{display:none}main{position:relative;flex:1;min-height:0}#setup{height:100%;overflow:auto;max-width:560px;margin:auto;padding:16px}h1{font-size:22px}h2{font-size:17px;margin-top:28px}p{line-height:1.6;color:var(--muted)}form,label{display:grid;gap:8px}form{gap:16px;margin:24px 0}input{min-width:0;width:100%;font-size:16px}form button{background:#28764d;color:#fff}#saved{display:flex;flex-wrap:wrap;gap:8px}iframe{width:100%;height:100%;border:0;display:block;background:var(--bg)}#offline{position:absolute;inset:0;display:grid;place-items:center;text-align:center;padding:28px;background:var(--overlay)}.header-actions{display:flex;align-items:center;gap:6px;flex:none}header{gap:8px}header button{flex-shrink:0;font-size:12px;padding:5px 8px}`;

// Keep browser code as source text: bundlers add server-only helpers to function.toString().
const js = String.raw`(function launcher() {
  const root = '/freecast/remote/';
  const $ = (id) => document.getElementById(id);
  const frame = $('remote');
  let appearance = 'dark';
  try { if (localStorage.getItem('freecast.remote.appearance') === 'light') appearance = 'light'; } catch { /* private mode */ }
  function applyAppearance(value) {
    appearance = value === 'light' ? 'light' : 'dark';
    document.documentElement.dataset.remoteAppearance = appearance;
    $('appearance').textContent = appearance === 'dark' ? '☀ 밝게' : '☾ 어둡게';
    $('appearance').ariaLabel = appearance === 'dark' ? '밝은 화면으로 전환' : '어두운 화면으로 전환';
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = appearance === 'light' ? '#f5f6f8' : '#13161e';
    frame.contentWindow?.postMessage({ type: 'freecast:remote-appearance', appearance }, location.origin);
  }
  $('appearance').addEventListener('click', () => {
    applyAppearance(appearance === 'dark' ? 'light' : 'dark');
    try { localStorage.setItem('freecast.remote.appearance', appearance); } catch { /* usable for this session */ }
  });
  window.addEventListener('storage', (e) => { if (e.key === 'freecast.remote.appearance') applyAppearance(e.newValue); });
  frame.addEventListener('load', () => applyAppearance(appearance));
  applyAppearance(appearance);

  let current = null, pending = false, installedPrompt = null, retry = null, repairing = false, booting = true;
  async function request(path, options = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);
    try { return await fetch(root + path, { ...options, credentials: 'same-origin', cache: 'no-store', signal: controller.signal }); }
    finally { clearTimeout(timer); }
  }
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
    clearTimeout(retry); pending = true; status('컴퓨터 연결을 확인하고 있습니다…');
    try {
      const res = await request('connect', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id }) });
      if (res.status === 404) {
        status('저장된 연결 코드가 더 이상 등록되어 있지 않습니다. 컴퓨터의 FreeCast 설정에 표시된 연결 코드를 입력해 주세요. (R02)');
        $('setup').hidden = false; frame.hidden = true; return 'missing';
      }
      if (!res.ok) throw new Error('컴퓨터 연결을 확인하지 못했습니다. 잠시 뒤 다시 시도하세요.');
      const session = await request('session');
      if (!session.ok || (await session.json()).id !== id) throw new Error('휴대폰에 연결 정보를 저장하지 못했습니다. Safari에서 이 링크를 열어 다시 연결해 주세요. (R01)');
      current = id;
      profiles = [{ id, name: (name || profiles.find((p) => p.id === id)?.name || '예배 컴퓨터').slice(0, 60) }, ...profiles.filter((p) => p.id !== id)].slice(0, 20);
      try { localStorage.setItem('freecast.remote.computers', JSON.stringify(profiles)); } catch { /* cookie still remembers selection */ }
      saved(); frame.removeAttribute('src'); showRemote();
      // Refresh the personalized installation start URL after the device is paired.
      document.querySelector('link[rel="manifest"]').href = root + 'manifest.webmanifest?paired=' + Date.now();
      return true;
    } catch (e) { status(e.name === 'AbortError' ? '서버 응답이 늦어 연결을 중단했습니다. 인터넷 연결을 확인하고 다시 시도하세요. (R04)' : e.message); $('setup').hidden = false; frame.hidden = true; }
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
  function chooseComputer() { clearTimeout(retry); frame.hidden = true; $('setup').hidden = false; status(''); }
  $('devices').addEventListener('click', chooseComputer);
  $('resume').addEventListener('click', showRemote);
  let lastLoad = Date.now();
  function ready() {
    try { return !!frame.contentDocument?.querySelector('.remote-root'); } catch { return false; }
  }
  async function recover() {
    if (pending || repairing || frame.hidden || !navigator.onLine || document.hidden) return;
    repairing = true;
    try {
      const session = await request('session');
      const selected = session.ok ? (await session.json()).id : null;
      // iOS may discard a standalone app's cookie while keeping its saved computer.
      // Re-pair that computer instead of refreshing the same unauthorized iframe forever.
      if (!selected || (current && selected !== current)) {
        const profile = profiles.find((p) => p.id === current) || profiles[0];
        const id = current || profile?.id;
        if (id) await connect(id, profile?.name || '');
        else { chooseComputer(); status('연결 코드를 다시 입력해 주세요. (R01)'); }
      } else {
        current = selected;
        lastLoad = Date.now();
        frame.src = root + 'app?view=remote&retry=' + lastLoad;
      }
    } catch { status('인터넷 연결을 확인하고 다시 시도해 주세요. (R04)'); }
    finally { repairing = false; }
  }
  function unavailable(reason) {
    if (frame.hidden) return;
    clearTimeout(retry);
    if (reason === 'not-paired') { recover(); return; }
    if (reason === 'not-registered') {
      chooseComputer(); status('저장된 연결 코드가 더 이상 등록되어 있지 않습니다. 컴퓨터의 FreeCast 설정에 표시된 연결 코드를 입력해 주세요. (R02)'); return;
    }
    retry = setTimeout(recover, 15000);
  }
  window.addEventListener('message', (event) => {
    if (event.origin !== location.origin || event.source !== frame.contentWindow) return;
    if (event.data?.type === 'freecast:remote-unavailable') unavailable(event.data.reason);
    if (event.data?.type === 'freecast:remote-retry') recover();
    if (event.data?.type === 'freecast:remote-choose') chooseComputer();
  });
  frame.addEventListener('load', () => {
    lastLoad = Date.now();
    try {
      const reason = frame.contentDocument?.querySelector('[data-remote-error]')?.getAttribute('data-remote-error');
      if (reason) unavailable(reason);
      else if (ready()) { clearTimeout(retry); status(''); }
    } catch { /* the watchdog retries only the trusted route */ }
  });
  // Recover failed assets as well as HTTP errors. A live remote owns its socket reconnects.
  setInterval(() => {
    if (Date.now() - lastLoad >= 45000 && !ready()) recover();
  }, 15000);
  function online() { $('offline').hidden = navigator.onLine; }
  function resume() {
    if (booting || !navigator.onLine || document.hidden) return;
    if (!current && !pending && profiles.length) connect(profiles[0].id, profiles[0].name);
    else if (!ready()) recover();
  }
  window.addEventListener('online', () => { online(); resume(); });
  window.addEventListener('offline', online);
  window.addEventListener('pageshow', resume);
  document.addEventListener('visibilitychange', resume);
  online(); saved();
  window.addEventListener('beforeinstallprompt', (event) => { event.preventDefault(); installedPrompt = event; $('install').hidden = false; });
  $('install').addEventListener('click', async () => { if (installedPrompt) { await installedPrompt.prompt(); installedPrompt = null; $('install').hidden = true; } });
  if ('serviceWorker' in navigator) navigator.serviceWorker.register(root + 'sw.js', { scope: root }).catch(() => {});
  const incoming = location.hash.slice(1);
  const validIncoming = /^[A-Za-z0-9_-]{8,64}$/.test(incoming);
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  window.addEventListener('hashchange', () => {
    const value = location.hash.slice(1); history.replaceState(null, '', root);
    if (!standalone && /^[A-Za-z0-9_-]{8,64}$/.test(value)) { $('link').value = value; connect(value, ''); }
  });
  history.replaceState(null, '', root);
  if (validIncoming) $('link').value = incoming;
  if (validIncoming && !standalone) connect(incoming, '').finally(() => { booting = false; });
  else request('session').then(async (r) => {
    if (r.ok) { current = (await r.json()).id; showRemote(); }
    else {
      const candidates = [...profiles];
      if (validIncoming && !candidates.some((p) => p.id === incoming)) candidates.push({ id: incoming, name: '' });
      for (const candidate of candidates) {
        if (await connect(candidate.id, candidate.name) !== 'missing') break;
      }
    }
  }).catch(() => status('인터넷 연결을 확인해 주세요.')).finally(() => { booting = false; });
})();`;
const sw = `const CACHE='freecast-remote-shell-v6',ROOT='${ROOT}',FILES=[ROOT,ROOT+'launcher.js',ROOT+'style.css',ROOT+'icon.png',ROOT+'icon-192.png',ROOT+'apple-touch-icon.png'];self.addEventListener('install',e=>{e.waitUntil(caches.open(CACHE).then(c=>c.addAll(FILES)).then(()=>self.skipWaiting()))});self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k.startsWith('freecast-remote-shell-')&&k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim()))});self.addEventListener('fetch',e=>{const u=new URL(e.request.url);if(e.request.method!=='GET'||u.origin!==self.location.origin||!FILES.includes(u.pathname))return;e.respondWith(fetch(e.request).then(r=>{if(!r.ok)throw Error('offline');const copy=r.clone();e.waitUntil(caches.open(CACHE).then(c=>c.put(u.pathname,copy)));return r}).catch(()=>caches.match(u.pathname).then(r=>r||Response.error())))});`;

function offline(reason, detail = '') {
  const messages = {
    'not-paired': ['휴대폰 연결 정보를 복구하고 있습니다', '저장된 컴퓨터로 자동으로 다시 연결합니다. 연결되지 않으면 컴퓨터 변경을 눌러 연결 코드를 다시 입력해 주세요. (R01)'],
    'not-registered': ['연결 코드를 확인해 주세요', '저장된 연결 코드가 더 이상 등록되어 있지 않습니다. 컴퓨터의 FreeCast 설정에 표시된 연결 코드를 다시 입력해 주세요. (R02)'],
    'unreachable': ['컴퓨터에 다시 연결하고 있습니다', '컴퓨터의 FreeCast → 설정에서 인터넷 리모컨이 켜져 있는지 확인해 주세요. 연결이 복구되면 자동으로 돌아갑니다. (R03)'],
  };
  const [title, message] = messages[reason];
  return `<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="30"><style>:root{color-scheme:dark}body{background:#13161e;color:#eee;font:16px system-ui;padding:24px;line-height:1.6}button{font:inherit;padding:12px 18px;margin:8px 8px 8px 0;border:1px solid #666;border-radius:10px;background:#252830;color:inherit}</style><body data-remote-error="${reason}"><h2>${title}</h2><p>${message}</p>${detail ? `<p>${detail}</p>` : ''}<button id="retry">다시 연결</button><button id="choose">컴퓨터 변경</button><script>const notify=(type)=>parent.postMessage({type},location.origin);document.getElementById('retry').onclick=()=>{if(parent===window)location.reload();else notify('freecast:remote-retry')};document.getElementById('choose').onclick=()=>{if(parent===window)location.href='/freecast/remote/';else notify('freecast:remote-choose')};</script></body></html>`;
}

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
    if (path === ROOT + 'icon-192.png') return reply(Uint8Array.from(atob(REMOTE_ICON_192), (c) => c.charCodeAt(0)), 'image/png');
    if (path === ROOT + 'apple-touch-icon.png') return reply(Uint8Array.from(atob(REMOTE_ICON_180), (c) => c.charCodeAt(0)), 'image/png');
    if (path === ROOT + 'icon.svg') return reply(iconSvg, 'image/svg+xml');
    if (path === ROOT + 'manifest.webmanifest') return json({ id: ROOT, name: 'FreeCast Remote', short_name: 'FreeCast', lang: 'ko', start_url: ROOT + (selected(request) ? '#' + selected(request) : ''), scope: ROOT, display: 'standalone', background_color: '#13161e', theme_color: '#13161e', icons: [{ src: ROOT + 'icon.svg?v=remote-2', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }, { src: ROOT + 'icon-192.png?v=remote-2', sizes: '192x192', type: 'image/png', purpose: 'any' }, { src: ROOT + 'icon.png?v=remote-2', sizes: '512x512', type: 'image/png', purpose: 'any' }] }, 200, { 'content-type': 'application/manifest+json' });
    if (path === ROOT + 'session') {
      const id = selected(request);
      if (!id) return json({ error: 'not paired' }, 401);
      const record = await env.REMOTE_LINKS?.get('remote:' + id, 'json');
      return record && TUNNEL.test(record.url) ? json({ id }) : json({ error: 'not registered' }, 404);
    }
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
  if (!id) return app ? reply(offline('not-paired'), 'text/html; charset=utf-8', 401) : json({ error: 'not paired' }, 401);
  if (request.method !== 'GET') return json({ error: 'method not allowed' }, 405);
  const record = await env.REMOTE_LINKS?.get('remote:' + id, 'json');
  if (!record || !TUNNEL.test(record.url)) return app ? reply(offline('not-registered'), 'text/html; charset=utf-8', 503) : json({ error: 'computer unavailable' }, 503);
  const target = app ? record.url + '/?view=remote' : record.url + path + url.search;
  const forward = new Headers();
  for (const key of ['accept', 'range', 'upgrade', 'connection', 'sec-websocket-key', 'sec-websocket-version', 'sec-websocket-protocol', 'sec-websocket-extensions']) if (request.headers.has(key)) forward.set(key, request.headers.get(key));
  try {
    const response = await fetchFn(target, { method: 'GET', headers: forward, redirect: 'manual', ...(app ? { signal: AbortSignal.timeout(15000) } : {}) });
    if (response.status === 101) return response;
    if (app && !response.ok) return reply(offline('unreachable', `컴퓨터 연결 응답: HTTP ${response.status}`), 'text/html; charset=utf-8', 503);
    const out = new Headers(response.headers); out.delete('set-cookie'); out.set('cache-control', 'private, no-store'); out.set('referrer-policy', 'no-referrer');
    return new Response(response.body, { status: response.status, headers: out });
  } catch { return app ? reply(offline('unreachable'), 'text/html; charset=utf-8', 503) : json({ error: 'computer unavailable' }, 503); }
}
