// Fetch the real-악보 corpus listed in sources.json.
//
// The corpus is public CCM 악보 published by two collections (see README.md).
// The image files themselves are NOT committed — they carry their publishers'
// copyright notices, and the repo only needs to be able to get them back. This
// script re-downloads them on demand, so a benchmark run in CI or on a fresh
// clone reproduces the same pages.
//
//   node bench/corpus/fetch-corpus.mjs [--out bench/corpus/pages] [--limit 50]
//                                      [--source ccm4u|naver-dloper] [--only <substring>]
import { mkdirSync, existsSync, statSync, writeFileSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .map((arg, i, all) => (arg.startsWith('--') ? [arg.slice(2), all[i + 1]] : []))
    .filter((pair) => pair.length),
);
const OUT = args.out ?? 'bench/corpus/pages';
const LIMIT = args.limit ? Number(args.limit) : Infinity;
const SOURCE = args.source;
const ONLY = args.only;
const CONCURRENCY = 8;

const sources = JSON.parse(readFileSync('bench/corpus/sources.json', 'utf8'));
// A benchmark run only needs the pages that have verified ground truth — 20 of
// 1,401 — so --truth keeps CI from pulling ~190 MB it will not score.
const truthFiles = args.truth
  ? new Set(JSON.parse(readFileSync('bench/corpus/truth.json', 'utf8')).map((song) => song.file))
  : undefined;
const wanted = sources
  .filter((entry) => (truthFiles ? truthFiles.has(entry.file) : true))
  .filter((entry) => (SOURCE ? entry.source === SOURCE : true))
  .filter((entry) => (ONLY ? entry.stem.includes(ONLY) : true))
  .slice(0, LIMIT);

/** Where a corpus entry's bytes come from. Drive ids resolve to a direct
 * download; the Naver collection already carries a full image URL. */
function entryUrl(entry) {
  return entry.driveId ? `https://drive.google.com/uc?id=${entry.driveId}` : entry.url;
}

async function fetchWithRetry(url, attempts = 4) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      const response = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const bytes = Buffer.from(await response.arrayBuffer());
      // Drive answers an unavailable file with an HTML interstitial, not an image.
      if (!(bytes[0] === 0xff && bytes[1] === 0xd8) && !bytes.subarray(0, 8).includes(0x50)) {
        throw new Error('not an image');
      }
      return bytes;
    } catch (error) {
      if (attempt >= attempts) throw error;
      await new Promise((resolve) => setTimeout(resolve, 2 ** attempt * 1000));
    }
  }
}

let done = 0;
const failures = [];

async function grab(entry) {
  const path = join(OUT, entry.file);
  if (existsSync(path) && statSync(path).size > 2000) return;
  mkdirSync(dirname(path), { recursive: true });
  try {
    writeFileSync(path, await fetchWithRetry(entryUrl(entry)));
  } catch (error) {
    failures.push(`${entry.file}: ${error.message}`);
  } finally {
    done += 1;
    if (done % 100 === 0) console.log(`${done}/${wanted.length}`);
  }
}

const queue = [...wanted];
await Promise.all(
  Array.from({ length: CONCURRENCY }, async () => {
    for (let next = queue.shift(); next; next = queue.shift()) await grab(next);
  }),
);

console.log(`fetched ${wanted.length - failures.length}/${wanted.length} into ${OUT}`);
for (const failure of failures) console.warn(`  failed — ${failure}`);
