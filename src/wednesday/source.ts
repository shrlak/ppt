// The 수요예배 snapshot that rides along with a saved deck, so 편집 can reopen
// the week on any machine — and the fingerprint auto-save compares to decide
// whether anything actually changed.
//
// It reuses the library's existing `source` file kind rather than adding a
// new one (the Worker builds its upload routes from that list). The Sunday
// decoder refuses a snapshot carrying `kind: 'wednesday'`, which is why the
// version number can stay at 1 on both sides: no existing 주일 snapshot is
// invalidated by this file existing.
import { DECK_SOURCE_FILE_NAME, type DeckSourceFile } from '../lib/storage/deckSource';
import { encodeAdditionalFiles, decodeAdditionalFiles } from '../lib/storage/additionalFilesArchive';
import type { AdditionalFile } from '../lib/additionalFiles/types';
import { DEFAULT_VERSES_PER_SLIDE, emptyWednesdayService, type WednesdayService, type WednesdaySong } from './types';

export const WEDNESDAY_SOURCE_KIND = 'wednesday';
export const WEDNESDAY_SOURCE_VERSION = 1;

interface StoredSong {
  id: string;
  title: string;
  slideCount?: number;
  origin?: WednesdaySong['origin'];
  sourceUrl?: string;
  sourceHost?: string;
  fileName?: string;
}

export interface WednesdaySource {
  kind: typeof WEDNESDAY_SOURCE_KIND;
  version: number;
  service: WednesdayService;
  songs: StoredSong[];
  fileNameOverride?: string;
}

/** True when a saved deck's snapshot belongs to the 수요예배 generator. */
export function isWednesdaySource(file: DeckSourceFile | null | undefined): boolean {
  if (!file) return false;
  try {
    const parsed = JSON.parse(new TextDecoder().decode(file.data)) as Record<string, unknown>;
    return parsed?.kind === WEDNESDAY_SOURCE_KIND;
  } catch {
    return false;
  }
}

export function encodeWednesdaySource(input: {
  service: WednesdayService;
  songs: WednesdaySong[];
  fileNameOverride?: string;
}): DeckSourceFile {
  const source: WednesdaySource = {
    kind: WEDNESDAY_SOURCE_KIND,
    version: WEDNESDAY_SOURCE_VERSION,
    service: input.service,
    songs: input.songs.map((song) => ({
      id: song.id,
      title: song.title,
      slideCount: song.slideCount,
      origin: song.origin,
      sourceUrl: song.sourceUrl,
      sourceHost: song.sourceHost,
      fileName: song.fileName,
    })),
    ...(input.fileNameOverride ? { fileNameOverride: input.fileNameOverride } : {}),
  };
  return {
    name: DECK_SOURCE_FILE_NAME,
    data: new TextEncoder().encode(JSON.stringify(source)).buffer as ArrayBuffer,
  };
}

export function decodeWednesdaySource(file: DeckSourceFile | null | undefined): WednesdaySource | null {
  if (!file) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(file.data));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const raw = parsed as Record<string, unknown>;
  if (raw.kind !== WEDNESDAY_SOURCE_KIND || raw.version !== WEDNESDAY_SOURCE_VERSION) return null;

  const service = raw.service as Partial<WednesdayService> | undefined;
  const songs = Array.isArray(raw.songs) ? raw.songs : [];
  return {
    kind: WEDNESDAY_SOURCE_KIND,
    version: WEDNESDAY_SOURCE_VERSION,
    service: {
      ...emptyWednesdayService(),
      ...service,
      versesPerSlide: Number.isFinite(service?.versesPerSlide)
        ? Math.min(10, Math.max(1, Number(service?.versesPerSlide)))
        : DEFAULT_VERSES_PER_SLIDE,
    },
    songs: songs.flatMap((song) => {
      if (!song || typeof song !== 'object') return [];
      const entry = song as Record<string, unknown>;
      if (typeof entry.id !== 'string' || typeof entry.title !== 'string') return [];
      return [
        {
          id: entry.id,
          title: entry.title,
          slideCount: typeof entry.slideCount === 'number' ? entry.slideCount : undefined,
          origin: entry.origin === 'download' || entry.origin === 'upload' ? entry.origin : undefined,
          sourceUrl: typeof entry.sourceUrl === 'string' ? entry.sourceUrl : undefined,
          sourceHost: typeof entry.sourceHost === 'string' ? entry.sourceHost : undefined,
          fileName: typeof entry.fileName === 'string' ? entry.fileName : undefined,
        },
      ];
    }),
    ...(typeof raw.fileNameOverride === 'string' ? { fileNameOverride: raw.fileNameOverride } : {}),
  };
}

/**
 * Pack the songs' own .pptx files into the one archive the library already
 * knows how to carry, so 편집 on another machine does not have to download
 * every 찬양 PPT again. The song library itself keeps links only — this is the
 * week's working copy, and the weekly purge clears it with everything else.
 */
export async function encodeWednesdaySongDecks(songs: WednesdaySong[]): Promise<{ name: string; data: ArrayBuffer } | null> {
  const files: AdditionalFile[] = songs.flatMap((song) =>
    song.deck
      ? [
          {
            id: song.id,
            name: songArchiveName(song),
            kind: 'pptx' as const,
            data: song.deck,
            slideCount: song.slideCount ?? 0,
          },
        ]
      : [],
  );
  if (files.length === 0) return null;
  return encodeAdditionalFiles(files);
}

/** Reattach each song's .pptx from the archive, matching on the stored name. */
export async function decodeWednesdaySongDecks(
  file: { name: string; data: ArrayBuffer } | null | undefined,
  songs: StoredSong[],
): Promise<WednesdaySong[]> {
  if (!file) return songs.map((song) => ({ ...song }));
  const unpacked = await decodeAdditionalFiles(file);
  const byName = new Map(unpacked.map((entry) => [entry.name, entry]));
  return songs.map((song) => {
    const match = byName.get(songArchiveName(song));
    return {
      ...song,
      deck: match?.data,
      slideCount: match ? (song.slideCount ?? match.slideCount) : undefined,
    };
  });
}

/** Archive entry name: unique per song, and recognizable when unzipped by hand. */
function songArchiveName(song: { id: string; title?: string }): string {
  const title = (song.title ?? '').trim().replace(/[\\/:*?"<>|]/g, '').slice(0, 40);
  return `${song.id}${title ? `-${title}` : ''}.pptx`;
}

/**
 * A stable string that changes exactly when the deck the operator would
 * download changes — the same idea as deckFingerprint for the Sunday flow,
 * over the inputs this generator actually has.
 */
export function wednesdayFingerprint(input: {
  name: string;
  service: WednesdayService;
  songs: WednesdaySong[];
}): string {
  return JSON.stringify({
    name: input.name.trim().replace(/\.pptx$/i, ''),
    service: {
      date: input.service.date,
      sermonTitle: input.service.sermonTitle.trim(),
      preacher: input.service.preacher.trim(),
      preacherTitle: input.service.preacherTitle.trim(),
      verseInput: input.service.verseInput.trim(),
      versesPerSlide: input.service.versesPerSlide,
    },
    // Songs are identified by title plus the file's size, like the Sunday
    // fingerprint's binaries: re-downloading the same 찬양 PPT is not an edit.
    songs: input.songs.map((song) => ({
      title: song.title.trim(),
      deck: song.deck ? `${song.fileName ?? ''}:${song.deck.byteLength}` : null,
    })),
  });
}
