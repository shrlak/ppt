import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { buildWednesdayDeck, planWednesdaySlots } from '../../src/wednesday/deckBuilder';
import { buildWednesdayThumbnail, thumbnailFileName } from '../../src/wednesday/thumbnail';
import { WEDNESDAY_SLIDES } from '../../src/wednesday/template';
import type { WednesdayService, WednesdaySong } from '../../src/wednesday/types';
import { assertPptxIntegrity, findBrokenRelationships } from '../../src/lib/pptx/pptxPackage';
import { extractSlideSubset, slideOrderOf } from '../../src/lib/pptx/pptxSlices';
import type { Verse } from '../../src/bible/types';

const publicDir = join(__dirname, '..', '..', 'public');
const template = readFileSync(join(publicDir, 'wednesday-template.pptx'));
const thumbnailTemplate = readFileSync(join(publicDir, 'wednesday-thumbnail.pptx'));
// Stands in for a downloaded 찬양 PPT: a real multi-slide deck at another
// slide size (4:3 9144000×6858000), so the rescale path runs too.
const foreignDeck = readFileSync(join(publicDir, 'front-slides.pptx'));
const bibleTemplate = readFileSync(join(publicDir, 'bible-template.pptx'));

const service: WednesdayService = {
  date: '2026-09-16',
  sermonTitle: '나의 힘이 되신 여호와여',
  preacher: '고신석',
  preacherTitle: '목사',
  verseInput: '시18:1-12',
  versesPerSlide: 3,
};

const verses: Verse[] = Array.from({ length: 12 }, (_, i) => ({
  chapter: 18,
  verse: i + 1,
  text: `${i + 1}번째 절의 본문입니다`,
}));

const rangeKo = '시편 18편 1-12절';

/** A song deck at the template's own slide size, of `count` slides. */
async function sameSizeSongDeck(count: number): Promise<ArrayBuffer> {
  const positions = Array.from({ length: count }, () => WEDNESDAY_SLIDES.worship);
  return toArrayBuffer(await extractSlideSubset(template, positions, 'STORE'));
}

/**
 * A song deck that shares no media with the template — like a real 찬양 PPT,
 * whose own images are the only ones it brings.
 */
async function foreignMediaSongDeck(count: number): Promise<ArrayBuffer> {
  const positions = Array.from({ length: count }, () => 1);
  return toArrayBuffer(await extractSlideSubset(bibleTemplate, positions, 'STORE'));
}

function toArrayBuffer(data: Uint8Array): ArrayBuffer {
  return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
}

function songFrom(id: string, title: string, deck: ArrayBuffer, slideCount: number): WednesdaySong {
  return { id, title, deck, slideCount, origin: 'upload' };
}

async function slideTexts(data: Uint8Array): Promise<string[]> {
  const zip = await JSZip.loadAsync(data);
  const names = await slideOrderOf(zip);
  const texts: string[] = [];
  for (const name of names) {
    const xml = await zip.file(`ppt/slides/${name}`)!.async('string');
    texts.push(
      [...xml.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)]
        .map((match) => match[1])
        .join('')
        .replace(/\s+/g, ' ')
        .trim(),
    );
  }
  return texts;
}

describe('planWednesdaySlots', () => {
  it('lays out the fixed service order around the songs and verse groups', () => {
    const slots = planWednesdaySlots(2, 4).map((slot) => slot.kind);
    expect(slots).toEqual([
      'cover',
      'intro',
      'worship',
      'songTitle',
      'songTitle',
      'prayer',
      'wordDivider',
      'wordBody',
      'wordBody',
      'wordBody',
      'wordBody',
      'sermonDivider',
      'sermonPrayer',
      'unifiedPrayer',
      'closing',
    ]);
  });

  it('still produces the fixed slides with no songs and no passage', () => {
    expect(planWednesdaySlots(0, 0).map((slot) => slot.kind)).toEqual([
      'cover',
      'intro',
      'worship',
      'prayer',
      'wordDivider',
      'sermonDivider',
      'sermonPrayer',
      'unifiedPrayer',
      'closing',
    ]);
  });
});

