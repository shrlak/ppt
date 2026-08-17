// Validation and storage-shape helpers for the cross-device lyrics and PPT
// libraries. These functions are deliberately side-effect free so the Worker
// and the browser client can be tested without a Durable Object runtime.

export const PPT_CHUNK_BYTES = 1024 * 1024;
export const MAX_PPT_LIBRARY_BYTES = 100 * 1024 * 1024;
export const MAX_PPT_LIBRARY_DECKS = 250;
// 'source' carries the wizard inputs a deck was generated from, so another
// device can reopen it for editing. Opaque bytes here, like every other kind.
export const PPT_FILE_KINDS = ['pptx', 'contiPdf', 'sermonPptx', 'source', 'additionalFiles'];

const MAX_LYRICS_ENTRIES = 2000;
const MAX_LYRIC_SECTIONS = 50;
const MAX_LYRIC_LINES = 500;

/** Trust levels a stored lyrics entry may carry (mirrors VerificationState). */
export const VERIFICATION_STATES = ['draft', 'verified', 'edited'];
const PROVENANCE_SOURCES = ['library', 'models', 'web', 'manual'];

function trimmed(value, maxLength) {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

export function normalizeLibraryTitle(value) {
  return trimmed(value, 200).toLowerCase().replace(/[^0-9a-zㄱ-ㆎ가-힣]+/g, '');
}

/**
 * Keep only provenance fields whose shape can be verified. Anything else an
 * older or newer client sent is dropped rather than stored unchecked.
 */
export function sanitizeStoredProvenance(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const provenance = {};
  const pageHash = trimmed(raw.pageHash, 128);
  if (pageHash) provenance.pageHash = pageHash;
  const source = trimmed(raw.source, 20);
  if (PROVENANCE_SOURCES.includes(source)) provenance.source = source;
  const webSourceUrl = trimmed(raw.webSourceUrl, 500);
  if (/^https?:\/\//.test(webSourceUrl)) provenance.webSourceUrl = webSourceUrl;
  const confidence = Number(raw.confidence);
  if (Number.isFinite(confidence) && confidence >= 0 && confidence <= 1) provenance.confidence = confidence;
  const correctionModelVersion = trimmed(raw.correctionModelVersion, 64);
  if (correctionModelVersion) provenance.correctionModelVersion = correctionModelVersion;
  return Object.keys(provenance).length > 0 ? provenance : null;
}

/** Trust level of an entry that may predate the verification field. */
export function entryVerification(entry) {
  return VERIFICATION_STATES.includes(entry?.verification) ? entry.verification : 'verified';
}

/** True when an entry is ground truth a user stood behind. */
export function isGroundTruth(entry) {
  return entryVerification(entry) !== 'draft';
}

export function sanitizeLyricsEntry(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const title = trimmed(raw.title, 200);
  if (!title || !normalizeLibraryTitle(title) || !Array.isArray(raw.sections)) return null;

  let lineCount = 0;
  const sections = [];
  for (const candidate of raw.sections.slice(0, MAX_LYRIC_SECTIONS)) {
    if (!candidate || typeof candidate !== 'object' || !Array.isArray(candidate.lines)) continue;
    const label = trimmed(candidate.label, 30);
    if (!label) continue;
    const lines = [];
    for (const value of candidate.lines) {
      if (lineCount >= MAX_LYRIC_LINES) break;
      if (typeof value !== 'string') continue;
      lines.push(value.slice(0, 500));
      lineCount += 1;
    }
    sections.push({ label, lines });
    if (lineCount >= MAX_LYRIC_LINES) break;
  }

  const order = Array.isArray(raw.order)
    ? raw.order.map((value) => trimmed(value, 30)).filter(Boolean).slice(0, 500)
    : [];
  const artist = trimmed(raw.artist, 200);
  const key = trimmed(raw.key, 20);
  // Pre-feature entries were all put here by an explicit user save, so
  // 'verified' is both the accurate and the safest migration target.
  const verification = VERIFICATION_STATES.includes(raw.verification) ? raw.verification : 'verified';
  const rawVersion = Number(raw.version);
  const version = Number.isSafeInteger(rawVersion) && rawVersion >= 1 ? rawVersion : 1;
  const updatedAt = trimmed(raw.updatedAt, 40);
  const provenance = sanitizeStoredProvenance(raw.provenance);
  return {
    title,
    ...(artist ? { artist } : {}),
    ...(key ? { key } : {}),
    sections,
    order,
    verification,
    version,
    ...(updatedAt ? { updatedAt } : {}),
    ...(provenance ? { provenance } : {}),
  };
}

export function sanitizeLyricsEntries(raw) {
  if (!Array.isArray(raw)) return [];
  const deduped = new Map();
  for (const value of raw) {
    const entry = sanitizeLyricsEntry(value);
    if (!entry) continue;
    deduped.set(normalizeLibraryTitle(entry.title), entry);
    if (deduped.size >= MAX_LYRICS_ENTRIES) break;
  }
  return [...deduped.values()];
}

export function validLibraryId(value, maxLength = 160) {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength && /^[A-Za-z0-9_-]+$/.test(value);
}

// Chunk routes are built from PPT_FILE_KINDS rather than spelled out, so a new
// kind is transferable the moment it is declared. A kind the routes reject is
// worse than one that is missing: the client uploads every declared file, and
// a rejected chunk fails the whole deck upload rather than that one file.
const CHUNK_ROUTE_KINDS = PPT_FILE_KINDS.join('|');
const UPLOAD_CHUNK_ROUTE = new RegExp(
  `^/libraries/ppt/uploads/([A-Za-z0-9_-]+)/files/(${CHUNK_ROUTE_KINDS})/chunks/(\\d{1,9})$`,
);
const DECK_CHUNK_ROUTE = new RegExp(
  `^/libraries/ppt/([A-Za-z0-9_-]+)/files/(${CHUNK_ROUTE_KINDS})/chunks/(\\d{1,9})$`,
);

/** `PUT /libraries/ppt/uploads/:uploadId/files/:kind/chunks/:index` */
export function matchUploadChunkRoute(pathname) {
  const match = UPLOAD_CHUNK_ROUTE.exec(pathname);
  return match ? { uploadId: match[1], kind: match[2], index: Number(match[3]) } : null;
}

/** `GET /libraries/ppt/:deckId/files/:kind/chunks/:index` */
export function matchDeckChunkRoute(pathname) {
  const match = DECK_CHUNK_ROUTE.exec(pathname);
  return match ? { deckId: match[1], kind: match[2], index: Number(match[3]) } : null;
}

export function sanitizePptFileDescriptor(raw, required = false) {
  if (raw == null && !required) return null;
  if (!raw || typeof raw !== 'object') return null;
  const name = trimmed(raw.name, 240);
  const size = Number(raw.size);
  const chunkCount = Number(raw.chunkCount);
  if (
    !name ||
    !Number.isSafeInteger(size) ||
    size <= 0 ||
    !Number.isSafeInteger(chunkCount) ||
    chunkCount < 1 ||
    chunkCount !== Math.max(1, Math.ceil(size / PPT_CHUNK_BYTES))
  ) {
    return null;
  }
  return { name, size, chunkCount };
}

export function sanitizePptFiles(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const pptx = sanitizePptFileDescriptor(raw.pptx, true);
  const contiPdf = sanitizePptFileDescriptor(raw.contiPdf);
  const sermonPptx = sanitizePptFileDescriptor(raw.sermonPptx);
  const source = sanitizePptFileDescriptor(raw.source);
  const additionalFiles = sanitizePptFileDescriptor(raw.additionalFiles);
  if (!pptx) return null;
  if (raw.contiPdf != null && !contiPdf) return null;
  if (raw.sermonPptx != null && !sermonPptx) return null;
  if (raw.source != null && !source) return null;
  if (raw.additionalFiles != null && !additionalFiles) return null;
  const files = { pptx, contiPdf, sermonPptx, source, additionalFiles };
  const totalBytes = PPT_FILE_KINDS.reduce((sum, kind) => sum + (files[kind]?.size ?? 0), 0);
  return totalBytes <= MAX_PPT_LIBRARY_BYTES ? files : null;
}

export function sanitizePptUpload(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const uploadId = raw.uploadId;
  const deckId = raw.deckId;
  const files = sanitizePptFiles(raw.files);
  if (!validLibraryId(uploadId) || !validLibraryId(deckId, 100) || !files) return null;
  return { uploadId, deckId, files };
}

export function sanitizePptDeckMetadata(raw, now = new Date()) {
  if (!raw || typeof raw !== 'object') return null;
  const id = raw.id;
  const uploadId = raw.uploadId;
  const name = trimmed(raw.name, 240);
  const slideCount = Number(raw.slideCount);
  const files = sanitizePptFiles(raw.files);
  if (
    !validLibraryId(id, 100) ||
    !validLibraryId(uploadId) ||
    !name ||
    !files ||
    !Number.isSafeInteger(slideCount) ||
    slideCount < 1 ||
    slideCount > 5000
  ) {
    return null;
  }

  const savedAtDate = new Date(raw.savedAt);
  const savedAt = Number.isFinite(savedAtDate.getTime()) ? savedAtDate.toISOString() : now.toISOString();
  const songTitles = Array.isArray(raw.songTitles)
    ? raw.songTitles.map((value) => trimmed(value, 200)).filter(Boolean).slice(0, 200)
    : [];
  return {
    id,
    uploadId,
    name,
    files,
    slideCount,
    songTitles,
    savedAt,
    updatedAt: now.toISOString(),
  };
}

export function samePptFiles(left, right) {
  return PPT_FILE_KINDS.every((kind) => {
    const a = left?.[kind] ?? null;
    const b = right?.[kind] ?? null;
    return a === null
      ? b === null
      : b !== null && a.name === b.name && a.size === b.size && a.chunkCount === b.chunkCount;
  });
}
