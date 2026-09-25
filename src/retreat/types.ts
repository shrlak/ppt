// The 수련회 generator's state: the retreat itself, and one session (집회) per
// deck. Each session is an ordered list of blocks — the 예배 순서 — and each
// block becomes a run of slides in the retreat's own design.

export interface RetreatInfo {
  /** e.g. "2026 빛주사랑 겨울 수련회" — the title slide and every 광고 footer. */
  title: string;
  /** e.g. "피츠버그 한인 중앙교회 대학청년부". */
  subtitle: string;
  /** e.g. "불과 폭풍 속에서도, 주와 함께 걷는 길 (이사야 43:1-2)" — the 광고 footer. */
  theme: string;
}

export interface RetreatSong {
  id: string;
  title: string;
  /**
   * The lyrics as they will be projected: one line per line, a blank line
   * between slides. A slide longer than four lines is split evenly.
   */
  lyrics: string;
  /** Where the lyrics came from, for the card's hint. */
  source?: 'retreat' | 'library' | 'manual';
}

export interface PosterImage {
  name: string;
  mimeType: 'image/png' | 'image/jpeg';
  data: ArrayBuffer;
  width: number;
  height: number;
  /** Colour behind the poster (its own edge colour), `RRGGBB`. */
  background: string;
}

/** Which conti column feeds a songs block: day and part of the schedule. */
export interface ContiSlotKey {
  day: '금' | '토' | '주일';
  part: '예배' | '기도회' | '특강' | '찬양집회';
}

export type RetreatBlock =
  | { id: string; kind: 'title' }
  | { id: string; kind: 'songs'; label: string; songs: RetreatSong[]; slot?: ContiSlotKey }
  | { id: string; kind: 'scripture'; passage: string }
  | { id: string; kind: 'sermon'; title: string }
  | { id: string; kind: 'blank' }
  | { id: string; kind: 'prayer'; label: string }
  | { id: string; kind: 'benediction'; label: string }
  | { id: string; kind: 'announcements'; label: string; text: string };

export type RetreatBlockKind = RetreatBlock['kind'];

export interface RetreatSession {
  id: string;
  /** e.g. "금요일 저녁예배". */
  name: string;
  /** `YYYY-MM-DD`, for the file name. */
  date: string;
  poster: PosterImage | null;
  blocks: RetreatBlock[];
}

export interface RetreatState {
  info: RetreatInfo;
  sessions: RetreatSession[];
  /**
   * The conti's 주일 column. The closing Sunday service is made with the 주일예배
   * generator (it is a Sunday deck), so its songs are only listed here.
   */
  closingSongs: string[];
}

export const BLOCK_LABELS: Record<RetreatBlockKind, string> = {
  title: '수련회 제목',
  songs: '찬양',
  scripture: '설교말씀 (본문)',
  sermon: '설교 제목',
  blank: '빈 화면',
  prayer: '기도',
  benediction: '축도',
  announcements: '광고',
};

export function newId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  }
}

export function createBlock(kind: RetreatBlockKind): RetreatBlock {
  const id = newId();
  switch (kind) {
    case 'songs':
      return { id, kind, label: '찬양', songs: [] };
    case 'scripture':
      return { id, kind, passage: '' };
    case 'sermon':
      return { id, kind, title: '' };
    case 'prayer':
      return { id, kind, label: '기도' };
    case 'benediction':
      return { id, kind, label: '축도' };
    case 'announcements':
      return { id, kind, label: '광고 | 안내', text: '' };
    default:
      return { id, kind } as RetreatBlock;
  }
}

function songs(label: string, slot: ContiSlotKey): RetreatBlock {
  return { id: newId(), kind: 'songs', label, songs: [], slot };
}

/**
 * The 2026 retreat's order of service (예배 순서), which is the shape each
 * year's decks take: 금 저녁예배, 토 오전 특강, 토 저녁예배. 토 오후 워크샵
 * has no slides, and 주일 폐회예배 is a Sunday service made with the 주일예배
 * generator.
 */
export function defaultRetreat(): RetreatState {
  return {
    info: {
      title: '2026 빛주사랑 겨울 수련회',
      subtitle: '피츠버그 한인 중앙교회 대학청년부',
      theme: '불과 폭풍 속에서도, 주와 함께 걷는 길 (이사야 43:1-2)',
    },
    sessions: [
      {
        id: newId(),
        name: '금요일 저녁예배',
        date: '',
        poster: null,
        blocks: [
          createBlock('title'),
          songs('찬양', { day: '금', part: '예배' }),
          createBlock('scripture'),
          createBlock('sermon'),
          createBlock('blank'),
          songs('기도회', { day: '금', part: '기도회' }),
          createBlock('prayer'),
          createBlock('benediction'),
          { ...createBlock('announcements'), label: 'OT | 광고' } as RetreatBlock,
        ],
      },
      {
        id: newId(),
        name: '토요일 오전 특강',
        date: '',
        poster: null,
        blocks: [createBlock('title'), songs('찬양', { day: '토', part: '특강' }), createBlock('announcements')],
      },
      {
        id: newId(),
        name: '토요일 저녁예배',
        date: '',
        poster: null,
        blocks: [
          createBlock('title'),
          songs('찬양', { day: '토', part: '예배' }),
          createBlock('scripture'),
          createBlock('sermon'),
          songs('기도회', { day: '토', part: '기도회' }),
          songs('찬양집회', { day: '토', part: '찬양집회' }),
          createBlock('prayer'),
          createBlock('benediction'),
          createBlock('announcements'),
        ],
      },
    ],
    closingSongs: [],
  };
}
