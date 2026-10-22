import { describe, expect, it } from 'vitest';
import { FREE_STORAGE_LIMIT_BYTES, measureStorage, storagePlan } from '../../worker/src/storage.js';
import { FreeCastStore } from '../../worker/src/freecast.js';

const sql = (size: number) => ({ databaseSize: size, exec: (query: string) => ({ toArray: () => query.includes('media_meta') ? [{ bytes: 1000, count: 2 }] : [{ bytes: 100 }] }) });
const env = (size: number) => ({ USAGE_TRACKER: { idFromName: (s: string) => s, get: () => ({ storageMetrics: async () => ({ databaseBytes: size }) }) } });
describe('church server storage', () => {
  it('measures both databases including overhead against the decimal 5 GB free account quota', async () => {
    expect(FREE_STORAGE_LIMIT_BYTES).toBe(5_000_000_000);
    const result = await measureStorage(sql(1_000_000_000), env(250_000_000));
    expect(result).toMatchObject({ usedBytes: 1_250_000_000, limitBytes: 5_000_000_000, usedPercent: 25, freecastBytes: 1_000_000_000, sharedBytes: 250_000_000, accountUsageComplete: false });
  });
  it('does not silently treat missing measurements as unused storage', async () => {
    await expect(measureStorage(sql(NaN), env(10))).rejects.toThrow();
    await expect(measureStorage(sql(10), {})).rejects.toThrow();
  });
  it('requires authentication for usage but exposes only the public quota without login', async () => {
    const store = new FreeCastStore({ storage: { sql: sql(100) } }, env(200));
    store.sessionUser = () => null;
    expect((await store.fetch(new Request('https://test/freecast/storage'))).status).toBe(401);
    const plan = await store.fetch(new Request('https://test/freecast/storage-plan'));
    expect(await plan.json()).toEqual(storagePlan());
    store.sessionUser = () => 'member';
    expect(await (await store.fetch(new Request('https://test/freecast/storage'))).json()).toMatchObject({ usedBytes: 300 });
  });
});
