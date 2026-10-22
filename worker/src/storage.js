// https://developers.cloudflare.com/durable-objects/platform/limits/
// Workers Free: 5 GB/account (decimal GB), shared by all SQLite Durable Objects.
export const FREE_STORAGE_LIMIT_BYTES = 5_000_000_000;
export const STORAGE_SOURCE = 'https://developers.cloudflare.com/durable-objects/platform/limits/';
export function storagePlan() {
  return { plan: 'workers-free', limitBytes: FREE_STORAGE_LIMIT_BYTES, limitScope: 'account-durable-objects', source: STORAGE_SOURCE };
}
function bytes(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('Storage measurement is unavailable');
  return value;
}
export async function measureStorage(sql, env) {
  const freecastBytes = bytes(sql.databaseSize);
  if (!env.USAGE_TRACKER) throw new Error('Shared storage measurement is unavailable');
  const tracker = env.USAGE_TRACKER.get(env.USAGE_TRACKER.idFromName('shared-recognition-api-usage'));
  const shared = await tracker.storageMetrics();
  const sharedBytes = bytes(shared.databaseBytes);
  const media = sql.exec('SELECT COALESCE(SUM(size), 0) AS bytes, COUNT(*) AS count FROM media_meta').toArray()[0];
  const library = sql.exec('SELECT COALESCE(SUM(length(CAST(data AS BLOB))), 0) AS bytes FROM library_chunks').toArray()[0];
  const usedBytes = freecastBytes + sharedBytes;
  return {
    ...storagePlan(), scope: 'church-worker-durable-objects', accountUsageComplete: false,
    usedBytes, usedPercent: usedBytes / FREE_STORAGE_LIMIT_BYTES * 100,
    freecastBytes, sharedBytes, mediaBytes: bytes(media.bytes), mediaCount: bytes(media.count), libraryBytes: bytes(library.bytes), checkedAt: Date.now(),
  };
}
