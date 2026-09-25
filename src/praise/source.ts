// The 찬양집회 snapshot that rides along with a saved deck, so 편집 can reopen
// the night on any machine — and the fingerprint auto-save compares to
// decide whether anything actually changed.
//
// Like the 수요예배 snapshot it reuses the library's `source` file kind,
// tagged `kind: 'praise'`; the Sunday decoder refuses any kind but its own,
// so a 찬양집회 entry can never open as an empty 주일 week. 추가 자료 and a
// replaced cover photo travel in the entry's additional-files archive, the
// cover last.
import { DECK_SOURCE_FILE_NAME, songOf, type DeckSourceFile } from '../lib/storage/deckSource';
import { decodeAdditionalFiles, encodeAdditionalFiles } from '../lib/storage/additionalFilesArchive';
import type { AdditionalFile } from '../lib/additionalFiles/types';
import type { Song } from '../lib/utils/types';
import type { AdditionalPlacement, PlacedAdditional } from './planner';
import type { PraiseCoverImage, PraiseEnglish, PraiseSongExtras } from './types';

export const PRAISE_SOURCE_KIND = 'praise';
export const PRAISE_SOURCE_VERSION = 1;

export interface PraiseSource {
  kind: typeof PRAISE_SOURCE_KIND;
  version: number;
  date: string;
  songs: Song[];
  extras: Record<string, PraiseSongExtras>;
  /** One per archived 추가 자료 file, in archive order. */
  additional: { name: string; placement: AdditionalPlacement }[];
  /** The replaced cover photo is the archive's last entry. */
  cover?: { name: string; mimeType: PraiseCoverImage['mimeType'] };
  fileNameOverride?: string;
}

/** True when a saved deck's snapshot belongs to the 찬양집회 generator. */
export function isPraiseSource(file: DeckSourceFile | null | undefined): boolean {
  if (!file) return false;
  try {
    return (JSON.parse(new TextDecoder().decode(file.data)) as Record<string, unknown>)?.kind === PRAISE_SOURCE_KIND;
  } catch {
    return false;
  }
}

export interface PraiseState {
  date: string;
  songs: Song[];
  extras: Record<string, PraiseSongExtras>;
  additionalFiles: AdditionalFile[];
  placements: PlacedAdditional[];
  coverImage: PraiseCoverImage | null;
  fileNameOverride?: string;
}

function placementFor(state: PraiseState, fileId: string): AdditionalPlacement {
  return state.placements.find((item) => item.fileId === fileId)?.placement ?? 'end';
}

export function encodePraiseSource(state: PraiseState): DeckSourceFile {
  const source: PraiseSource = {
    kind: PRAISE_SOURCE_KIND,
    version: PRAISE_SOURCE_VERSION,
    date: state.date,
    songs: state.songs,
    extras: state.extras,
    additional: state.additionalFiles.map((file) => ({ name: file.name, placement: placementFor(state, file.id) })),
    ...(state.coverImage ? { cover: { name: state.coverImage.name, mimeType: state.coverImage.mimeType } } : {}),
    ...(state.fileNameOverride ? { fileNameOverride: state.fileNameOverride } : {}),
  };
  return {
    name: DECK_SOURCE_FILE_NAME,
    data: new TextEncoder().encode(JSON.stringify(source)).buffer as ArrayBuffer,
  };
}

/** 추가 자료 then the cover photo, as one archive (null when there is neither). */
export async function encodePraiseFiles(state: PraiseState) {
  const files = [...state.additionalFiles];
  if (state.coverImage) {
    files.push({
      id: 'praise-cover',
      name: state.coverImage.name,
      kind: state.coverImage.mimeType === 'image/png' ? 'png' : 'jpeg',
      data: state.coverImage.data,
      slideCount: 1,
    });
  }
  return encodeAdditionalFiles(files);
}

function lineList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((line): line is string => typeof line === 'string') : [];
}