describe('buildWednesdayDeck', () => {
  it(
    'interleaves each song\'s slides after its 찬양 제목 slide, in the service order',
    async () => {
      const songs = [
        songFrom('s1', '나의 반석이신 하나님', await sameSizeSongDeck(3), 3),
        songFrom('s2', '하늘 위에 주님 밖에', await sameSizeSongDeck(2), 2),
      ];

      const { deck, overview, warnings } = await buildWednesdayDeck({
        template,
        service,
        songs,
        verses,
        rangeKo,
      });

      const texts = await slideTexts(deck);
      // 표지·인트로·경배와 찬양 (3) + [제목 + 3장] + [제목 + 2장] (7) + 기도 (1)
      // + 말씀 (1) + 본문 4장 + 설교 · 기도 · 합심기도 · 마지막 (4) = 20
      expect(texts).toHaveLength(20);
      expect(overview).toHaveLength(20);

      expect(texts[0]).toContain('2026년 9월 16일');
      expect(texts[0]).toContain('나의 힘이 되신 여호와여');
      expect(texts[1]).toContain('2026. 9. 16');
      expect(texts[2]).toContain('경배와 찬양');
      expect(texts[3]).toContain('나의 반석이신 하나님');
      // Slides 4-6 are song 1's own slides, then song 2's title.
      expect(texts[7]).toContain('하늘 위에 주님 밖에');
      expect(texts[10]).toContain('기 도');
      expect(texts[11]).toContain('말 씀');
      expect(texts[12]).toContain('1번째 절의 본문입니다');
      expect(texts[15]).toContain('12번째 절의 본문입니다');
      expect(texts[16]).toContain('나의 힘이 되신 여호와여'); // 설교 divider
      expect(texts[17]).toContain('기 도');
      expect(texts[18]).toContain('합심기도');
      expect(texts[19]).toContain('성령으로 봉사하는 교회');

      expect(warnings).toEqual([]);
      expect(texts.join('\n')).not.toContain('{{');
      await expect(assertPptxIntegrity(deck)).resolves.toBeUndefined();
      expect(await findBrokenRelationships(await JSZip.loadAsync(deck))).toEqual([]);
    },
    30_000,
  );

  it(
    'splits the passage across 말씀 본문 slides and prefixes each verse with its number',
    async () => {
      const { deck } = await buildWednesdayDeck({
        template,
        service: { ...service, versesPerSlide: 4 },
        songs: [],
        verses,
        rangeKo,
      });

      const texts = await slideTexts(deck);
      // 3 verse-group slides for 12 verses at 4 per slide.
      const bodySlides = texts.filter((text) => text.includes('개역개정'));
      expect(bodySlides).toHaveLength(3);
      expect(bodySlides[0]).toContain('1 1번째 절의 본문입니다');
      expect(bodySlides[0]).toContain('4 4번째 절의 본문입니다');
      expect(bodySlides[0]).not.toContain('5 5번째');
      expect(bodySlides[0]).toContain('말 씀 (시편 18편 1-12절)');
      await expect(assertPptxIntegrity(deck)).resolves.toBeUndefined();
    },
    30_000,
  );

  it(
    'carries the cover background only once, however many songs there are',
    async () => {
      const songs = [
        songFrom('s1', '첫 곡', await foreignMediaSongDeck(2), 2),
        songFrom('s2', '둘째 곡', await foreignMediaSongDeck(2), 2),
        songFrom('s3', '셋째 곡', await foreignMediaSongDeck(2), 2),
      ];
      const { deck } = await buildWednesdayDeck({ template, service, songs, verses, rangeKo });
      const zip = await JSZip.loadAsync(deck);

      // The 2 MB EMF cover background would otherwise be copied once per
      // template extraction — the reason the skeleton is built in one call.
      const emfParts = Object.keys(zip.files).filter((path) => path.endsWith('.emf'));
      expect(emfParts).toHaveLength(1);
    },
    30_000,
  );

  it(
    'resizes a song deck authored at another slide size, and says so',
    async () => {
      const song = songFrom('s1', '다른 크기 곡', toArrayBuffer(foreignDeck), 4);
      const { deck, warnings } = await buildWednesdayDeck({
        template,
        service,
        songs: [song],
        verses: verses.slice(0, 3),
        rangeKo,
      });

      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('다른 크기 곡');
      await expect(assertPptxIntegrity(deck)).resolves.toBeUndefined();
    },
    30_000,
  );

  it(
    'keeps a song listed by title when its file is not attached yet',
    async () => {
      const { deck, overview } = await buildWednesdayDeck({
        template,
        service,
        songs: [{ id: 's1', title: '아직 못 받은 곡' }],
        verses: verses.slice(0, 3),
        rangeKo,
      });

      const texts = await slideTexts(deck);
      expect(texts[3]).toContain('아직 못 받은 곡');
      // Title slide only — no slides came from a file.
      expect(overview.filter((item) => item.songId === 's1')).toHaveLength(1);
      await expect(assertPptxIntegrity(deck)).resolves.toBeUndefined();
    },
    30_000,
  );
});

describe('buildWednesdayThumbnail', () => {
  it('fills the same cover fields on one 16:9 slide', async () => {
    const thumbnail = await buildWednesdayThumbnail({ template: thumbnailTemplate, service, rangeKo });
    const texts = await slideTexts(thumbnail);

    expect(texts).toHaveLength(1);
    expect(texts[0]).toContain('2026년 9월 16일');
    expect(texts[0]).toContain('나의 힘이 되신 여호와여');
    expect(texts[0]).toContain('시편 18편 1-12절');
    expect(texts[0]).toContain('고신석');
    expect(texts[0]).not.toContain('{{');

    const zip = await JSZip.loadAsync(thumbnail);
    const presentation = await zip.file('ppt/presentation.xml')!.async('string');
    expect(presentation).toContain('cx="12192000"');
    await expect(assertPptxIntegrity(thumbnail)).resolves.toBeUndefined();
  });

  it('names itself after the deck', () => {
    expect(thumbnailFileName('0916.pptx')).toBe('0916 썸네일.pptx');
    expect(thumbnailFileName('0916')).toBe('0916 썸네일.pptx');
  });
});
