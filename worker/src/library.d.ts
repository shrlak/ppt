export interface LyricsLibraryEntry {
  title: string;
  key?: string;
  sections: { label: string; lines: string[] }[];
  order: string[];
}

export interface PptFileDescriptor {
  name: string;
  size: number;
  chunkCount: number;
}

export interface PptFiles {
  pptx: PptFileDescriptor;
  contiPdf: PptFileDescriptor | null;
  sermonPptx: PptFileDescriptor | null;
}

export interface PptDeckMetadata {
  id: string;
  uploadId: string;
  name: string;
  files: PptFiles;
  slideCount: number;
  songTitles: string[];
  savedAt: string;
  updatedAt: string;
}

export const PPT_CHUNK_BYTES: number;
export const MAX_PPT_LIBRARY_BYTES: number;
export const MAX_PPT_LIBRARY_DECKS: number;
export const PPT_FILE_KINDS: readonly ['pptx', 'contiPdf', 'sermonPptx'];

export function normalizeLibraryTitle(value: unknown): string;
export function sanitizeLyricsEntry(raw: unknown): LyricsLibraryEntry | null;
export function sanitizeLyricsEntries(raw: unknown): LyricsLibraryEntry[];
export function validLibraryId(value: unknown, maxLength?: number): value is string;
export function sanitizePptFileDescriptor(raw: unknown, required?: boolean): PptFileDescriptor | null;
export function sanitizePptFiles(raw: unknown): PptFiles | null;
export function sanitizePptUpload(raw: unknown): { uploadId: string; deckId: string; files: PptFiles } | null;
export function sanitizePptDeckMetadata(raw: unknown, now?: Date): PptDeckMetadata | null;
export function samePptFiles(left: PptFiles | null | undefined, right: PptFiles | null | undefined): boolean;
