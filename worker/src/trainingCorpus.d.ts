export interface TrainingImageDescriptor {
  mimeType: 'image/webp' | 'image/png';
  size: number;
  sha256: string;
  chunkCount: number;
}

export interface CorpusManifest {
  id: string;
  pageHash: string;
  feedbackId: string;
  createdAt: string;
  imageAvailable: boolean;
  image?: TrainingImageDescriptor;
  exportedAt?: string;
  versions: unknown[];
  diff?: unknown;
}

export interface CorpusStatus {
  total: number;
  verified: number;
  edited: number;
  withImage: number;
  exported: number;
  bytes: number;
  limit: number;
}

export const TRAINING_CHUNK_BYTES: number;
export const MAX_TRAINING_IMAGES: number;
export const CORPUS_META_PREFIX: string;
export const CORPUS_CHUNK_PREFIX: string;

export function validCorpusId(value: unknown): value is string;
export function corpusMetaKey(id: string): string;
export function corpusChunkKey(id: string, index: number): string;
export function matchCorpusChunkRoute(pathname: string): { id: string; index: number } | null;
export function matchCorpusRecordRoute(pathname: string): { id: string } | null;
export function sanitizeCorpusManifest(raw: unknown, now?: Date): CorpusManifest | null;
export function expectedChunkBytes(image: TrainingImageDescriptor, index: number): number;
export function corpusStatus(manifests: CorpusManifest[]): CorpusStatus;
export function evictableCorpusIds(manifests: CorpusManifest[], limit?: number): string[];
