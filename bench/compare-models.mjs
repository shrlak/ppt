#!/usr/bin/env node
// Decide whether a benchmarked model has actually earned a champion slot.
//
//   node bench/compare-models.mjs bench/results/*.json
//
// Takes the comparison files `npm run bench` writes (bench/out/comparison.json;
// copy the ones worth keeping into bench/results/) and prints a Markdown table
// for the pull request. Exits non-zero when a proposed champion does not
// clear the bar, so a promotion cannot be merged on a hopeful eyeball.
//
// The bar is the same one the runtime applies (see modelReliability.ts): a
// model with three lucky pages is not better than one measured over fifty, and
// a model that fails a fifth of its calls is not usable however well it reads
// the pages it does answer.
import { readFile } from 'node:fs/promises';

/** Evaluations before a result may be quoted as a promotion at all. */
const MIN_SAMPLES = 20;

/** Failure rate above which a model is not usable, whatever it scores. */
const MAX_FAILURE_RATE = 0.2;

/** Lead in conservative score a challenger needs over the sitting champion. */
const PROMOTION_MARGIN = 0.02;

function percent(value) {
  return `${(Number(value ?? 0) * 100).toFixed(1)}%`;
}

async function readTrial(path) {
  const trial = JSON.parse(await readFile(path, 'utf8'));
  return {
    path,
    model: String(trial.model ?? path),
    role: trial.role === 'champion' ? 'champion' : 'challenger',
    samples: Number(trial.samples ?? 0),
    failureRate: Number(trial.failureRate ?? 0),
    title: Number(trial.title ?? 0),
    order: Number(trial.order ?? 0),
    lyrics: Number(trial.lyrics ?? 0),
    overall: Number(trial.overall ?? 0),
    conservative: Number(trial.conservative ?? 0),
  };
}

async function main() {
  const paths = process.argv.slice(2);
  if (paths.length === 0) {
    console.error('usage: node bench/compare-models.mjs <comparison.json...>');
    process.exitCode = 2;
    return;
  }

  const trials = (await Promise.all(paths.map(readTrial))).sort((a, b) => b.conservative - a.conservative);
  const champions = trials.filter((trial) => trial.role === 'champion');
  const bestChampion = champions[0];

  const verdicts = trials.map((trial) => {
    const reasons = [];
    if (trial.samples < MIN_SAMPLES) reasons.push(`표본 ${trial.samples} < ${MIN_SAMPLES}`);
    if (trial.failureRate > MAX_FAILURE_RATE) reasons.push(`실패율 ${percent(trial.failureRate)}`);
    if (
      trial.role === 'challenger' &&
      bestChampion &&
      trial.conservative - bestChampion.conservative < PROMOTION_MARGIN
    ) {
      reasons.push(
        `현 챔피언 대비 +${percent(trial.conservative - bestChampion.conservative)} < ${percent(
          PROMOTION_MARGIN,
        )}`,
      );
    }
    return { ...trial, reasons };
  });

  console.log('| model | role | samples | fail | title | order | lyrics | overall | conservative | verdict |');
  console.log('| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |');
  for (const trial of verdicts) {
    const verdict =
      trial.role === 'champion'
        ? trial.reasons.length === 0
          ? 'champion'
          : `champion — 확인 필요 (${trial.reasons.join('; ')})`
        : trial.reasons.length === 0
          ? '**promote**'
          : `hold (${trial.reasons.join('; ')})`;
    console.log(
      `| ${trial.model} | ${trial.role} | ${trial.samples} | ${percent(trial.failureRate)} | ` +
        `${percent(trial.title)} | ${percent(trial.order)} | ${percent(trial.lyrics)} | ` +
        `${percent(trial.overall)} | ${percent(trial.conservative)} | ${verdict} |`,
    );
  }

  // Only a challenger being put forward can fail this command. A champion's
  // own trial is information, not a proposal.
  const blocked = verdicts.filter((trial) => trial.role === 'challenger' && trial.reasons.length > 0);
  if (blocked.length > 0) {
    console.error('\nNOT PROMOTABLE:');
    for (const trial of blocked) console.error(`  - ${trial.model}: ${trial.reasons.join('; ')}`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
