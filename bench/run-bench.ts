// Run the recognition accuracy benchmark: feed the generated score pages
// through the real Gemini engine (the same code path the app uses) and score
// the answers against the ground truth manifest.
//
//   GEMINI_API_KEY=... npx vite-node bench/run-bench.ts
//
// Env knobs: BENCH_MODEL (default gemini-2.5-flash), BENCH_BATCH (pages per
// request, default 10), BENCH_COUNT (limit songs), BENCH_OUT (default
// bench/out), BENCH_SEARCH=1 to enable Google Search grounding.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { recognizeBatchWithGemini } from '../src/lib/ai/scoreAi';
import { RecognitionError } from '../src/lib/ai/recognitionError';
import type { ParsedScore } from '../src/lib/ai/scoreParser';
import { scoreSong, summarize, type SongReport, type TruthSong } from './scoring';

const OUT = process.env.BENCH_OUT ?? 'bench/out';
const MODEL = process.env.BENCH_MODEL ?? 'gemini-2.5-flash';
const BATCH = Math.max(1, Number(process.env.BENCH_BATCH ?? 10));
const USE_SEARCH = process.env.BENCH_SEARCH === '1';
const API_KEY = process.env.GEMINI_API_KEY ?? '';

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function recognizeBatchWithRetry(dataUrls: string[]): Promise<ParsedScore[]> {
  let attempt = 0;
  for (;;) {
    try {
      return await recognizeBatchWithGemini(dataUrls, API_KEY, MODEL, 'full', USE_SEARCH);
    } catch (error) {
      attempt += 1;
      const status = error instanceof RecognitionError ? error.status : undefined;
      const transient = status === 429 || status === 503 || (status !== undefined && status >= 500);
      if (!transient || attempt > 4) throw error;
      const wait = attempt * 20_000;
      console.warn(`batch failed (${status}), retry ${attempt}/4 in ${wait / 1000}s...`);
      await delay(wait);
    }
  }
}

async function main() {
  if (!API_KEY.trim()) {
    console.error('GEMINI_API_KEY is not set — cannot run the benchmark.');
    process.exit(2);
  }
  const manifest = JSON.parse(readFileSync(join(OUT, 'manifest.json'), 'utf8')) as TruthSong[];
  const limit = Number(process.env.BENCH_COUNT ?? manifest.length);
  const songs = manifest.slice(0, limit);
  console.log(`benchmark: ${songs.length} songs, model=${MODEL}, batch=${BATCH}, search=${USE_SEARCH}`);

  const reports: SongReport[] = [];
  for (let start = 0; start < songs.length; start += BATCH) {
    const group = songs.slice(start, start + BATCH);
    const dataUrls = group.map(
      (song) => `data:image/png;base64,${readFileSync(join(OUT, song.file)).toString('base64')}`,
    );
    const startedAt = Date.now();
    try {
      const parsed = await recognizeBatchWithRetry(dataUrls);
      const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
      group.forEach((truth, i) => {
        const report = scoreSong(parsed[i], truth);
        reports.push(report);
        console.log(
          `#${String(truth.index).padStart(2, '0')} ${report.overall.toFixed(3)} ` +
            `(title ${report.titleScore.toFixed(2)}, order ${report.orderScore.toFixed(2)}, ` +
            `lyrics ${report.lyricsScore.toFixed(2)}) ${truth.title}`,
        );
      });
      console.log(`  batch ${start / BATCH + 1} done in ${seconds}s`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`  batch ${start / BATCH + 1} FAILED: ${message}`);
      for (const truth of group) reports.push(scoreSong(undefined, truth, message));
    }
    // Stay well under free-tier RPM.
    await delay(3000);
  }

  const summary = summarize(reports);
  const lines = [
    `# Recognition benchmark — ${MODEL}${USE_SEARCH ? ' + search' : ''}`,
    '',
    `- Songs: **${summary.songs}**`,
    `- Mean overall accuracy: **${(summary.meanOverall * 100).toFixed(1)}%**`,
    `- Mean title: ${(summary.meanTitle * 100).toFixed(1)}% (exact: ${summary.perfectTitles}/${summary.songs})`,
    `- Mean order: ${(summary.meanOrder * 100).toFixed(1)}%`,
    `- Mean lyrics: ${(summary.meanLyrics * 100).toFixed(1)}%`,
    '',
    summary.below90.length
      ? `## Songs below 90%\n${summary.below90
          .map(
            (r) =>
              `- #${r.index} ${r.title}: ${(r.overall * 100).toFixed(1)}%` +
              ` (title ${(r.titleScore * 100).toFixed(0)} / order ${(r.orderScore * 100).toFixed(0)} / lyrics ${(r.lyricsScore * 100).toFixed(0)})${r.error ? ` — ${r.error}` : ''}`,
          )
          .join('\n')}`
      : 'No songs below 90%.',
  ];
  writeFileSync(join(OUT, 'report.json'), JSON.stringify({ model: MODEL, useSearch: USE_SEARCH, summary, reports }, null, 2));
  writeFileSync(join(OUT, 'summary.md'), lines.join('\n') + '\n');
  console.log('\n' + lines.join('\n'));
  console.log(`\nMEAN_OVERALL=${(summary.meanOverall * 100).toFixed(2)}`);
}

await main();
