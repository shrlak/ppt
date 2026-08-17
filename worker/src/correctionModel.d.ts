export interface CorrectionModelFile {
  path: string;
  size: number;
  sha256: string;
  chunkCount: number;
}

export interface CorrectionModelManifest {
  version: string;
  baseModel: string;
  datasetHash: string;
  samples: number;
  meanOverall: number;
  baselineOverall: number;
  lyricsScore: number;
  baselineLyricsScore: number;
  files: CorrectionModelFile[];
}

export const CORRECTION_CHUNK_BYTES: number;
export const MAX_CORRECTION_VERSIONS: number;
export const CORRECTION_PREFIX: string;
export const ALLOWED_BASE_MODELS: string[];
export const MIN_OVERALL_GAIN: number;
export const REQUIRED_FILES: string[];

export function validVersion(value: unknown): value is string;
export function validFilePath(value: unknown): value is string;
export function manifestKey(slot: string): string;
export function fileKey(version: string, path: string, index: number): string;
export function matchCorrectionUploadRoute(
  pathname: string,
): { version: string; path: string; index: number } | null;
export function matchCorrectionReadRoute(pathname: string): { version: string; path: string } | null;
export function sanitizeCorrectionManifest(raw: unknown): CorrectionModelManifest | null;
export function acceptCorrectionManifest(manifest: CorrectionModelManifest | null): boolean;
export function expectedFileChunkBytes(file: CorrectionModelFile, index: number): number;
export function isAllowedModelOrigin(request: Request, allowedOrigins: string[]): boolean;
export function publicCorrectionManifest(
  manifest: CorrectionModelManifest | null,
): Record<string, unknown> | null;
