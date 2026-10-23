import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareDeployment } from '../../worker/scripts/prepare-deploy.mjs';
import worker from '../../worker/src/index.js';

describe('Worker deployment preserves remote links', () => {
  it('resolves the existing namespace across pages, without writing tokens', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'freecast-kv-'));
    try {
      await writeFile(join(directory, 'wrangler.toml'), 'name = "lyrics-ai-proxy"\n');
      let page = 0;
      await prepareDeployment({ account: 'test-account', token: 'test-only-token', directory, fetcher: async () => {
        page++;
        return Response.json({ success: true, result: page === 1 ? Array.from({ length: 100 }, (_, i) => ({ id: String(i), title: `unrelated-${i}` })) : [{ id: 'a'.repeat(32), title: 'REMOTE_LINKS' }] });
      } });
      const config = await readFile(join(directory, '.wrangler.deploy.toml'), 'utf8');
      expect(page).toBe(2); expect(config).toContain('binding = "REMOTE_LINKS"'); expect(config).toContain('a'.repeat(32)); expect(config).not.toContain('test-only-token');
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  it('stops before deploying when the existing namespace cannot be resolved', async () => {
    await expect(prepareDeployment({ account: 'test', token: 'test-only-token', fetcher: async () => Response.json({ success: true, result: [] }) })).rejects.toThrow('existing REMOTE_LINKS');
  });
  it('keeps phone redirects ahead of Origin validation', async () => {
    const env = { REMOTE_LINKS: { get: async () => ({ url: 'https://church-test.trycloudflare.com' }) } };
    const response = await worker.fetch(new Request('https://proxy.test/freecast/remote/test12345'), env);
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/freecast/remote/#test12345');
    const home = await worker.fetch(new Request('https://proxy.test/freecast/remote/'), env);
    expect(home.status).toBe(200);
    expect(await home.text()).toContain('FreeCast Remote');
  });
});
