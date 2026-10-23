// Exercise the browser script after the same keepNames transform used by Wrangler.
// Pairing requests are mocked: this never connects to or controls a church computer.
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

export async function checkRemoteLauncher(script) {
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
  let paired = null;
  const saved = new Map();
  const context = {
    document: { documentElement: { dataset: {} }, getElementById: element, createElement: () => ({ addEventListener() {} }), querySelector: () => ({}) },
    localStorage: { getItem: (key) => saved.get(key) ?? null, setItem: (key, value) => saved.set(key, value) },
    navigator: { onLine: true }, window: { addEventListener() {} },
    history: { replaceState() {} }, location: { hash: '', origin: 'https://remote.example' },
    matchMedia: () => ({ matches: false }), setInterval() {}, URL,
    fetch: async (path, options) => {
      if (path === '/freecast/remote/session') return { ok: false };
      assert.equal(path, '/freecast/remote/connect');
      assert.equal(options.method, 'POST');
      paired = JSON.parse(options.body);
      return { ok: true };
    },
  };
  vm.runInNewContext(script, context, { timeout: 1000 });
  await new Promise((resolve) => setImmediate(resolve));
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
}

if (process.argv.includes('--live')) {
  const response = await fetch('https://lyrics-ai-proxy.spencerkim1235.workers.dev/freecast/remote/launcher.js', { signal: AbortSignal.timeout(15000), cache: 'no-store' });
  assert.equal(response.status, 200);
  await checkRemoteLauncher(await response.text());
  console.log('::notice title=Remote launcher::PASS deployed browser script initializes its connection button and opens the remote');
} else {
  for (const minify of [false, true]) {
    const result = await build({ entryPoints: [fileURLToPath(new URL('../src/remote-web-app.js', import.meta.url))], bundle: true, format: 'esm', platform: 'browser', keepNames: true, minify, write: false });
    const module = await import('data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].text).toString('base64'));
    const response = await module.handleRemoteWebApp(new Request('https://remote.example/freecast/remote/launcher.js'), {});
    await checkRemoteLauncher(await response.text());
    console.log(`PASS Wrangler keepNames browser script${minify ? ' with minification' : ''}`);
  }
}
