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
  it('matches the lyrics shape as every lyric slide is built', async () => {
    const { PRAISE_LYRICS_BODY_BOX } = await import('../../src/praise/template');
    const { buildLyricsSlide } = await import('../../src/praise/deckBuilder');
    const zip = await JSZip.loadAsync(template);
    const xml = buildLyricsSlide(await zip.file('ppt/slides/slide3.xml')!.async('string'), '제목', ['가사'], []);
    const body = [...xml.matchAll(/<p:sp>[\s\S]*?<\/p:sp>/g)].map((m) => m[0]).find((shape) => shape.includes('가사'))!;
    const ext = PRAISE_LYRICS_BODY_BOX.match(/<a:ext[^>]*\/>/)![0];
    expect(body).toContain(ext);
    expect(body).toContain('<a:spcPct val="115000"/>');
    for (const inset of ['bIns="91425"', 'lIns="91425"', 'rIns="91425"', 'tIns="91425"']) expect(body).toContain(inset);
  });
});

async function templateSlide(position: number): Promise<string> {
  const zip = await JSZip.loadAsync(template);
  return zip.file(`ppt/slides/slide${position}.xml`)!.async('string');
}

function shapes(xml: string): string[] {
  return [...xml.matchAll(/<p:sp>[\s\S]*?<\/p:sp>/g)].map((m) => m[0]);
}

function box(shapeXml: string): { x: number; y: number; cx: number; cy: number } {
  const m = shapeXml.match(/<a:off x="(\d+)" y="(\d+)"\/><a:ext cx="(\d+)" cy="(\d+)"\/>/)!;
  return { x: Number(m[1]), y: Number(m[2]), cx: Number(m[3]), cy: Number(m[4]) };
}

describe('lyrics sit in the centre of every slide', () => {
  it('centres a two-line slide and a crowded bilingual slide alike', async () => {
    const { buildLyricsSlide } = await import('../../src/praise/deckBuilder');
    const xml = await templateSlide(3);
    const slides = [
      buildLyricsSlide(xml, '주님의 선하심 | Goodness of God', ['사랑해요 주의 자비'], []),
      buildLyricsSlide(
        xml,
        '주님의 선하심 | Goodness of God',
        ['사랑해요 주의 자비 변치 않네', '내 모든 삶 주의 손에 있네', '내 평생 신실하신 주'],
        ['I love You Lord', 'Oh Your mercy never fails me', 'All my days I’ve been held in Your hands', 'All my life You have been faithful'],
      ),
      buildLyricsSlide(xml, 'Praise', ['Praise the Lord, oh my soul'], []),
    ];
    for (const slide of slides) {
      const body = shapes(slide).find((shape) => shape.includes('algn="ctr"') && shape.includes('115000'))!;
      const { x, y, cx, cy } = box(body);
      // Centred on the 9144000 × 6858000 slide, both ways…
      expect(x + cx / 2).toBe(9144000 / 2);
      expect(y + cy / 2).toBe(6858000 / 2);
      // …with the text hung from the middle of that box, not its top.
      expect(body).toMatch(/<a:bodyPr anchor="ctr"/);
      expect(body).not.toContain('anchor="t"');
      // Clear of the corner title above it.
      const header = shapes(slide).find((shape) => shape !== body)!;
      expect(y).toBeGreaterThan(box(header).y + box(header).cy);
    }
  });
});

/** Every `<a:p>` of a shape: its text and the run size it is drawn at. */
function paragraphs(shapeXml: string): { text: string; sz: number }[] {
  return [...shapeXml.matchAll(/<a:p>[\s\S]*?<\/a:p>/g)].map((m) => ({
    text: [...m[0].matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((t) => t[1]).join(''),
    sz: Number(m[0].match(/<a:rPr[^>]*\bsz="(\d+)"/)?.[1] ?? 0),
  }));
}

describe('a song title never takes two lines', () => {
  it('keeps a short title at the template size, on one line', async () => {
    const { buildTitleSlide } = await import('../../src/praise/deckBuilder');
    const slide = buildTitleSlide(await templateSlide(2), '주님의 선하심', 'Goodness of God');
    const title = shapes(slide).find((shape) => shape.includes('주님의 선하심'))!;
    expect(title).toContain('wrap="none"');
    expect(title).not.toContain('wrap="square"');
    expect(paragraphs(title)).toEqual([
      { text: '주님의 선하심', sz: 5400 },
      { text: 'Goodness of God', sz: 5400 },
    ]);
    // Widened, and still centred where last year's was.
    const { x, cx } = box(title);
    expect(x + cx / 2).toBe(9144000 / 2);
    expect(cx).toBeGreaterThan(6094500);
  });

  it('shrinks a long title just enough to stay on one line, Korean and English each on its own', async () => {
    const { buildTitleSlide } = await import('../../src/praise/deckBuilder');
    const { titleWidthEm } = await import('../../src/lib/pptx/textFit');
    const ko = '나의 슬픔을 주가 기쁨으로 바꾸셨네 할렐루야';
    const en = 'You Turned My Mourning into Dancing Again Hallelujah';
    const slide = buildTitleSlide(await templateSlide(2), ko, en);
    const title = shapes(slide).find((shape) => shape.includes(ko))!;
    const widthPt = (box(title).cx - 2 * 91425) / 12700;
    expect(title).toContain('wrap="none"');
    for (const { text, sz } of paragraphs(title)) {
      expect(sz).toBeLessThan(5400);
      // One line at that size: the (generous) width estimate fits the box.
      expect((titleWidthEm(text) * sz) / 100).toBeLessThanOrEqual(widthPt);
      // …and it did not shrink any further than it had to.
      expect((titleWidthEm(text) * (sz + 100)) / 100).toBeGreaterThan(widthPt);
    }
  });

  it('keeps the corner label on one line across the top of the lyric slide', async () => {
    const { buildLyricsSlide } = await import('../../src/praise/deckBuilder');
    const { titleWidthEm } = await import('../../src/lib/pptx/textFit');
    const header = '나의 슬픔을 주가 기쁨으로 | Turn Your Mourning into Dancing';
    const slide = buildLyricsSlide(await templateSlide(3), header, ['가사'], []);
    const label = shapes(slide).find((shape) => shape.includes('Turn Your Mourning'))!;
    expect(label).toContain('wrap="none"');
    const [{ text, sz }] = paragraphs(label);
    expect(text).toBe(header);
    expect((titleWidthEm(text) * sz) / 100).toBeLessThanOrEqual((box(label).cx - 2 * 91425) / 12700);
    // A short one keeps the template's size.
    const short = buildLyricsSlide(await templateSlide(3), '예수 우리 왕이여', ['가사'], []);
    expect(paragraphs(shapes(short).find((shape) => shape.includes('예수 우리 왕이여'))!)[0].sz).toBe(2010);
  });
});
