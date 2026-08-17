// The training corpus: verified corrections paired with the page they came
// from, kept small enough to be free and exportable as one ZIP.
//
// A correction on its own teaches a text model how the app's own output should
// be fixed. Paired with the score image it also becomes vision training data.
// Both are only worth keeping for pages somebody actually verified, so nothing
// reaches here until an explicit save.
//
// Two rules keep this from growing without bound or duplicating work: one
// record per PAGE (repeat verifications add a version, not a row), and a hard
// image cap that evicts only what has already been exported.
import JSZip from 'jszip';
import type { ParsedScore } from '../ai/scoreParser';
import type { FeedbackDiff } from './feedbackDiff';

/** Longest edge a stored training image keeps. */
export const TRAINING_IMAGE_MAX_DIMENSION = 1200;

/** WebP quality: small enough to store 300 of them, sharp enough to read. */
export const TRAINING_IMAGE_QUALITY = 0.82;

/** Images kept before the oldest exported ones are evicted. */
export const MAX_TRAINING_IMAGES = 300;

/** Upload chunk size, matching the PPT library's proven transfer size. */
export const TRAINING_CHUNK_BYTES = 1024 * 1024;

export interface TrainingImageDescriptor {
  mimeType: 'image/webp' | 'image/png';
  size: number;
  sha256: string;
  chunkCount: number;
}

export interface TrainingExampleManifest {
  id: string;
  pageHash: string;
  feedbackId: string;
  createdAt: string;
  /** False when the page image could not be captured — metadata still counts. */
  imageAvailable: boolean;
  image?: TrainingImageDescriptor;
  exportedAt?: string;
  /** Every verified answer for this page, oldest first. */
  versions: ParsedScore[];
  /** What changed in the most recent verification. */
  diff?: FeedbackDiff;
}

/**
 * Fold a new verification of a page into the record already held for it.
 *
 * A song gets re-verified as it is corrected over several weeks, and each pass
 * is a better answer for the SAME page. Keeping them as versions of one record
 * both bounds the corpus and preserves the history a trainer needs to see how
 * the answer converged.
 */
export function mergeTrainingExamples(
  existing: TrainingExampleManifest[],
  incoming: TrainingExampleManifest,
): TrainingExampleManifest {
  const previous = existing.filter((example) => example.pageHash === incoming.pageHash);
  if (previous.length === 0) return incoming;
  const versions = [...previous.flatMap((example) => example.versions), ...incoming.versions];
  const seen = new Set<string>();
  return {
    ...previous[0],
    ...incoming,
    id: previous[0].id,
    createdAt: previous[0].createdAt,
    versions: versions.filter((version) => {
      const key = JSON.stringify(version);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }),
    // A version that supersedes an exported one has not itself been exported.
    exportedAt: undefined,
  };
}

export interface TrainingLimitResult {
  kept: TrainingExampleManifest[];
  evicted: string[];
}

/**
 * Trim the corpus to its image cap.
 *
 * Only an example whose image has already been EXPORTED may be evicted:
 * anything else has not made it into a training artifact yet, and dropping it
 * would silently lose a correction somebody made. If nothing has been
 * exported, the corpus is allowed to sit over its cap rather than destroy
 * unsaved work — the admin dashboard is what surfaces that.
 */
export function enforceTrainingLimit(
  examples: TrainingExampleManifest[],
  limit = MAX_TRAINING_IMAGES,
): TrainingLimitResult {
  const withImages = examples.filter((example) => example.imageAvailable);
  const excess = withImages.length - limit;
  if (excess <= 0) return { kept: examples, evicted: [] };

  const evictable = withImages
    .filter((example) => !!example.exportedAt)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .slice(0, excess)
    .map((example) => example.id);
  const evicted = new Set(evictable);
  return { kept: examples.filter((example) => !evicted.has(example.id)), evicted: [...evicted] };
}

/**
 * Shrink a rendered page to something 300 of can be stored for free.
 *
 * Recognition renders at 1600–2200px because the models need to read small
 * lyric type; a training copy does not have to be that sharp, and the storage
 * budget is what decides how many pages the corpus can hold at all. WebP first,
 * PNG only if the encoder refuses — and only when the PNG still fits one chunk,
 * because a lossless scan can be enormous.
 */
