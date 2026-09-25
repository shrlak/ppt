import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import {
  buildPraiseDeck,
  formatCoverDate,
  suggestPraiseFileName,
} from '../../src/praise/deckBuilder';
import { slideKey } from '../../src/praise/planner';
import { decodePraiseSource, encodePraiseFiles, encodePraiseSource, isPraiseSource, restorePraiseState } from '../../src/praise/source';
import { decodeDeckSource } from '../../src/lib/storage/deckSource';
import { findBrokenRelationships } from '../../src/lib/pptx/pptxPackage';
import { slideOrderOf } from '../../src/lib/pptx/pptxSlices';
import type { AdditionalFile } from '../../src/lib/additionalFiles/types';
import type { Song } from '../../src/lib/utils/types';
import type { PraiseSongExtras } from '../../src/praise/types';

const publicDir = join(__dirname, '..', '..', 'public');
const template = readFileSync(join(publicDir, 'praise-template.pptx'));
// A real deck of another design stands in for a sermon PPT.
const sermonDeck = readFileSync(join(publicDir, 'front-slides.pptx'));

const songs: Song[] = [
  {
    id: 'goodness',
    title: '주님의 선하심',
    sections: [
      { label: 'V', lines: ['사랑해요 주의 자비 변치 않네', '내 모든 삶 주의 손에 있네'] },
      { label: 'C', lines: ['내 평생 신실하신 주', '내 평생 좋으신 하나님'] },
    ],
    order: ['V', 'C'],
    linesPerSlide: 3,
  },
  {
    id: 'praise',
    title: 'Praise',
    sections: [{ label: 'C', lines: ['Praise the Lord, oh my soul', 'Praise the Lord, oh my soul'] }],
    order: ['C'],
    linesPerSlide: 3,
  },
];

const extras: Record<string, PraiseSongExtras> = {
  goodness: {
    english: {
      title: 'Goodness of God',
      slides: {
        [slideKey(['사랑해요 주의 자비 변치 않네', '내 모든 삶 주의 손에 있네'])]: [
          'I love You Lord oh Your mercy never fails me',
          'All my days I’ve been held in Your hands',
        ],
      },
    },
    prayerAfter: true,
  },
};

