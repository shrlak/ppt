// Preserve the existing phone-link KV namespace when deploying the repository Worker.
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
export async function prepareDeployment({ account, token, fetcher = fetch, directory = '.' }) {
  if (!account || !token) throw new Error('Cloudflare deployment bindings are missing');
  const namespaces = [];
  for (let page = 1; ; page++) {
    const response = await fetcher(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(account)}/storage/kv/namespaces?per_page=100&page=${page}`, { headers: { Authorization: `Bearer ${token}` } });
    const data = await response.json();
    if (!response.ok || !data.success || !Array.isArray(data.result)) throw new Error(`Cannot read KV namespace metadata (${response.status}); deployment stopped to preserve bindings`);
    namespaces.push(...data.result);
    if (data.result.length < 100 || (data.result_info?.total_pages && page >= data.result_info.total_pages)) break;
  }
  const matching = namespaces.filter((n) => ['REMOTE_LINKS', 'lyrics-ai-proxy-REMOTE_LINKS'].includes(n.title));
  if (matching.length !== 1 || !/^[a-f0-9]{32}$/i.test(matching[0].id)) throw new Error('Expected exactly one existing REMOTE_LINKS namespace; deployment stopped without changing the Worker');
  const original = await readFile(resolve(directory, 'wrangler.toml'), 'utf8');
  await writeFile(resolve(directory, '.wrangler.deploy.toml'), `${original}\n[[kv_namespaces]]\nbinding = "REMOTE_LINKS"\nid = "${matching[0].id}"\n`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await prepareDeployment({ account: process.env.CLOUDFLARE_ACCOUNT_ID, token: process.env.CLOUDFLARE_API_TOKEN });
  console.log('Preserved the existing REMOTE_LINKS namespace binding');
}
