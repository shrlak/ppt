// Turn the hand-verified corpus ground truth into a manifest the benchmark
// runner understands, so real scanned 악보 can be scored by exactly the same
// code path as the synthetic pages.
//
//   node bench/corpus/build-manifest.mjs [--out bench/real] [--pages bench/corpus/pages]
//
// Entries whose image has not been fetched are skipped with a warning rather
// than failing the run — a partial corpus still measures something useful.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .map((arg, i, all) => (arg.startsWith('--') ? [arg.slice(2), all[i + 1]] : []))
    .filter((pair) => pair.length),
);
const OUT = args.out ?? 'bench/real';
const PAGES = args.pages ?? 'bench/corpus/pages';

const truth = JSON.parse(readFileSync('bench/corpus/truth.json', 'utf8'));

mkdirSync(OUT, { recursive: true });
const manifest = [];
for (const song of truth) {
  const image = join(PAGES, song.file);
  if (!existsSync(image)) {
    console.warn(`skipping ${song.title} — ${image} not fetched`);
    continue;
  }
  manifest.push({
    index: manifest.length,
    // run-bench resolves `file` against BENCH_OUT, so point back at the corpus.
    file: relative(OUT, image),
    title: song.title,
    key: song.key ?? '',
    order: song.order,
    sections: song.sections.map((section) => ({
      label: section.label,
      lines: section.lines.map((line) => line.trim()).filter(Boolean),
    })),
  });
}

writeFileSync(join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(`wrote ${manifest.length}/${truth.length} songs to ${join(OUT, 'manifest.json')}`);
