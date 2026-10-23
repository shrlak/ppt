// Exercise the browser script after the same keepNames transform used by Wrangler.
// Pairing requests are mocked: this never connects to or controls a church computer.
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

export async function checkRemoteLauncher(script, resumeMissing = false) {
  const elements = new Map();
  const element = (id) => {
    if (!elements.has(id)) elements.set(id, {
      hidden: false, value: '', textContent: '', events: {},
      addEventListener(type, listener) { this.events[type] = listener; },
      getAttribute(key) { return this[key]; },
      removeAttribute(key) { delete this[key]; },
      append() {}, replaceChildren() {},
    });
    return elements.get(id);
  };
  let paired = null, selected = null, allowCookie = true;
  const listeners = {};
  const requests = [];
  const saved = new Map();
  if (resumeMissing) {
    selected = 'removed-computer123';
    saved.set('freecast.remote.computers', JSON.stringify([{ id: selected, name: 'Old computer' }]));
  }
  const context = {
    document: { documentElement: { dataset: {} }, getElementById: element, createElement: () => ({ addEventListener() {} }), querySelector: () => ({}), addEventListener() {} },
    localStorage: { getItem: (key) => saved.get(key) ?? null, setItem: (key, value) => saved.set(key, value) },
    navigator: { onLine: true, standalone: resumeMissing }, window: { addEventListener(type, listener) { listeners[type] = listener; } },
    history: { replaceState() {} }, location: { hash: resumeMissing ? '#test-computer12345' : '', origin: 'https://remote.example' },
    matchMedia: () => ({ matches: false }), setInterval() {}, setTimeout, clearTimeout, AbortController, URL,
    fetch: async (path, options) => {
      requests.push(path);
      if (path === '/freecast/remote/session') return { ok: !!selected && selected !== 'removed-computer123', json: async () => ({ id: selected }) };
      assert.equal(path, '/freecast/remote/connect');
      assert.equal(options.method, 'POST');
      paired = JSON.parse(options.body);
      if (paired.id === 'removed-computer123') return { ok: false, status: 404 };
      if (allowCookie) selected = paired.id;
      return { ok: true };
    },
  };
  vm.runInNewContext(script, context, { timeout: 1000 });
  listeners.pageshow?.();
  await new Promise((resolve) => setImmediate(resolve));
  if (resumeMissing) assert.equal(selected, 'test-computer12345', 'Initial pageshow must not interrupt restoration of a valid installation link');
  assert.equal(context.document.documentElement.dataset.remoteAppearance, 'dark');
  element('appearance').events.click();
  assert.equal(context.document.documentElement.dataset.remoteAppearance, 'light');
  assert.equal(saved.get('freecast.remote.appearance'), 'light');
  element('appearance').events.click();
  assert.equal(context.document.documentElement.dataset.remoteAppearance, 'dark');
  element('link').value = 'test-computer12345';
  element('name').value = 'Test computer';
  assert.equal(typeof element('pair').events.submit, 'function', 'Connection button was never initialized');
  element('pair').events.submit({ preventDefault() {} });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(paired?.id, 'test-computer12345');
  assert.equal(element('setup').hidden, true, element('status').textContent);
  assert.equal(element('remote').hidden, false);
  assert.equal(element('remote').src, '/freecast/remote/app?view=remote');
  // Reproduce iOS retaining a saved computer while the HttpOnly cookie disappears.
  selected = null;
  const frame = element('remote');
  frame.contentDocument = { querySelector: () => ({ getAttribute: () => 'not-paired' }) };
  frame.events.load();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(selected, 'test-computer12345', 'An expired cookie was never repaired');
  assert.equal(frame.hidden, false);
  assert.equal(element('setup').hidden, true);
  assert.equal(paired.id, 'test-computer12345', 'Recovery must keep the permanent computer ID');
  const count = requests.length;
  frame.contentDocument = { querySelector: () => ({ getAttribute: () => 'not-registered' }) };
  frame.events.load();
  assert.equal(element('setup').hidden, false);
  assert.match(element('status').textContent, /R02/);
  assert.equal(requests.length, count, 'Removed links must show pairing instead of looping');
  // A browser that refuses cookies must get a useful error, not another failed iframe.
  selected = null; allowCookie = false;
  element('pair').events.submit({ preventDefault() {} });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(element('setup').hidden, false);
  assert.equal(frame.hidden, true);
  assert.match(element('status').textContent, /R01/);
  assert.equal(typeof listeners.message, 'function');
}

if (process.argv.includes('--live')) {
  const response = await fetch('https://lyrics-ai-proxy.spencerkim1235.workers.dev/freecast/remote/launcher.js', { signal: AbortSignal.timeout(15000), cache: 'no-store' });
  assert.equal(response.status, 200);
  const script = await response.text();
  await checkRemoteLauncher(script);
  await checkRemoteLauncher(script, true);
  console.log('::notice title=Remote launcher::PASS deployed browser script initializes its connection button and opens the remote');
} else {
  for (const minify of [false, true]) {
    const result = await build({ entryPoints: [fileURLToPath(new URL('../src/remote-web-app.js', import.meta.url))], bundle: true, format: 'esm', platform: 'browser', keepNames: true, minify, write: false });
    const module = await import('data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].text).toString('base64'));
    const response = await module.handleRemoteWebApp(new Request('https://remote.example/freecast/remote/launcher.js'), {});
    const script = await response.text();
    await checkRemoteLauncher(script);
    await checkRemoteLauncher(script, true);
    console.log(`PASS Wrangler keepNames browser script${minify ? ' with minification' : ''}`);
  }
}
