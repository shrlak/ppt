// Storage shape for the training corpus: one record per verified score page,
// with the page image transferred in chunks.
//
// This is the only place the proxy keeps score IMAGES, so it is deliberately
// the strictest: every write and every read needs the administrator password,
// the record count is capped, and the weekly PPT purge is explicitly not
// allowed anywhere near these keys — a corpus that is wiped every Sunday can
// never train anything.

export const TRAINING_CHUNK_BYTES = 1024 * 1024;
export const MAX_TRAINING_IMAGES = 300;

/** `learning:corpus:meta:<id>` */
export const CORPUS_META_PREFIX = 'learning:corpus:meta:';
/** `learning:corpus:chunk:<id>:<index>` */
export const CORPUS_CHUNK_PREFIX = 'learning:corpus:chunk:';

const MIME_TYPES = new Set(['image/webp', 'image/png']);

function trimmed(value, maxLength) {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

export function validCorpusId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 100 && /^[A-Za-z0-9_-]+$/.test(value);
}

function validHash(value) {
  return typeof value === 'string' && /^[0-9a-f]{16,128}$/.test(value);
}

export function corpusMetaKey(id) {
  return `${CORPUS_META_PREFIX}${id}`;
}

export function corpusChunkKey(id, index) {
  return `${CORPUS_CHUNK_PREFIX}${id}:${index}`;
}

/** `PUT /learning/corpus/:id/chunks/:index` */
const CHUNK_ROUTE = /^\/learning\/corpus\/([A-Za-z0-9_-]{1,100})\/chunks\/(\d{1,9})$/;

export function matchCorpusChunkRoute(pathname) {
  const match = CHUNK_ROUTE.exec(pathname);
  return match ? { id: match[1], index: Number(match[2]) } : null;
}

/** `DELETE|GET /learning/corpus/:id` */
const RECORD_ROUTE = /^\/learning\/corpus\/([A-Za-z0-9_-]{1,100})$/;

export function matchCorpusRecordRoute(pathname) {
  const match = RECORD_ROUTE.exec(pathname);
  return match ? { id: match[1] } : null;
}

function sanitizeImageDescriptor(raw) {
  if (raw == null) return null;
  if (!raw || typeof raw !== 'object') return null;
  const size = Number(raw.size);
  const chunkCount = Number(raw.chunkCount);
  if (
    !MIME_TYPES.has(raw.mimeType) ||
    !validHash(raw.sha256) ||
    !Number.isSafeInteger(size) ||
    size <= 0 ||
    !Number.isSafeInteger(chunkCount) ||
    chunkCount < 1 ||
    // The declared chunk count has to follow from the declared size, or a
    // client could reserve unbounded chunk slots with a one-byte upload.
    chunkCount !== Math.max(1, Math.ceil(size / TRAINING_CHUNK_BYTES))
  ) {
    return null;
  }
  return { mimeType: raw.mimeType, size, sha256: raw.sha256, chunkCount };
}

function sanitizeScore(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const sections = Array.isArray(raw.sections)
    ? raw.sections
        .slice(0, 50)
        .map((section) => {
          if (!section || typeof section !== 'object' || !Array.isArray(section.lines)) return null;
          const label = trimmed(section.label, 30);
          if (!label) return null;
          return {
            label,
            lines: section.lines
              .filter((line) => typeof line === 'string')
              .map((line) => line.slice(0, 500))
              .slice(0, 200),
          };
        })
        .filter(Boolean)
    : [];
  return {
    ...(trimmed(raw.title, 200) ? { title: trimmed(raw.title, 200) } : {}),
    ...(trimmed(raw.artist, 200) ? { artist: trimmed(raw.artist, 200) } : {}),
    ...(trimmed(raw.key, 20) ? { key: trimmed(raw.key, 20) } : {}),
    order: Array.isArray(raw.order)
      ? raw.order.map((token) => trimmed(token, 30)).filter(Boolean).slice(0, 200)
      : [],
    sections,
  };
}

/** Validate one corpus record's metadata. Chunks arrive separately. */
export function sanitizeCorpusManifest(raw, now = new Date()) {
  if (!raw || typeof raw !== 'object') return null;
  if (!validCorpusId(raw.id) || !validHash(raw.pageHash)) return null;
  const feedbackId = trimmed(raw.feedbackId, 100);
  if (!feedbackId) return null;

  const image = sanitizeImageDescriptor(raw.image);
  // A record can exist without an image — the page may not have been
  // rendered — but a malformed descriptor is a rejection, not a downgrade.
  if (raw.image != null && !image) return null;

  const versions = Array.isArray(raw.versions)
    ? raw.versions.slice(0, 20).map(sanitizeScore).filter(Boolean)
    : [];
  if (versions.length === 0) return null;

  const createdAt = new Date(raw.createdAt);
  const exportedAt = raw.exportedAt ? new Date(raw.exportedAt) : null;
  return {
    id: raw.id,
    pageHash: raw.pageHash,
    feedbackId,
    createdAt: Number.isFinite(createdAt.getTime()) ? createdAt.toISOString() : now.toISOString(),
    imageAvailable: !!image,
    ...(image ? { image } : {}),
    ...(exportedAt && Number.isFinite(exportedAt.getTime()) ? { exportedAt: exportedAt.toISOString() } : {}),
    versions,
    ...(raw.diff && typeof raw.diff === 'object' ? { diff: raw.diff } : {}),
  };
}

/** Bytes a chunk at this index must carry, given the declared total size. */
export function expectedChunkBytes(image, index) {
  return index === image.chunkCount - 1
    ? image.size - TRAINING_CHUNK_BYTES * (image.chunkCount - 1)
    : TRAINING_CHUNK_BYTES;
}

/**
 * Counts and bytes only.
 *
 * The corpus status is shown on a dashboard, so it must say how much is stored
 * without saying what is in it.
 */
export function corpusStatus(manifests) {
  let bytes = 0;
  let verified = 0;
  let edited = 0;
  let exported = 0;
  let withImage = 0;
  for (const manifest of manifests) {
    bytes += manifest.image?.size ?? 0;
    if (manifest.image) withImage += 1;
    if (manifest.exportedAt) exported += 1;
    // A record whose latest version changed nothing is a confirmation; one
    // that changed something is a correction. Both are ground truth.
    const changed = hasChanges(manifest.diff);
    if (changed) edited += 1;
    else verified += 1;
  }
  return {
    total: manifests.length,
    verified,
    edited,
    withImage,
    exported,
    bytes,
    limit: MAX_TRAINING_IMAGES,
  };
}

function hasChanges(diff) {
  if (!diff || typeof diff !== 'object') return false;
  return (
    diff.titleChanged === true ||
    diff.artistChanged === true ||
    diff.keyChanged === true ||
    diff.orderChanged === true ||
    (Array.isArray(diff.sectionChanges) && diff.sectionChanges.length > 0)
  );
}

/**
 * Which records to evict once the image cap is exceeded.
 *
 * Only records already exported into an artifact may go: anything else has not
 * reached a training run yet, and dropping it would silently lose a correction
 * somebody made.
 */
export function evictableCorpusIds(manifests, limit = MAX_TRAINING_IMAGES) {
  const withImages = manifests.filter((manifest) => manifest.imageAvailable);
  const excess = withImages.length - limit;
  if (excess <= 0) return [];
  return withImages
    .filter((manifest) => !!manifest.exportedAt)
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
    .slice(0, excess)
    .map((manifest) => manifest.id);
}
