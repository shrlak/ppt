// The retreat snapshot saved beside each session's deck in the PPT 라이브러리,
// and the local draft that makes a reload free.
//
// Like the 찬양집회 and 수요예배 snapshots it rides in the library's `source`
// file, tagged `kind: 'retreat'` (the Sunday decoder refuses other kinds).
// Every session's deck carries the whole retreat, so 편집 on any of them
// reopens all of it; the posters travel in the entry's archive.
import { DECK_SOURCE_FILE_NAME, type DeckSourceFile } from '../lib/storage/deckSource';
import { decodeAdditionalFiles, encodeAdditionalFiles } from '../lib/storage/additionalFilesArchive';
import type { ContiSlotKey, PosterImage, RetreatBlock, RetreatSession, RetreatSong, RetreatState } from './types';

export const RETREAT_SOURCE_KIND = 'retreat';
export const RETREAT_SOURCE_VERSION = 1;

type StoredPoster = Omit<PosterImage, 'data'>;
type StoredSession = Omit<RetreatSession, 'poster'> & { poster: StoredPoster | null };
/** The retreat as saved: every poster's metadata, none of its bytes. */
export type StoredRetreatState = Omit<RetreatState, 'sessions'> & { sessions: StoredSession[] };

interface RetreatSnapshot {
  kind: typeof RETREAT_SOURCE_KIND;
  version: number;
  state: StoredRetreatState;
  /** The session this entry's deck is. */
  sessionId?: string;
}

export function isRetreatSource(file: DeckSourceFile | null | undefined): boolean {
  if (!file) return false;
  try {
    return (JSON.parse(new TextDecoder().decode(file.data)) as Record<string, unknown>)?.kind === RETREAT_SOURCE_KIND;
  } catch {
    return false;
  }
}

function withoutPosterBytes(state: RetreatState): StoredRetreatState {
  return {
    ...state,
    sessions: state.sessions.map((session) => ({
      ...session,
      poster: session.poster ? { ...session.poster, data: undefined } : null,
    })) as StoredSession[],
  };
}

export function encodeRetreatSource(state: RetreatState, sessionId?: string): DeckSourceFile {
  const snapshot: RetreatSnapshot = {
    kind: RETREAT_SOURCE_KIND,
    version: RETREAT_SOURCE_VERSION,
    state: JSON.parse(JSON.stringify(withoutPosterBytes(state))),
    ...(sessionId ? { sessionId } : {}),
  };
  return { name: DECK_SOURCE_FILE_NAME, data: new TextEncoder().encode(JSON.stringify(snapshot)).buffer as ArrayBuffer };
}

/** Posters in session order, one archive entry each (null when there are none). */
export async function encodeRetreatPosters(state: RetreatState) {
  const files = state.sessions.flatMap((session) =>
    session.poster
      ? [
          {
            id: session.id,
            name: `${session.id}.${session.poster.mimeType === 'image/png' ? 'png' : 'jpg'}`,
            kind: session.poster.mimeType === 'image/png' ? ('png' as const) : ('jpeg' as const),
            data: session.poster.data,
            slideCount: 1,
          },
        ]
      : [],
  );
  return encodeAdditionalFiles(files);
}

function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function blockOf(raw: unknown): RetreatBlock | null {
  if (!raw || typeof raw !== 'object') return null;
  const block = raw as Record<string, unknown>;
  const id = text(block.id) || `${Math.random()}`;
  switch (block.kind) {
    case 'title':
    case 'blank':
      return { id, kind: block.kind };
    case 'songs': {
      const songs = (Array.isArray(block.songs) ? block.songs : []).flatMap((raw) => {
        if (!raw || typeof raw !== 'object') return [];
        const entry = raw as Record<string, unknown>;
        const source = entry.source;
        const song: RetreatSong = { id: text(entry.id) || `${Math.random()}`, title: text(entry.title), lyrics: text(entry.lyrics) };
        if (source === 'retreat' || source === 'library' || source === 'manual') song.source = source;
        return [song];
      });
      const slot = block.slot as { day?: unknown; part?: unknown } | undefined;
      const validSlot =
        slot && ['금', '토', '주일'].includes(slot.day as string) && ['예배', '기도회', '특강', '찬양집회'].includes(slot.part as string);
      return {
        id,
        kind: 'songs',
        label: text(block.label),
        songs,
        ...(validSlot ? { slot: { day: slot.day, part: slot.part } as ContiSlotKey } : {}),
      };
    }
    case 'scripture':
      return { id, kind: 'scripture', passage: text(block.passage) };
    case 'sermon':
      return { id, kind: 'sermon', title: text(block.title) };
    case 'prayer':
    case 'benediction':
      return { id, kind: block.kind, label: text(block.label) };
    case 'announcements':
      return { id, kind: 'announcements', label: text(block.label), text: text(block.text) };
    default:
      return null;
  }
}

