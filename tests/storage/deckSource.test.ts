import { describe, expect, it } from 'vitest';
import {
  DECK_SOURCE_VERSION,
  decodeDeckSource,
  encodeDeckSource,
  type DeckSourceFile,
} from '../../src/lib/storage/deckSource';
import type { Song } from '../../src/lib/utils/types';

const song: Song = {
  id: 'song-1',
  title: '주 은혜임을',
  key: 'E',
  description: '1절부터',
  sections: [{ label: 'V1', lines: ['내가 살아가는 날 동안', '주 은혜임을'] }],
  order: ['I', 'V1', 'C'],
  linesPerSlide: 4,
  pageIndex: 3,
};

const source = {
  contiDate: '7/26/26',
  songs: [song],
  bible: { verseInput: '요3:16', sermonTitle: '사랑', translations: ['nkrv', 'esv'], versesPerSlide: 2 },
  announcementText: '1. **<새가족 환영>**\n환영합니다.',
};

function fileOf(json: unknown): DeckSourceFile {
  return { name: 'deck-source.json', data: new TextEncoder().encode(JSON.stringify(json)).buffer as ArrayBuffer };
}

describe('deck source snapshots', () => {
  it('round-trips every wizard input', () => {
    const decoded = decodeDeckSource(encodeDeckSource(source));
    expect(decoded).toEqual({ ...source, version: DECK_SOURCE_VERSION });
  });

  it('keeps song lyrics, order and score page intact', () => {
    const restored = decodeDeckSource(encodeDeckSource(source))!.songs[0];
    expect(restored).toEqual(song);
  });

  it('treats a missing snapshot as "nothing to restore"', () => {
    expect(decodeDeckSource(null)).toBeNull();
    expect(decodeDeckSource(undefined)).toBeNull();
  });

  it('rejects corrupt JSON and unknown snapshot versions instead of throwing', () => {
    expect(decodeDeckSource({ name: 'x.json', data: new TextEncoder().encode('{not json').buffer as ArrayBuffer })).toBeNull();
    expect(decodeDeckSource(fileOf({ ...source, version: DECK_SOURCE_VERSION + 1 }))).toBeNull();
  });

  it('fills in defaults for a snapshot missing optional fields', () => {
    const decoded = decodeDeckSource(fileOf({ version: DECK_SOURCE_VERSION }));
    expect(decoded).toEqual({
      version: DECK_SOURCE_VERSION,
      songs: [],
      bible: { verseInput: '', sermonTitle: '', translations: ['nkrv', 'esv'], versesPerSlide: 1 },
      announcementText: '',
    });
  });

  it('drops malformed songs and sections rather than restoring broken cards', () => {
    const decoded = decodeDeckSource(
      fileOf({
        version: DECK_SOURCE_VERSION,
        songs: [{ title: 42 }, { title: '제목만', sections: [{ label: 'V1' }, { label: 'C', lines: ['가사', 7] }] }],
      }),
    );
    expect(decoded!.songs).toHaveLength(1);
    expect(decoded!.songs[0]).toMatchObject({
      title: '제목만',
      sections: [{ label: 'C', lines: ['가사'] }],
      order: [],
      linesPerSlide: 4,
    });
  });

  it('gives a song with no saved id a fresh one', () => {
    const decoded = decodeDeckSource(fileOf({ version: DECK_SOURCE_VERSION, songs: [{ title: '무명' }] }));
    expect(decoded!.songs[0].id).toBeTruthy();
  });
});
