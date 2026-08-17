// Storage and serving for the hand-trained correction model.
//
// The artifact is uploaded by an administrator, verified against its own
// manifest hashes, and only then activated. Two versions are kept — active and
// previous — so a bad model can be rolled back in one request rather than
// waiting for a retrain.
//
// Reads are a different shape from every other route here: the model files are
// fetched by the browser runtime itself, so they are served from stable
// versioned URLs with immutable caching, restricted to allowed app origins.
// No training record is reachable through them.

export const CORRECTION_CHUNK_BYTES = 1024 * 1024;

/** Versions kept: the one in use and the one to fall back to. */
export const MAX_CORRECTION_VERSIONS = 2;

export const CORRECTION_PREFIX = 'learning:correction-model:';

/** Base models an artifact is allowed to have been trained from. */
export const ALLOWED_BASE_MODELS = ['google/mt5-small', 'google/mt5-base'];

/** Overall improvement an artifact must show before it may be activated. */
export const MIN_OVERALL_GAIN = 0.01;

/** Files the runtime needs before it can generate anything at all. */
export const REQUIRED_FILES = ['config.json', 'tokenizer.json'];

function trimmed(value, maxLength) {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

function validHash(value) {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

/** A version is a path segment and a cache key, so keep it boring. */
export function validVersion(value) {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value);
}

/**
 * A file path inside the artifact.
 *
 * Rejects anything that could escape the artifact's own namespace once it is
 * used to build a storage key or a URL — no absolute paths, no traversal, no
 * backslashes.
 */
export function validFilePath(value) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 200 &&
    /^[A-Za-z0-9._/-]+$/.test(value) &&
    !value.startsWith('/') &&
    !value.includes('..') &&
    !value.includes('//')
  );
}

export function manifestKey(slot) {
  return `${CORRECTION_PREFIX}manifest:${slot}`;
}

export function fileKey(version, path, index) {
  return `${CORRECTION_PREFIX}chunk:${version}:${path}:${index}`;
}

/** `PUT /learning/correction-model/:version/files/<path>/chunks/:index` */
const UPLOAD_ROUTE =
  /^\/learning\/correction-model\/([A-Za-z0-9][A-Za-z0-9._-]{0,63})\/files\/([A-Za-z0-9._/-]{1,200})\/chunks\/(\d{1,9})$/;

export function matchCorrectionUploadRoute(pathname) {
  const match = UPLOAD_ROUTE.exec(pathname);
  if (!match || !validFilePath(match[2])) return null;
  return { version: match[1], path: match[2], index: Number(match[3]) };
}

/** `GET /learning/correction-model/:version/resolve/<path>` */
const READ_ROUTE =
  /^\/learning\/correction-model\/([A-Za-z0-9][A-Za-z0-9._-]{0,63})\/resolve\/([A-Za-z0-9._/-]{1,200})$/;

export function matchCorrectionReadRoute(pathname) {
  const match = READ_ROUTE.exec(pathname);
  if (!match || !validFilePath(match[2])) return null;
  return { version: match[1], path: match[2] };
}

function sanitizeFile(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const path = trimmed(raw.path, 200);
  const size = Number(raw.size);
  if (!validFilePath(path) || !validHash(raw.sha256)) return null;
  if (!Number.isSafeInteger(size) || size <= 0 || size > 512 * 1024 * 1024) return null;
  return { path, size, sha256: raw.sha256, chunkCount: Math.max(1, Math.ceil(size / CORRECTION_CHUNK_BYTES)) };
}

/**
 * Validate an uploaded artifact's manifest.
 *
 * The score gate lives here as well as in the browser: the proxy is what
 * decides whether a version may become active, and a client that skipped its
 * own check must not be able to activate a model that made things worse.
 */
export function sanitizeCorrectionManifest(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (!validVersion(raw.version)) return null;
  if (!ALLOWED_BASE_MODELS.includes(raw.baseModel)) return null;
  if (!validHash(raw.datasetHash)) return null;

  const numbers = ['meanOverall', 'baselineOverall', 'lyricsScore', 'baselineLyricsScore'];
  const scores = {};
  for (const field of numbers) {
    const value = Number(raw[field]);
    if (!Number.isFinite(value) || value < 0 || value > 1) return null;
    scores[field] = value;
  }
  const samples = Number(raw.samples);
  if (!Number.isSafeInteger(samples) || samples <= 0) return null;

  const files = Array.isArray(raw.files) ? raw.files.slice(0, 40).map(sanitizeFile) : [];
  if (files.length === 0 || files.some((file) => file === null)) return null;
  const paths = new Set(files.map((file) => file.path));
  if (paths.size !== files.length) return null;
  if (!REQUIRED_FILES.every((required) => paths.has(required))) return null;
  // Something has to actually generate text.
  if (![...paths].some((path) => path.endsWith('.onnx'))) return null;

  return { version: raw.version, baseModel: raw.baseModel, datasetHash: raw.datasetHash, samples, ...scores, files };
}

/** Does this artifact beat what it replaces by enough to be worth running? */
export function acceptCorrectionManifest(manifest) {
  if (!manifest) return false;
  if (manifest.meanOverall - manifest.baselineOverall < MIN_OVERALL_GAIN) return false;
  // A model whose overall score rose while its LYRIC score fell learned to fix
  // titles by damaging words, and the words are what reach the slide.
  return manifest.lyricsScore >= manifest.baselineLyricsScore;
}

/** Bytes the chunk at this index must carry, given the declared file size. */
export function expectedFileChunkBytes(file, index) {
  return index === file.chunkCount - 1
    ? file.size - CORRECTION_CHUNK_BYTES * (file.chunkCount - 1)
    : CORRECTION_CHUNK_BYTES;
}

/** Only the app's own origins may read model files. */
export function isAllowedModelOrigin(request, allowedOrigins) {
  const origin = request.headers.get('Origin') || '';
  return !!origin && allowedOrigins.includes(origin);
}

/** The public view of a slot: enough to decide whether to load it, no files' bytes. */
export function publicCorrectionManifest(manifest) {
  if (!manifest) return null;
  return {
    version: manifest.version,
    baseModel: manifest.baseModel,
    datasetHash: manifest.datasetHash,
    samples: manifest.samples,
    meanOverall: manifest.meanOverall,
    baselineOverall: manifest.baselineOverall,
    lyricsScore: manifest.lyricsScore,
    baselineLyricsScore: manifest.baselineLyricsScore,
    files: manifest.files.map((file) => ({ path: file.path, size: file.size, sha256: file.sha256 })),
  };
}