function posterMetaOf(raw: unknown): StoredPoster | null {
  if (!raw || typeof raw !== 'object') return null;
  const poster = raw as Record<string, unknown>;
  const width = Number(poster.width);
  const height = Number(poster.height);
  if (!(width > 0) || !(height > 0)) return null;
  return {
    name: text(poster.name, 'poster.png'),
    mimeType: poster.mimeType === 'image/png' ? 'image/png' : 'image/jpeg',
    width,
    height,
    background: /^[0-9A-Fa-f]{6}$/.test(text(poster.background)) ? text(poster.background) : '000000',
  };
}

/**
 * Read a snapshot back (posters without their bytes — `attachPosters` puts
 * them back). Null for anything that is not a retreat snapshot.
 */
export function decodeRetreatState(raw: unknown): { state: StoredRetreatState; sessionId?: string } | null {
  if (!raw || typeof raw !== 'object') return null;
  const snapshot = raw as Record<string, unknown>;
  if (snapshot.kind !== RETREAT_SOURCE_KIND || snapshot.version !== RETREAT_SOURCE_VERSION) return null;
  const state = (snapshot.state ?? {}) as Record<string, unknown>;
  const info = (state.info ?? {}) as Record<string, unknown>;
  const sessions = (Array.isArray(state.sessions) ? state.sessions : []).flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const session = item as Record<string, unknown>;
    return [
      {
        id: text(session.id) || `${Math.random()}`,
        name: text(session.name),
        date: text(session.date),
        poster: posterMetaOf(session.poster),
        blocks: (Array.isArray(session.blocks) ? session.blocks : []).flatMap((block) => blockOf(block) ?? []),
      },
    ];
  });
  return {
    state: {
      info: { title: text(info.title), subtitle: text(info.subtitle), theme: text(info.theme) },
      sessions,
      closingSongs: (Array.isArray(state.closingSongs) ? state.closingSongs : []).filter(
        (title): title is string => typeof title === 'string',
      ),
    },
    ...(typeof snapshot.sessionId === 'string' ? { sessionId: snapshot.sessionId } : {}),
  };
}

export function decodeRetreatSource(file: DeckSourceFile | null | undefined) {
  if (!file) return null;
  try {
    return decodeRetreatState(JSON.parse(new TextDecoder().decode(file.data)));
  } catch {
    return null;
  }
}

/** Give each session back its poster bytes; a poster whose bytes are missing is dropped. */
export function attachPosters(state: StoredRetreatState, posterData: Map<string, ArrayBuffer>): RetreatState {
  return {
    ...state,
    sessions: state.sessions.map((session) => {
      const data = posterData.get(session.id);
      return { ...session, poster: session.poster && data ? { ...session.poster, data } : null };
    }),
  };
}

/** Posters out of a library entry's archive, by session id. */
export async function decodeRetreatPosters(archive: { name: string; data: ArrayBuffer } | null | undefined) {
  const posters = new Map<string, ArrayBuffer>();
  if (!archive) return posters;
  for (const file of await decodeAdditionalFiles(archive)) {
    posters.set(file.name.replace(/\.(png|jpe?g)$/i, ''), file.data);
  }
  return posters;
}

/** Changes exactly when some session's deck would change. */
export function retreatFingerprint(state: RetreatState): string {
  return JSON.stringify({
    ...withoutPosterBytes(state),
    posters: state.sessions.map((session) => session.poster?.data.byteLength ?? 0),
  });
}