function englishOf(value: unknown): PraiseEnglish {
  const raw = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  const slides: Record<string, string[]> = {};
  if (raw.slides && typeof raw.slides === 'object' && !Array.isArray(raw.slides)) {
    for (const [key, lines] of Object.entries(raw.slides as Record<string, unknown>)) slides[key] = lineList(lines);
  }
  return { title: typeof raw.title === 'string' ? raw.title : '', slides };
}

function extrasOf(value: unknown): Record<string, PraiseSongExtras> {
  const result: Record<string, PraiseSongExtras> = {};
  if (!value || typeof value !== 'object') return result;
  for (const [id, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!raw || typeof raw !== 'object') continue;
    const entry = raw as Record<string, unknown>;
    const source = entry.englishSource;
    result[id] = {
      english: englishOf(entry.english),
      ...(entry.prayerAfter === true ? { prayerAfter: true } : {}),
      ...(source === 'memory' || source === 'ai' || source === 'manual' ? { englishSource: source } : {}),
    };
  }
  return result;
}

function placementOf(value: unknown): AdditionalPlacement {
  if (value === 'start' || value === 'end') return value;
  if (value && typeof value === 'object' && typeof (value as { afterSongId?: unknown }).afterSongId === 'string') {
    return { afterSongId: (value as { afterSongId: string }).afterSongId };
  }
  return 'end';
}

export function decodePraiseSource(file: DeckSourceFile | null | undefined): PraiseSource | null {
  if (!file) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(file.data));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const raw = parsed as Record<string, unknown>;
  if (raw.kind !== PRAISE_SOURCE_KIND || raw.version !== PRAISE_SOURCE_VERSION) return null;
  const cover = raw.cover as Record<string, unknown> | undefined;
  return {
    kind: PRAISE_SOURCE_KIND,
    version: PRAISE_SOURCE_VERSION,
    date: typeof raw.date === 'string' ? raw.date : '',
    songs: Array.isArray(raw.songs) ? raw.songs.flatMap((song) => songOf(song) ?? []) : [],
    extras: extrasOf(raw.extras),
    additional: (Array.isArray(raw.additional) ? raw.additional : []).map((item) => {
      const entry = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>;
      return { name: typeof entry.name === 'string' ? entry.name : '', placement: placementOf(entry.placement) };
    }),
    ...(cover && typeof cover.name === 'string'
      ? { cover: { name: cover.name, mimeType: cover.mimeType === 'image/png' ? 'image/png' : 'image/jpeg' } }
      : {}),
    ...(typeof raw.fileNameOverride === 'string' ? { fileNameOverride: raw.fileNameOverride } : {}),
  } as PraiseSource;
}

/** Everything a reopened entry needs: the snapshot plus its archived files. */
export async function restorePraiseState(
  source: PraiseSource,
  archive: { name: string; data: ArrayBuffer } | null | undefined,
): Promise<PraiseState> {
  const files = archive ? await decodeAdditionalFiles(archive) : [];
  const coverFile = source.cover && files.length > source.additional.length ? files.pop() : undefined;
  const placements = files.map((file, index) => ({
    fileId: file.id,
    placement: source.additional[index]?.placement ?? 'end',
  }));
  return {
    date: source.date,
    songs: source.songs,
    extras: source.extras,
    additionalFiles: files,
    placements,
    coverImage:
      coverFile && source.cover
        ? { name: source.cover.name, mimeType: source.cover.mimeType, data: coverFile.data }
        : null,
    fileNameOverride: source.fileNameOverride,
  };
}

/** Changes exactly when the deck the operator would download changes. */
export function praiseFingerprint(state: PraiseState & { name: string }): string {
  return JSON.stringify({
    name: state.name.trim().replace(/\.pptx$/i, ''),
    date: state.date,
    songs: state.songs.map((song) => ({
      id: song.id,
      title: song.title,
      sections: song.sections,
      order: song.order,
      linesPerSlide: song.linesPerSlide,
    })),
    extras: state.extras,
    files: state.additionalFiles.map((file) => `${file.name}:${file.data.byteLength}`),
    placements: state.placements,
    cover: state.coverImage ? `${state.coverImage.name}:${state.coverImage.data.byteLength}` : null,
  });
}
