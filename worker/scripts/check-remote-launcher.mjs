// Exercise the browser script after the same keepNames transform used by Wrangler.
// Pairing requests are mocked: this never connects to or controls a church computer.
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

export async function checkRemoteLauncher(script, resumeMissing = false) {
  const elements = new Map();
  const node = () => ({
    hidden: false, value: '', textContent: '', events: {}, children: [],
    addEventListener(type, listener) { this.events[type] = listener; },
    getAttribute(key) { return this[key]; },
    removeAttribute(key) { delete this[key]; },
    append(...children) { this.children.push(...children); },
    replaceChildren(...children) { this.children = children; },
    focus() {}, select() {},
  });
  const element = (id) => {
    if (!elements.has(id)) elements.set(id, node());
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
    document: { documentElement: { dataset: {} }, getElementById: element, createElement: node, querySelector: () => ({}), addEventListener() {} },
    localStorage: { getItem: (key) => saved.get(key) ?? null, setItem: (key, value) => saved.set(key, value) },
    navigator: { onLine: true, standalone: resumeMissing }, window: { addEventListener(type, listener) { listeners[type] = listener; } },
    history: { replaceState() {} }, location: { hash: resumeMissing ? '#test-computer12345' : '', origin: 'https://remote.example' },
    matchMedia: () => ({ matches: false }), setInterval() {}, setTimeout, clearTimeout, AbortController, URL,
    fetch: async (path, options) => {
      requests.push(path);
      if (path === '/freecast/remote/session') return { ok: !!selected && selected !== 'removed-computer123', json: async () => ({ id: selected }) };
      if (path === '/freecast/remote/forget') {
        assert.equal(options.method, 'POST');
        if (selected === JSON.parse(options.body).id) selected = null;
        return { ok: true };
      }
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
  // Editing keeps the computer capability intact and never starts another connection.
  const beforeEdit = requests.length;
  element('saved').children[0].children[0].children[1].events.click();
  let row = element('saved').children[0];
  const editForm = row.children[0];
  editForm.children[0].children[0].value = '방송실 Mac';
  editForm.events.submit({ preventDefault() {} });
  const edited = JSON.parse(saved.get('freecast.remote.computers'))[0];
  assert.equal(edited.name, '방송실 Mac');
  assert.equal(edited.id, 'test-computer12345');
  assert.equal(requests.length, beforeEdit);
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
  // Cancel is harmless; confirming deletion removes the saved profile and cookie only.
  allowCookie = true; selected = 'test-computer12345';
  element('saved').children[0].children[0].children[2].events.click();
  element('saved').children[0].children[1].children[1].events.click();
  assert.equal(JSON.parse(saved.get('freecast.remote.computers'))[0].id, selected);
  element('saved').children[0].children[0].children[2].events.click();
  await element('saved').children[0].children[1].children[0].events.click();
  assert.equal(selected, null);
  assert.equal(element('remote').src, undefined);
  assert.equal(element('resume').hidden, true);
  assert(!JSON.parse(saved.get('freecast.remote.computers')).some((p) => p.id === 'test-computer12345'));
  assert(JSON.parse(saved.get('freecast.remote.forgottenComputers')).includes('test-computer12345'));
  assert(!requests.some((path) => path === '/freecast/remote/test-computer12345'), 'Deleting a profile must not delete its shared permanent link');
  const beforeOldLink = requests.length;
  context.location.hash = '#test-computer12345'; listeners.hashchange();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requests.length, beforeOldLink, 'An old saved link must not automatically restore a deleted computer');
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
