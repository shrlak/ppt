import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const partsDirectory = resolve(root, 'assets/pptx/back-slides');
const output = resolve(root, 'public/back-slides.pptx');
const expectedSha256 = '5bc17a3dfb5bf3455fb493b97838e4b6754702903bb85f943eda47ae793acad2';

const partNames = (await readdir(partsDirectory))
  .filter((name) => /^part-\d+\.b64$/.test(name))
  .sort();

if (partNames.length === 0) {
  throw new Error('Back slides asset chunks are missing.');
}

const encoded = (
  await Promise.all(partNames.map((name) => readFile(resolve(partsDirectory, name), 'utf8')))
).join('');
const deck = Buffer.from(encoded, 'base64');
const actualSha256 = createHash('sha256').update(deck).digest('hex');

if (actualSha256 !== expectedSha256) {
  throw new Error(`Back slides checksum mismatch: expected ${expectedSha256}, received ${actualSha256}`);
}
if (deck.subarray(0, 2).toString('ascii') !== 'PK') {
  throw new Error('Back slides output is not an OOXML ZIP package.');
}

await mkdir(dirname(output), { recursive: true });
await writeFile(output, deck);
console.log(`Assembled ${partNames.length} back-slide chunks (${deck.length} bytes).`);