async function slideTexts(deck: Uint8Array): Promise<string[]> {
  const zip = await JSZip.loadAsync(deck);
  const texts: string[] = [];
  for (const name of await slideOrderOf(zip)) {
    const xml = await zip.file(`ppt/slides/${name}`)!.async('string');
    texts.push([...xml.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((match) => match[1]).join(' | '));
  }
  return texts;
}

describe('buildPraiseDeck', () => {
  it('builds cover, bilingual title and lyric slides and a 기도 slide, as a valid package', async () => {
    const { deck, overview } = await buildPraiseDeck({ template, songs, extras, date: '2026-09-26' });
    const texts = await slideTexts(deck);
    expect(texts).toHaveLength(7);
    expect(overview.map((row) => row.kind)).toEqual(['front', 'lyrics-title', 'lyrics', 'lyrics', 'prayer', 'lyrics-title', 'lyrics']);

    expect(texts[0]).toBe('09/26/2026');
    expect(texts[1]).toBe('주님의 선하심 | Goodness of God');
    // Header, Korean, the blank spacer, then English.
    expect(texts[2]).toBe(
      '주님의 선하심 | Goodness of God | 사랑해요 주의 자비 변치 않네 | 내 모든 삶 주의 손에 있네 |  | I love You Lord oh Your mercy never fails me | All my days I’ve been held in Your hands',
    );
    // No English yet: Korean alone, no spacer.
    expect(texts[3]).toBe('주님의 선하심 | Goodness of God | 내 평생 신실하신 주 | 내 평생 좋으신 하나님');
    expect(texts[4]).toContain('Prayer');
    // An English-only song keeps its one title and prints its lines once.
    expect(texts[5]).toBe('Praise');
    expect(texts[6]).toBe('Praise | Praise the Lord, oh my soul | Praise the Lord, oh my soul');

    const zip = await JSZip.loadAsync(deck);
    expect(await findBrokenRelationships(zip)).toEqual([]);
    expect(Object.keys(zip.files).some((path) => /\{\{/.test(path))).toBe(false);
    const allXml = await Promise.all(
      Object.keys(zip.files)
        .filter((path) => path.startsWith('ppt/slides/slide'))
        .map((path) => zip.file(path)!.async('string')),
    );
    expect(allXml.join('')).not.toContain('{{');
  });

  it('shrinks a crowded bilingual slide instead of letting it run off the screen', async () => {
    const long: Song = {
      id: 'long',
      title: '긴 곡',
      sections: [{ label: 'V', lines: ['가사 한 줄', '가사 두 줄', '가사 세 줄', '가사 네 줄'] }],
      order: ['V'],
      linesPerSlide: 4,
    };
    const english = ['one', 'two', 'three', 'four', 'five', 'six'];
    const { deck } = await buildPraiseDeck({
      template,
      songs: [long],
      extras: { long: { english: { title: '', slides: { [slideKey(long.sections[0].lines)]: english } } } },
      date: '',
    });
    const zip = await JSZip.loadAsync(deck);
    const names = await slideOrderOf(zip);
    const xml = await zip.file(`ppt/slides/${names[2]}`)!.async('string');
    const sizes = [...xml.matchAll(/<a:rPr[^>]*\bsz="(\d+)"/g)].map((match) => Number(match[1]));
    // The corner label keeps its size; the 11-line body comes down from 34pt.
    expect(Math.min(...sizes)).toBeLessThan(3400);
  });

  it('splices a sermon PPT in after the song it was placed after, before that song’s 기도', async () => {
    const sermon: AdditionalFile = {
      id: 'sermon',
      name: '설교.pptx',
      kind: 'pptx',
      data: sermonDeck.buffer.slice(sermonDeck.byteOffset, sermonDeck.byteOffset + sermonDeck.byteLength) as ArrayBuffer,
      slideCount: (await slideOrderOf(await JSZip.loadAsync(sermonDeck))).length,
    };
    const { deck, overview } = await buildPraiseDeck({
      template,
      songs,
      extras,
      date: '2026-09-26',
      additionalFiles: [sermon],
      placements: [{ fileId: 'sermon', placement: { afterSongId: 'goodness' } }],
    });
    const texts = await slideTexts(deck);
    expect(texts).toHaveLength(7 + sermon.slideCount);
    const kinds = overview.map((row) => row.kind);
    expect(kinds.slice(0, 4)).toEqual(['front', 'lyrics-title', 'lyrics', 'lyrics']);
    expect(kinds.slice(4, 4 + sermon.slideCount).every((kind) => kind === 'additional')).toBe(true);
    expect(kinds[4 + sermon.slideCount]).toBe('prayer');
    expect(texts[4 + sermon.slideCount]).toContain('Prayer');
    expect(await findBrokenRelationships(await JSZip.loadAsync(deck))).toEqual([]);
  });

  it('replaces the cover photo and drops last year’s date box when a new cover is given', async () => {
    // Any real PNG will do; the cover is only re-pointed at it.
    const png = readFileSync(join(publicDir, '..', 'tests', 'fixtures', 'sheet-page.png'));
    const { deck } = await buildPraiseDeck({
      template,
      songs: [],
      extras: {},
      date: '2026-09-26',
      coverImage: { name: 'cover.png', mimeType: 'image/png', data: png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength) as ArrayBuffer },
    });
    const zip = await JSZip.loadAsync(deck);
    const [cover] = await slideOrderOf(zip);
    const xml = await zip.file(`ppt/slides/${cover}`)!.async('string');
    const rels = await zip.file(`ppt/slides/_rels/${cover}.rels`)!.async('string');
    expect(xml).not.toContain('PraiseCoverDate');
    expect(rels).toContain('media/praise-cover.png');
    expect(zip.file('ppt/media/praise-cover.png')).not.toBeNull();
    expect(await findBrokenRelationships(zip)).toEqual([]);
  });
});

describe('cover date and file name', () => {
  it('prints the date the way last year’s cover did', () => {
    expect(formatCoverDate('2026-09-26')).toBe('09/26/2026');
    expect(formatCoverDate('')).toBe('');
  });

  it('names the file after the event date', () => {
    expect(suggestPraiseFileName('2026-09-26')).toBe('0926_PraiseNight.pptx');
  });
});

describe('praise snapshot', () => {
  it('round-trips the night, and is never read as a Sunday snapshot', async () => {
    const sermon: AdditionalFile = {
      id: 'old-id',
      name: '설교.pptx',
      kind: 'pptx',
      data: sermonDeck.buffer.slice(sermonDeck.byteOffset, sermonDeck.byteOffset + sermonDeck.byteLength) as ArrayBuffer,
      slideCount: 3,
    };
    const state = {
      date: '2026-09-26',
      songs,
      extras,
      additionalFiles: [sermon],
      placements: [{ fileId: 'old-id', placement: { afterSongId: 'goodness' } as const }],
      coverImage: null,
      fileNameOverride: '찬양집회.pptx',
    };
    const file = encodePraiseSource(state);
    expect(isPraiseSource(file)).toBe(true);
    expect(decodeDeckSource(file)).toBeNull();

    const source = decodePraiseSource(file)!;
    const restored = await restorePraiseState(source, await encodePraiseFiles(state));
    expect(restored.songs.map((song) => song.id)).toEqual(['goodness', 'praise']);
    expect(restored.extras.goodness.prayerAfter).toBe(true);
    expect(restored.extras.goodness.english.title).toBe('Goodness of God');
    expect(restored.additionalFiles).toHaveLength(1);
    // File ids are new after a restore; the placement follows the file.
    expect(restored.placements).toEqual([
      { fileId: restored.additionalFiles[0].id, placement: { afterSongId: 'goodness' } },
    ]);
    expect(restored.fileNameOverride).toBe('찬양집회.pptx');
  });
});

describe('isoDateFromConti', () => {
  it('reads the ways a conti prints its date', async () => {
    const { isoDateFromConti } = await import('../../src/praise/deckBuilder');
    expect(isoDateFromConti('9/26/26')).toBe('2026-09-26');
    expect(isoDateFromConti('2026.9.26')).toBe('2026-09-26');
    expect(isoDateFromConti('2026년 9월 26일')).toBe('2026-09-26');
    expect(isoDateFromConti('2/30/26')).toBe('');
    expect(isoDateFromConti(undefined)).toBe('');
  });
});

describe('the lyrics box the planner measures against', () => {
  it('matches the template’s own lyrics shape', async () => {
    const { PRAISE_LYRICS_BODY_BOX } = await import('../../src/praise/template');
    const zip = await JSZip.loadAsync(template);
    const xml = await zip.file('ppt/slides/slide3.xml')!.async('string');
    const body = [...xml.matchAll(/<p:sp>[\s\S]*?<\/p:sp>/g)].map((m) => m[0]).find((shape) => shape.includes('{{LINE}}'))!;
    const ext = PRAISE_LYRICS_BODY_BOX.match(/<a:ext[^>]*\/>/)![0];
    expect(body).toContain(ext);
    expect(body).toContain('<a:spcPct val="115000"/>');
    for (const inset of ['bIns="91425"', 'lIns="91425"', 'rIns="91425"', 'tIns="91425"']) expect(body).toContain(inset);
  });
});
