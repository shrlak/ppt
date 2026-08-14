import JSZip from 'jszip';
import { detectAdditionalFileKind } from '../additionalFiles/files';
import type { AdditionalFile, AdditionalFileKind } from '../additionalFiles/types';

const ARCHIVE_VERSION = 1;
const ARCHIVE_NAME = 'additional-files.zip';
const VALID_KINDS: ReadonlySet<AdditionalFileKind> = new Set(['pdf', 'pptx', 'png', 'jpeg']);

export interface AdditionalFilesArchive {
  name: string;
  data: ArrayBuffer;
}

interface ManifestEntry {
  path: string;
  name: string;
  kind: AdditionalFileKind;
  slideCount: number;
}

interface Manifest {
  version: number;
  files: ManifestEntry[];
}

function corrupt(): Error {
  return new Error('추가 자료 보관 파일이 손상되었습니다.');
}

function entryOf(value: unknown): ManifestEntry | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  if (
    typeof raw.path !== 'string' ||
    !/^files\/\d{4}$/.test(raw.path) ||
    typeof raw.name !== 'string' ||
    raw.name.length === 0 ||
    raw.name.length > 240 ||
    typeof raw.kind !== 'string' ||
    !VALID_KINDS.has(raw.kind as AdditionalFileKind) ||
    !Number.isSafeInteger(raw.slideCount) ||
    Number(raw.slideCount) < 1 ||
    Number(raw.slideCount) > 5000
  ) {
    return null;
  }
  return {
    path: raw.path,
    name: raw.name,
    kind: raw.kind as AdditionalFileKind,
    slideCount: Number(raw.slideCount),
  };
}

export async function encodeAdditionalFiles(
  files: AdditionalFile[],
): Promise<AdditionalFilesArchive | null> {
  if (files.length === 0) return null;
  const zip = new JSZip();
  const manifest: Manifest = {
    version: ARCHIVE_VERSION,
    files: files.map((file, index) => {
      const path = `files/${String(index).padStart(4, '0')}`;
      zip.file(path, file.data);
      return { path, name: file.name, kind: file.kind, slideCount: file.slideCount };
    }),
  };
  zip.file('manifest.json', JSON.stringify(manifest));
  const bytes = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
  return { name: ARCHIVE_NAME, data: bytes.buffer as ArrayBuffer };
}

export async function decodeAdditionalFiles(file: AdditionalFilesArchive): Promise<AdditionalFile[]> {
  try {
    const zip = await JSZip.loadAsync(file.data);
    const manifestFile = zip.file('manifest.json');
    if (!manifestFile) throw corrupt();
    const parsed = JSON.parse(await manifestFile.async('string')) as unknown;
    if (!parsed || typeof parsed !== 'object') throw corrupt();
    const raw = parsed as Record<string, unknown>;
    if (raw.version !== ARCHIVE_VERSION || !Array.isArray(raw.files) || raw.files.length > 5000) throw corrupt();
    const entries = raw.files.map(entryOf);
    if (entries.some((entry) => entry === null)) throw corrupt();
    const paths = new Set(entries.map((entry) => entry!.path));
    if (paths.size !== entries.length) throw corrupt();

    const restored: AdditionalFile[] = [];
    for (const entry of entries as ManifestEntry[]) {
      const archived = zip.file(entry.path);
      if (!archived) throw corrupt();
      const bytes = await archived.async('uint8array');
      if (detectAdditionalFileKind(entry.name, bytes) !== entry.kind) throw corrupt();
      restored.push({
        id: crypto.randomUUID(),
        name: entry.name,
        kind: entry.kind,
        data: bytes.buffer as ArrayBuffer,
        slideCount: entry.slideCount,
      });
    }
    return restored;
  } catch (error) {
    if (error instanceof Error && error.message === corrupt().message) throw error;
    throw corrupt();
  }
}
