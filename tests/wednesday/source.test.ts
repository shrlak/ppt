import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  decodeWednesdaySongDecks,
  decodeWednesdaySource,
  encodeWednesdaySongDecks,
  encodeWednesdaySource,
  isWednesdaySource,
  wednesdayFingerprint,
} from '../../src/wednesday/source';
import { decodeDeckSource, encodeDeckSource } from '../../src/lib/storage/deckSource';
import type { WednesdayService, WednesdaySong } from '../../src/wednesday/types';

const service: WednesdayService = {
  date: '2026-09-16',
  sermonTitle: '나의 힘이 되신 여호와여',
  preacher: '고신석',
  preacherTitle: '목사',
  verseInput: '시18:1-12',
  versesPerSlide: 3,
};

// Real .pptx bytes: the archive re-sniffs each entry's type on the way out,
// so a placeholder buffer would read as a corrupt archive.
const publicDir = join(__dirname, '..', '..', 'public');
const REAL_DECKS = [
  readFileSync(join(publicDir, 'bible-template.pptx')),
  readFileSync(join(publicDir, 'front-slides.pptx')),
];

function songWithDeck(id: string, title: string, which = 0): WednesdaySong {
  const bytes = REAL_DECKS[which];
  return {
    id,
    title,
    deck: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
    slideCount: 4,
    origin: 'upload',
    fileName: `${title}.pptx`,
  };
}

describe('wednesday deck source', () => {
  it('round-trips the service details and the song list', () => {
    const songs: WednesdaySong[] = [
      songWithDeck('s1', '나의 반석이신 하나님'),
      { id: 's2', title: '하늘 위에 주님 밖에', origin: 'download', sourceUrl: 'https://example.test/a.pptx' },
    ];
    const file = encodeWednesdaySource({ service, songs, fileNameOverride: '0916.pptx' });
    const decoded = decodeWednesdaySource(file);

    expect(decoded?.service).toEqual(service);
    expect(decoded?.songs.map((song) => song.title)).toEqual([
      '나의 반석이신 하나님',
      '하늘 위에 주님 밖에',
    ]);
    expect(decoded?.songs[1].sourceUrl).toBe('https://example.test/a.pptx');
    expect(decoded?.fileNameOverride).toBe('0916.pptx');
  });

  it('is recognizable without being decoded in full', () => {
    expect(isWednesdaySource(encodeWednesdaySource({ service, songs: [] }))).toBe(true);
    expect(
      isWednesdaySource(
        encodeDeckSource({
          songs: [],
          bible: { verseInput: '', sermonTitle: '', translations: ['nkrv'], versesPerSlide: 1 },
          announcementText: '',
        }),
      ),
    ).toBe(false);
    expect(isWednesdaySource(null)).toBe(false);
  });

  it('is refused by the Sunday decoder, and vice versa', () => {
    // Both snapshots share the library's one `source` file kind, so each
    // decoder has to recognize the other's and decline it.
    expect(decodeDeckSource(encodeWednesdaySource({ service, songs: [] }))).toBeNull();
    expect(
      decodeWednesdaySource(
        encodeDeckSource({
          songs: [],
          bible: { verseInput: '롬5:1', sermonTitle: '', translations: ['nkrv'], versesPerSlide: 1 },
          announcementText: '',
        }),
      ),
    ).toBeNull();
  });

  it('survives a snapshot with junk in it', () => {
    expect(decodeWednesdaySource({ name: 'x', data: new TextEncoder().encode('not json').buffer as ArrayBuffer })).toBeNull();
    const partial = {
      name: 'deck-source.json',
      data: new TextEncoder().encode(
        JSON.stringify({ kind: 'wednesday', version: 1, service: { date: '2026-09-16' }, songs: [null, { id: 'a' }] }),
      ).buffer as ArrayBuffer,
    };
    const decoded = decodeWednesdaySource(partial);
    expect(decoded?.service.date).toBe('2026-09-16');
    expect(decoded?.service.versesPerSlide).toBe(3);
    expect(decoded?.songs).toEqual([]);
  });
});

describe('wednesday song archive', () => {
  it('packs each song\'s file and reattaches it by song', async () => {
    const songs = [songWithDeck('s1', '첫 곡', 0), songWithDeck('s2', '둘째 곡', 1)];
    const archive = await encodeWednesdaySongDecks(songs);
    expect(archive).not.toBeNull();

    const stored = songs.map((song) => ({
      id: song.id,
      title: song.title,
      slideCount: song.slideCount,
      fileName: song.fileName,
    }));
    const restored = await decodeWednesdaySongDecks(archive, stored);
    expect(restored.map((song) => song.deck?.byteLength)).toEqual([
      REAL_DECKS[0].byteLength,
      REAL_DECKS[1].byteLength,
    ]);
    expect(restored.map((song) => song.slideCount)).toEqual([4, 4]);
  });

  it('packs nothing when no song has a file yet', async () => {
    expect(await encodeWednesdaySongDecks([{ id: 's1', title: '아직' }])).toBeNull();
    const restored = await decodeWednesdaySongDecks(null, [{ id: 's1', title: '아직' }]);
    expect(restored[0].deck).toBeUndefined();
    expect(restored[0].slideCount).toBeUndefined();
  });
});

describe('wednesdayFingerprint', () => {
  const songs = [songWithDeck('s1', '첫 곡')];

  it('ignores edits that cannot change a slide', () => {
    const base = wednesdayFingerprint({ name: '0916.pptx', service, songs });
    expect(wednesdayFingerprint({ name: '0916', service, songs })).toBe(base);
    // A restored week mints new ids; that is not an edit.
    expect(
      wednesdayFingerprint({
        name: '0916.pptx',
        service,
        songs: [{ ...songs[0], id: 'other-id' }],
      }),
    ).toBe(base);
  });

  it('changes when anything on a slide changes', () => {
    const base = wednesdayFingerprint({ name: '0916.pptx', service, songs });
    expect(wednesdayFingerprint({ name: '0923.pptx', service, songs })).not.toBe(base);
    expect(
      wednesdayFingerprint({ name: '0916.pptx', service: { ...service, preacher: '다른 분' }, songs }),
    ).not.toBe(base);
    expect(
      wednesdayFingerprint({ name: '0916.pptx', service: { ...service, versesPerSlide: 4 }, songs }),
    ).not.toBe(base);
    expect(
      wednesdayFingerprint({ name: '0916.pptx', service, songs: [songWithDeck('s1', '첫 곡', 1)] }),
    ).not.toBe(base);
    expect(wednesdayFingerprint({ name: '0916.pptx', service, songs: [] })).not.toBe(base);
  });
});
