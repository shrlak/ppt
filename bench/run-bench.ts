// Run the recognition accuracy benchmark: feed the generated score pages
// through the app's real recognition code and score the answers against the
// ground truth manifest.
//
//   GEMINI_API_KEY=... npx vite-node bench/run-bench.ts
//
// Modes:
//   BENCH_MODELS="gemini-2.5-flash,gemini-2.0-flash"  (default) — the app's
//     ensemble path: all listed models read each batch AT ONCE and answers
//     merge per song by priority (recognizeScoreBatchEnsemble).
//   BENCH_MODEL="gemini-2.5-flash" — single-model direct engine call.
//
// Other knobs: BENCH_BATCH (pages per request, default 10), BENCH_COUNT
// (limit songs), BENCH_OUT (default bench/out), BENCH_SEARCH=1 for Google
// Search grounding, BENCH_DIFF_BELOW (print per-section diffs for songs
// under this lyrics score; default 0.98).
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { recognizeBatchWithGemini } from '../src/lib/ai/scoreAi';
import { recognizeScoreBatchEnsemble } from '../src/lib/ai/scoreRecognition';
import { DEFAULT_AI_SETTINGS, type AiSettings, type RecognitionAttempt } from '../src/lib/ai/aiSettings';
import { RecognitionError } from '../src/lib/ai/recognitionError';
import type { ParsedScore } from '../src/lib/ai/scoreParser';
import { normalizeText, scoreSong, summarize, type SongReport, type TruthSong } from './scoring';

const OUT = process.env.BENCH_OUT ?? 'bench/out';
const SINGLE_MODEL = process.env.BENCH_MODEL ?? '';
const MODELS = (process.env.BENCH_MODELS ?? (SINGLE_MODEL || 'gemini-2.5-flash,gemini-2.0-flash'))
  .split(',')
  .map((model) => model.trim())
  .filter(Boolean);
const ENSEMBLE = !SINGLE_MODEL;
const BATCH = Math.max(1, Number(process.env.BENCH_BATCH ?? 10));
const USE_SEARCH = process.env.BENCH_SEARCH === '1';
const DIFF_BELOW = Number(process.env.BENCH_DIFF_BELOW ?? 0.98);
const API_KEY = process.env.GEMINI_API_KEY ?? '';

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function benchSettings(): AiSettings {
  const attempts: RecognitionAttempt[] = MODELS.map((model) => ({ engine: 'gemini', model }));
  return {
    ...DEFAULT_AI_SETTINGS,
    attempts,
    geminiApiKey: API_KEY,
    geminiUseSearch: USE_SEARCH,
  };
}

/**
 * Tell a spent daily budget apart from a burst limit.
 *
 * Both arrive as 429. Waiting out a per-minute limit works; retrying a daily
 * free-tier cap just spends more of a budget that is already gone — which is
 * how one trial burned all 20 of the day's gemini-2.5-flash requests on
 * retries and still measured nothing.
 */
function isDailyQuotaExhausted(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /free_tier_requests|PerDay|per day/i.test(message);
}

/** Set once the day's quota is gone, so the remaining batches don't retry. */
let quotaExhausted = false;

async function recognizeBatch(dataUrls: string[], settings: AiSettings): Promise<ParsedScore[]> {
  let attempt = 0;
  for (;;) {
    try {
      if (ENSEMBLE) {
        // The app's own multi-model path: every listed model reads the batch
        // simultaneously; per-song answers merge by priority.
        return (await recognizeScoreBatchEnsemble(dataUrls, settings, 'full', undefined, MODELS.length)).scores;
      }
      return await recognizeBatchWithGemini(dataUrls, API_KEY, MODELS[0], 'full', USE_SEARCH);
    } catch (error) {
      if (isDailyQuotaExhausted(error)) {
        quotaExhausted = true;
        throw error;
      }
      attempt += 1;
      const status = error instanceof RecognitionError ? error.status : undefined;
      const transient = status === 429 || status === 503 || (status !== undefined && status >= 500) || ENSEMBLE;
      if (!transient || attempt > 4) throw error;
      const wait = attempt * 20_000;
      console.warn(`batch failed (${status ?? 'ensemble'}), retry ${attempt}/4 in ${wait / 1000}s...`);
      await delay(wait);
    }
  }
}

/**
 * Check every requested model actually exists before spending anything.
 *
 * ListModels does not draw on the generate_content quota, so this is a free
 * guard against the failure that wasted a trial: `gemini-2.5-flash-lite` has
 * been retired for new users, and the run only found out one dead batch at a
 * time, after the retries had eaten the day's budget.
 */
