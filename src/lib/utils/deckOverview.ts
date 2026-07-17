// Builds the ordered, read-only slide list shown on the left of the 편집기
// (PPT editor) view — one row per slide in the exact sequence generate()
// assembles: Front → 찬양 → 기도 → 성경 말씀 → 설교 → 기도 → 광고 → Back.
// Pure and DOM-free so the ordering logic is unit-testable on its own.
import type { AnnouncementItem } from './announcementBuilder';
import type { Song } from './types';
import { planAllSlides } from './slidePlanner';

export type DeckOverviewKind =
  | 'front'
  | 'lyrics-title'
  | 'lyrics'
  | 'prayer'
  | 'bible'
  | 'sermon'
  | 'announcement'
  | 'back';

export interface DeckOverviewItem {
  id: string;
  kind: DeckOverviewKind;
  /** Main line, e.g. the song title or announcement title. */
  label: string;
  /** Secondary line, e.g. the first lyric line or a slide count. */
  subtitle?: string;
  /** For 'lyrics-title'/'lyrics' rows: which song this slide belongs to. */
  songId?: string;
}

export interface DeckOverviewParams {
  songs: Song[];
  frontSlideCount: number;
  backSlideCount: number;
  bibleVerseCount: number;
  sermonFileName?: string;
  announcementItems: AnnouncementItem[];
}

/** Build the full, ordered slide overview from the app's already-lifted state. */
export function buildDeckOverview(params: DeckOverviewParams): DeckOverviewItem[] {
  const items: DeckOverviewItem[] = [];

  items.push({
    id: 'front',
    kind: 'front',
    label: 'Front 슬라이드',
    subtitle: `${params.frontSlideCount}장`,
  });

  let songIndex = 0;
  for (const song of params.songs) {
    for (const plan of planAllSlides([song])) {
      if (plan.kind === 'title') {
        items.push({
          id: `song-${song.id}-title-${songIndex}`,
          kind: 'lyrics-title',
          label: song.title.trim() || '(제목 없음)',
          songId: song.id,
        });
      } else {
        items.push({
          id: `song-${song.id}-lyrics-${items.length}`,
          kind: 'lyrics',
          label: song.title.trim() || '(제목 없음)',
          subtitle: (plan.lines ?? []).join(' / '),
          songId: song.id,
        });
      }
    }
    songIndex += 1;
  }

  items.push({ id: 'prayer-1', kind: 'prayer', label: '기도' });

  if (params.bibleVerseCount > 0) {
    items.push({
      id: 'bible',
      kind: 'bible',
      label: '성경 말씀',
      subtitle: `${params.bibleVerseCount}구절`,
    });
  }

  if (params.sermonFileName) {
    items.push({
      id: 'sermon',
      kind: 'sermon',
      label: '설교',
      subtitle: params.sermonFileName,
    });
  }

  items.push({ id: 'prayer-2', kind: 'prayer', label: '기도' });

  params.announcementItems.forEach((item, index) => {
    items.push({
      id: `announcement-${index}`,
      kind: 'announcement',
      label: item.title || `광고 ${index + 1}`,
    });
  });

  items.push({
    id: 'back',
    kind: 'back',
    label: 'Back 슬라이드',
    subtitle: `${params.backSlideCount}장`,
  });

  return items;
}
