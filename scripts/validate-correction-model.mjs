#!/usr/bin/env node
// Check a correction-model artifact before anyone uploads it.
//
// The notebook that produces these runs on a free Colab or Kaggle session,
// which is exactly the sort of place a run gets interrupted, resumed, or
// re-run with the wrong cell order. So the artifact is verified against its
// own manifest here, on the administrator's machine, before it can reach the
// proxy: file hashes, the score gate, the base-model allowlist, and the files
// the runtime cannot start without.
//
//   node scripts/validate-correction-model.mjs artifacts/lyrics-corrector/v3.zip
//
// Prints the exact version, scores, byte count and SHA-256 values that the
// upload screen will show, so the two can be compared by eye.
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import JSZip from 'jszip';

/** Base models an artifact may have been trained from. */
const ALLOWED_BASE_MODELS = ['google/mt5-small', 'google/mt5-base'];

/** Overall improvement an artifact must show to be worth running at all. */
const MIN_OVERALL_GAIN = 0.01;

/** Files the browser runtime cannot start without. */
const REQUIRED_FILES = ['config.json', 'tokenizer.json'];

const problems = [];
const fail = (message) => problems.push(message);

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function percent(value) {
  return `${(value * 100).toFixed(2)}%`;
}

async function main() {
  const archivePath = process.argv[2];
  if (!archivePath) {
    console.error('usage: node scripts/validate-correction-model.mjs <artifact.zip>');
    process.exitCode = 2;
    return;
  }

  const zip = await JSZip.loadAsync(await readFile(archivePath));
  const manifestEntry = zip.file('manifest.json');
  if (!manifestEntry) {
    console.error('manifest.json is missing — this is not a correction-model artifact.');
    process.exitCode = 1;
    return;
  }

  let manifest;
  try {
    manifest = JSON.parse(await manifestEntry.async('string'));
  } catch (error) {
    console.error(`manifest.json is not valid JSON: ${error.message}`);
    process.exitCode = 1;
    return;
  }

  if (typeof manifest.version !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(manifest.version)) {
    fail('version must be a short alphanumeric tag; it becomes part of a URL.');
  }
  if (!ALLOWED_BASE_MODELS.includes(manifest.baseModel)) {
    fail(`baseModel ${manifest.baseModel} is not in the allowlist (${ALLOWED_BASE_MODELS.join(', ')}).`);
  }
  if (typeof manifest.datasetHash !== 'string' || !/^[0-9a-f]{64}$/.test(manifest.datasetHash)) {
    fail('datasetHash must be the SHA-256 of the corpus this was trained from.');
  }
  if (!Number.isInteger(manifest.samples) || manifest.samples <= 0) {
    fail('samples must say how many verified pages the run used.');
  }

  const scores = ['meanOverall', 'baselineOverall', 'lyricsScore', 'baselineLyricsScore'];
  for (const field of scores) {
    const value = Number(manifest[field]);
    if (!Number.isFinite(value) || value < 0 || value > 1) fail(`${field} must be a score between 0 and 1.`);
  }
  const gain = Number(manifest.meanOverall) - Number(manifest.baselineOverall);
  if (!(gain >= MIN_OVERALL_GAIN)) {
    fail(
      `overall improved by ${percent(gain || 0)}, below the ${percent(MIN_OVERALL_GAIN)} bar — ` +
        'not worth an inference on every page.',
    );
  }
  if (Number(manifest.lyricsScore) < Number(manifest.baselineLyricsScore)) {
    // Fixing titles by damaging words is the one regression that matters:
    // the words are what end up on the slide.
    fail(
      `lyric accuracy fell from ${percent(manifest.baselineLyricsScore)} to ${percent(manifest.lyricsScore)}.`,
    );
  }

  const files = Array.isArray(manifest.files) ? manifest.files : [];
  if (files.length === 0) fail('files must list every model file in the archive.');
  const paths = new Set(files.map((file) => file?.path));
  for (const required of REQUIRED_FILES) {
    if (!paths.has(required)) fail(`${required} is missing; the runtime cannot start without it.`);
  }
  if (![...paths].some((file) => typeof file === 'string' && file.endsWith('.onnx'))) {
    fail('no .onnx file — nothing in this archive can generate text.');
  }

  let totalBytes = 0;
  const rows = [];
  for (const file of files) {
    if (!file || typeof file.path !== 'string') {
      fail('every entry in files needs a path.');
      continue;
    }
    if (file.path.startsWith('/') || file.path.includes('..') || path.isAbsolute(file.path)) {
      fail(`${file.path} escapes the archive; paths must be relative and contain no "..".`);
      continue;
    }
    const entry = zip.file(file.path);
    if (!entry) {
      fail(`${file.path} is listed in the manifest but not present in the archive.`);
      continue;
    }
    const bytes = await entry.async('nodebuffer');
    const digest = sha256(bytes);
    if (digest !== file.sha256) {
      fail(`${file.path} does not match its manifest hash (archive ${digest}, manifest ${file.sha256}).`);
    }
    if (bytes.byteLength !== file.size) {
      fail(`${file.path} is ${bytes.byteLength} bytes, manifest says ${file.size}.`);
    }
    totalBytes += bytes.byteLength;
    rows.push({ path: file.path, size: bytes.byteLength, sha256: digest });
  }

  console.log(`artifact   ${archivePath}`);
  console.log(`version    ${manifest.version}`);
  console.log(`base model ${manifest.baseModel}`);
  console.log(`dataset    ${manifest.datasetHash}`);
  console.log(`samples    ${manifest.samples}`);
  console.log(
    `overall    ${percent(manifest.baselineOverall)} → ${percent(manifest.meanOverall)} ` +
      `(${gain >= 0 ? '+' : ''}${percent(gain)})`,
  );
  console.log(`lyrics     ${percent(manifest.baselineLyricsScore)} → ${percent(manifest.lyricsScore)}`);
  console.log(`total      ${totalBytes} bytes across ${rows.length} file(s)`);
  for (const row of rows) console.log(`  ${row.sha256}  ${String(row.size).padStart(10)}  ${row.path}`);

  if (problems.length > 0) {
    console.error('\nREJECTED:');
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exitCode = 1;
    return;
  }
  console.log('\nOK — safe to upload in 관리자 설정 → 학습.');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