async function assertModelsExist(models: string[]): Promise<void> {
  let usable: Set<string>;
  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models?pageSize=200&key=${encodeURIComponent(API_KEY)}`,
    );
    if (!response.ok) {
      console.warn(`preflight: could not list models (HTTP ${response.status}) — continuing anyway`);
      return;
    }
    const payload = (await response.json()) as {
      models?: { name: string; supportedGenerationMethods?: string[] }[];
    };
    usable = new Set(
      (payload.models ?? [])
        .filter((model) => (model.supportedGenerationMethods ?? []).includes('generateContent'))
        .map((model) => model.name.replace(/^models\//, '')),
    );
  } catch (error) {
    console.warn(`preflight: model list unavailable (${String(error)}) — continuing anyway`);
    return;
  }

  console.log(`preflight: ${usable.size} models callable with this key`);
  console.log(`  ${[...usable].sort().join('\n  ')}`);
  const missing = models.filter((model) => !usable.has(model));
  if (missing.length === 0) return;
  console.error(`::error::unknown or unavailable model(s): ${missing.join(', ')}`);
  process.exit(2);
}

/** Compact per-section diff so CI logs show WHAT was misread, not just scores. */
function printDiff(parsed: ParsedScore | undefined, truth: TruthSong): void {
  if (!parsed) return;
  const byLabel = new Map<string, string>();
  for (const section of parsed.sections) {
    const key = section.label.trim().toUpperCase();
    byLabel.set(key, [byLabel.get(key) ?? '', section.lines.join(' ')].join(' ').trim());
  }
  for (const section of truth.sections) {
    const want = normalizeText(section.lines.join(' '));
    const label = section.label.trim().toUpperCase();
    const digitless = !/\d/.test(label);
    const got = normalizeText(
      byLabel.get(label) ?? (digitless ? byLabel.get(`${label}1`) : byLabel.get(label.replace(/\d+$/, ''))) ?? '',
    );
    if (want !== got) {
      console.log(`    [${section.label}] truth: ${want}`);
      console.log(`    [${section.label}] model: ${got || '(없음)'} — parsed labels: ${[...byLabel.keys()].join(',')}`);
    }
  }
}

async function main() {
  if (!API_KEY.trim()) {
    console.error('GEMINI_API_KEY is not set — cannot run the benchmark.');
    process.exit(2);
  }
  await assertModelsExist(MODELS);
  const manifest = JSON.parse(readFileSync(join(OUT, 'manifest.json'), 'utf8')) as TruthSong[];
  const limit = Number(process.env.BENCH_COUNT ?? manifest.length);
  const songs = manifest.slice(0, limit);
  const settings = benchSettings();
  const label = ENSEMBLE ? `ensemble(${MODELS.join('+')})` : MODELS[0];
  console.log(`benchmark: ${songs.length} songs, models=${label}, batch=${BATCH}, search=${USE_SEARCH}`);

  const reports: SongReport[] = [];
  for (let start = 0; start < songs.length; start += BATCH) {
    const group = songs.slice(start, start + BATCH);
    if (quotaExhausted) {
      // Every remaining call would fail the same way. Record the songs as
      // unanswered and stop, so the rest of the budget survives for a re-run.
      for (const truth of group) reports.push(scoreSong(undefined, truth, 'daily quota exhausted'));
      continue;
    }
    const dataUrls = group.map((song) => {
      // Synthetic pages are PNG; the real-악보 corpus is mostly JPEG scans.
      const mime = /\.jpe?g$/i.test(song.file) ? 'image/jpeg' : 'image/png';
      return `data:${mime};base64,${readFileSync(join(OUT, song.file)).toString('base64')}`;
    });
    const startedAt = Date.now();
    try {
      const parsed = await recognizeBatch(dataUrls, settings);
      const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
      group.forEach((truth, i) => {
        const report = scoreSong(parsed[i], truth);
        reports.push(report);
        console.log(
          `#${String(truth.index).padStart(2, '0')} ${report.overall.toFixed(3)} ` +
            `(title ${report.titleScore.toFixed(2)}, order ${report.orderScore.toFixed(2)}, ` +
            `lyrics ${report.lyricsScore.toFixed(2)}) ${truth.title}`,
        );
        if (report.lyricsScore < DIFF_BELOW) printDiff(parsed[i], truth);
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
  const attempted = reports.length;
  const lines = [
    `# Recognition benchmark — ${label}${USE_SEARCH ? ' + search' : ''}`,
    '',
    ...(summary.failed > 0
      ? [
          `> ⚠️ **${summary.failed} of ${attempted} songs never reached a model** (quota, retired model, or`,
          '> provider error) and are excluded from the means below. Compare this trial with others only',
          '> if that count is 0 — a partial trial measures a different set of songs.',
          '',
        ]
      : []),
    `- Songs scored: **${summary.songs}**${summary.failed > 0 ? ` (of ${attempted} attempted)` : ''}`,
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
  writeFileSync(
    join(OUT, 'report.json'),
    JSON.stringify({ models: MODELS, ensemble: ENSEMBLE, useSearch: USE_SEARCH, summary, reports }, null, 2),
  );
  writeFileSync(join(OUT, 'summary.md'), lines.join('\n') + '\n');
  console.log('\n' + lines.join('\n'));
  console.log(`\nMEAN_OVERALL=${(summary.meanOverall * 100).toFixed(2)}`);
  console.log(`BENCH_FAILED=${summary.failed}/${attempted}`);

  // A trial that lost a fifth of its songs is not a measurement. Say so loudly
  // and exit non-zero so it cannot be quoted as a result by mistake; the
  // workflow still publishes the summary and artifacts.
  if (summary.failed > attempted * 0.2) {
    console.error(
      `::error::benchmark inconclusive — ${summary.failed}/${attempted} songs never reached a model. ` +
        'Re-run when the provider quota has reset, one trial at a time.',
    );
    process.exitCode = 3;
  }
}

await main();
