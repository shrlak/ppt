// Placeholder in-memory data so the Phase 1 UI is browsable.
// Phase 2 replaces this with the SQLite-backed store (tauri-plugin-sql).
import type { Setlist, SlideTheme, Song } from '../types';
import { DEFAULT_THEME } from '../types';

export const demoSongs: Song[] = [
  {
    id: 'demo-1',
    title: '주님의 사랑',
    artist: '김준영 / 임선호',
    originalKey: 'E',
    bpm: 72,
    ccli: null,
    tags: ['praise', 'slow'],
    notes: 'No key change. 콘티 기본 순서: I-V1-V2-PC-C',
    sections: [
      {
        id: 'demo-1-v1',
        songId: 'demo-1',
        type: 'Verse 1',
        content: '눈부신 햇살\n저 하늘 너머 내게 주어진',
        position: 0,
      },
      {
        id: 'demo-1-c',
        songId: 'demo-1',
        type: 'Chorus',
        content: '내 안에 기쁨의 노래\n멈출 수가 없네',
        position: 1,
      },
    ],
    createdAt: '2026-07-10T00:00:00Z',
    updatedAt: '2026-07-10T00:00:00Z',
  },
  {
    id: 'demo-2',
    title: 'Amazing Grace (My Chains Are Gone)',
    artist: 'Chris Tomlin',
    originalKey: 'G',
    bpm: 63,
    ccli: '4768151',
    tags: ['praise', 'invitation'],
    notes: '',
    sections: [
      {
        id: 'demo-2-v1',
        songId: 'demo-2',
        type: 'Verse 1',
        content:
          '[G]Amazing grace how [C]sweet the [G]sound\nThat saved a wretch like [D]me',
        position: 0,
      },
    ],
    createdAt: '2026-07-10T00:00:00Z',
    updatedAt: '2026-07-10T00:00:00Z',
  },
];

export const demoSetlists: Setlist[] = [
  {
    id: 'demo-setlist-1',
    date: '2026-07-11',
    title: '주일 예배',
    items: [
      {
        id: 'demo-item-1',
        setlistId: 'demo-setlist-1',
        position: 0,
        kind: 'service',
        serviceSection: 'Opening Prayer',
        transitionNote: '',
      },
      {
        id: 'demo-item-2',
        setlistId: 'demo-setlist-1',
        position: 1,
        kind: 'song',
        songId: 'demo-1',
        performanceKey: 'E',
        transitionNote: '바로 이어서',
      },
    ],
    createdAt: '2026-07-10T00:00:00Z',
    updatedAt: '2026-07-10T00:00:00Z',
  },
];

export const demoThemes: SlideTheme[] = [DEFAULT_THEME];