export async function resizeTrainingImage(
  dataUrl: string,
  maxDimension = TRAINING_IMAGE_MAX_DIMENSION,
): Promise<{ dataUrl: string; mimeType: 'image/webp' | 'image/png' } | null> {
  if (typeof document === 'undefined') return null;
  const image = await loadImage(dataUrl).catch(() => null);
  if (!image) return null;

  const scale = Math.min(1, maxDimension / Math.max(image.width, image.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(image.width * scale));
  canvas.height = Math.max(1, Math.round(image.height * scale));
  const context = canvas.getContext('2d');
  if (!context) return null;
  context.drawImage(image, 0, 0, canvas.width, canvas.height);

  const webp = canvas.toDataURL('image/webp', TRAINING_IMAGE_QUALITY);
  if (webp.startsWith('data:image/webp')) return { dataUrl: webp, mimeType: 'image/webp' };

  const png = canvas.toDataURL('image/png');
  return dataUrlByteLength(png) <= TRAINING_CHUNK_BYTES ? { dataUrl: png, mimeType: 'image/png' } : null;
}

function loadImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('training image could not be decoded'));
    image.src = dataUrl;
  });
}

/** Decoded byte length of a base64 data URL, without decoding it. */
export function dataUrlByteLength(dataUrl: string): number {
  const payload = dataUrl.slice(dataUrl.indexOf(',') + 1);
  const padding = payload.endsWith('==') ? 2 : payload.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((payload.length * 3) / 4) - padding);
}

/** Raw bytes of a base64 data URL. */
export function dataUrlToBytes(dataUrl: string): Uint8Array {
  const payload = dataUrl.slice(dataUrl.indexOf(',') + 1);
  const binary = atob(payload);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export interface TrainingExportEntry {
  manifest: TrainingExampleManifest;
  /** The stored page image, when one is available to include. */
  image?: Uint8Array;
}

const README = [
  '# Lyrics correction training corpus',
  '',
  'Each line of `manifest.jsonl` is one score page that a user verified, with',
  'every model answer that was offered for it and the answer they saved.',
  '',
  '| field | meaning |',
  '| --- | --- |',
  '| `id` | stable record id; also the JSONL sort order |',
  '| `pageHash` | SHA-256 of the rendered page, the identity of the page |',
  '| `image` | path inside this archive, or absent when no image was captured |',
  '| `observations` | what each model answered, with its measured latency |',
  '| `consensus` | the reading the pipeline produced before the user saw it |',
  '| `final` | the reading the user saved: the training target |',
  '| `diff` | which fields and line indexes the user changed |',
  '',
  '## Terms',
  '',
  'These pages and lyrics belong to their copyright holders. This archive is',
  'for training a correction model for this one deployment. Do not redistribute',
  'it, publish it, or upload it to a public dataset.',
].join('\n');

/**
 * Pack the corpus into one deterministic ZIP.
 *
 * Sorted by ID and stamped with a fixed date so the same corpus produces a
 * byte-identical archive: a trainer needs to be able to say which artifact
 * came from which data, and a ZIP whose bytes change every export cannot.
 */
export async function exportTrainingCorpus(entries: TrainingExportEntry[]): Promise<Blob> {
  const zip = new JSZip();
  const ordered = [...entries].sort((a, b) => a.manifest.id.localeCompare(b.manifest.id));
  const date = new Date('2026-01-01T00:00:00.000Z');

  const lines = ordered.map((entry) => {
    const { manifest } = entry;
    const imagePath = entry.image ? `images/${manifest.pageHash}.${extensionFor(manifest)}` : undefined;
    if (entry.image && imagePath) zip.file(imagePath, entry.image, { date });
    return JSON.stringify({
      id: manifest.id,
      pageHash: manifest.pageHash,
      feedbackId: manifest.feedbackId,
      createdAt: manifest.createdAt,
      ...(imagePath ? { image: imagePath } : {}),
      versions: manifest.versions,
      final: manifest.versions[manifest.versions.length - 1] ?? null,
      diff: manifest.diff ?? null,
    });
  });

  zip.file('manifest.jsonl', `${lines.join('\n')}\n`, { date });
  zip.file('README.md', `${README}\n`, { date });
  return zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
}

function extensionFor(manifest: TrainingExampleManifest): string {
  return manifest.image?.mimeType === 'image/png' ? 'png' : 'webp';
}
