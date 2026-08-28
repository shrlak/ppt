import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { buildBiblePptx } from '../src/bible/pptxBuilder';
import type { VerseSlidePlan } from '../src/bible/versePlanner';
import { buildAnnouncementDeck } from '../src/lib/utils/announcementBuilder';
import { buildPptx } from '../src/lib/pptx/pptxBuilder';
import { mergePptxDecks } from '../src/lib/pptx/pptxMerge';
import { assertPptxIntegrity, findBrokenRelationships } from '../src/lib/pptx/pptxPackage';
import { applyConfessionSong } from '../src/lib/pptx/confessionSlides';
import { extractSlideSubset } from '../src/lib/pptx/pptxSlices';
import type { Song } from '../src/lib/utils/types';

const publicDir = join(__dirname, '..', 'public');
const frontSlides = readFileSync(join(publicDir, 'front-slides.pptx'));
const backSlides = readFileSync(join(publicDir, 'back-slides.pptx'));
const serviceTemplate = readFileSync(join(publicDir, 'service-template.pptx'));
const lyricsTemplate = readFileSync(join(publicDir, 'template.pptx'));
const bibleTemplate = readFileSync(join(publicDir, 'bible-template.pptx'));
const sermonUpload = readFileSync(join(__dirname, 'fixtures', 'placeholder-front-slide.pptx'));

const song: Song = {
  id: 'integration-song',
  title: '주님의 사랑',
  sections: [
    { label: 'V1', lines: ['눈부신 햇살', '저 하늘 너머 내게 주어진'] },
    { label: 'C', lines: ['내 안에 기쁨의 노래', '멈출 수가 없네'] },
  ],
  order: ['I', 'V1', 'C'],
  linesPerSlide: 4,
};

const alternateSong: Song = {
  id: 'alternate-conti-song',
  title: '새 노래로 찬양해',
  sections: [
    { label: 'V1', lines: ['새 노래로 주를 찬양해', '변함없는 사랑 노래해'] },
    { label: 'C', lines: ['기쁨으로 주께 나아가', '영원토록 주를 높이리'] },
  ],
  order: ['V1', 'C'],
  linesPerSlide: 4,
};

/** 설교 후 찬양 — placed after the sermon's 기도 slide, not in the opening set. */
const postSermonSong: Song = {
  id: 'post-sermon-song',
  title: '축복하노라',
  sections: [{ label: 'C', lines: ['축복하노라 주의 이름으로', '평강이 함께 하기를'] }],
  order: ['C'],
  linesPerSlide: 4,
  postSermon: true,
};

/** This week's 공동체 고백송, printed into the back deck's 공동체 고백 block. */
const confessionSong: Song = {
  id: 'confession-song',
  title: '나의 반석이신 하나님',
  sections: [{ label: 'C', lines: ['나의 반석이신 하나님', '내 삶의 피난처 되시네'] }],
  order: ['C'],
  linesPerSlide: 4,
};

const biblePlan: VerseSlidePlan = {
  globalData: {
    title: '로마서',
    etitle: 'Romans',
    rangeKo: '로마서 5:1-2',
    rangeEn: 'Romans 5:1-2',
    sermonTitle: '하나님과 화평을 누리자',
  },
  verseSlides: [
    {
      title: '로마서',
      etitle: 'Romans',
      chapter: '5',
      verse: '1',
      rangeKo: '로마서 5:1-2',
      rangeEn: 'Romans 5:1-2',
      body: '그러므로 우리가 믿음으로 의롭다 하심을 받았으니',
    },
  ],
};

function slideFiles(zip: JSZip): string[] {
  return Object.keys(zip.files).filter((path) => /^ppt\/slides\/slide\d+\.xml$/.test(path));
}

/**
 * A sermon deck as it really arrives: authored elsewhere, so nothing about
 * how it writes `[Content_Types].xml` matches what this app writes. Here
 * every element carries a namespace prefix — legal XML, and a shape a
 * hand-written `<Override PartName=…/>` match does not see.
 */
async function foreignSermonDeck(): Promise<Uint8Array> {
  const zip = await JSZip.loadAsync(sermonUpload);
  const contentTypes = await zip.file('[Content_Types].xml')!.async('string');
  zip.file(
    '[Content_Types].xml',
    contentTypes
      .replace(/<Types /, '<ct:Types xmlns:ct="http://schemas.openxmlformats.org/package/2006/content-types" ')
      .replace(/<\/Types>/, '</ct:Types>')
      .replace(/<(Override|Default) /g, '<ct:$1 '),
  );
  return zip.generateAsync({ type: 'uint8array' });
}

describe('complete service deck', () => {
  // Chains 9 real PPTX merges (JSZip parse/renumber/repack each time); on a
  // loaded CI runner this comfortably exceeds vitest's 5000ms default.
  it('keeps the mandatory sequence and produces a repair-free PPTX package', async () => {
    // Matches the real download flow in App.tsx: intermediate merges pack with
    // STORE (cheap, skips re-DEFLATE on every step of the growing package) and
    // only the final merge (adding the mandatory back slides) uses DEFLATE.
    let deck: Uint8Array<ArrayBufferLike> = new Uint8Array(frontSlides);
    deck = await mergePptxDecks(deck, await buildPptx(lyricsTemplate, [song, alternateSong]), 'STORE');
    deck = await mergePptxDecks(deck, await extractSlideSubset(serviceTemplate, [17]), 'STORE');
    deck = await mergePptxDecks(deck, await buildBiblePptx(bibleTemplate, biblePlan), 'STORE');
    // Simulates a separately authored sermon PPTX uploaded by the user. Its
    // master/layout ids start in the same range as the other source decks.
    deck = await mergePptxDecks(deck, await extractSlideSubset(serviceTemplate, [42]), 'STORE');
    deck = await mergePptxDecks(deck, await foreignSermonDeck(), 'STORE');
    deck = await mergePptxDecks(deck, await extractSlideSubset(serviceTemplate, [31]), 'STORE');
    // 설교 후 찬양 goes between that 기도 slide and the 광고 title.
    deck = await mergePptxDecks(deck, await buildPptx(lyricsTemplate, [postSermonSong]), 'STORE');
    deck = await mergePptxDecks(deck, await extractSlideSubset(serviceTemplate, [32]), 'STORE');
    deck = await mergePptxDecks(
      deck,
      await buildAnnouncementDeck(serviceTemplate, 33, [
        { title: '테스트 광고', bodyLines: ['광고 내용입니다.'] },
      ]),
      'STORE',
    );
    // The back deck's 공동체 고백 block is rewritten to this week's song before
    // it is appended, exactly as App.buildMergedDeck does.
    const confessionApplied = await applyConfessionSong(backSlides, confessionSong);
    expect(confessionApplied.applied).toBe(true);
    deck = await mergePptxDecks(deck, confessionApplied.data);

    await expect(assertPptxIntegrity(deck)).resolves.toBeUndefined();
    const zip = await JSZip.loadAsync(deck);
    expect(await findBrokenRelationships(zip)).toEqual([]);
    expect(zip.file('ppt/metadata')).toBeNull();
    expect(await zip.file('ppt/presentation.xml')!.async('string')).not.toContain(
      'GoogleSlidesCustomDataVersion2',
    );
    expect(await zip.file('ppt/_rels/presentation.xml.rels')!.async('string')).not.toContain(
      'presentationmetadata',
    );
    expect(await zip.file('[Content_Types].xml')!.async('string')).not.toContain('/ppt/metadata');

    const slides = slideFiles(zip);
    expect(slides.length).toBeGreaterThanOrEqual(4 + 5 + 1 + 1 + 1 + 1 + 2 + 1 + 20);

    const first = await zip.file('ppt/slides/slide1.xml')!.async('string');
    expect(first).toContain('빛주사랑');
    const firstLyricsSlide = await zip.file('ppt/slides/slide5.xml')!.async('string');
    expect(firstLyricsSlide).toContain('주님의 사랑');
    // The confession song is one slide shorter than the bundled Celebrate the
    // Light block, so the rewritten back deck is 20 slides rather than 21.
    const backStart = slides.length - 20 + 1;
    const slideBeforeBack = await zip.file(`ppt/slides/slide${backStart - 1}.xml`)!.async('string');
    const firstBackSlide = await zip.file(`ppt/slides/slide${backStart}.xml`)!.async('string');
    expect(slideBeforeBack).toContain('테스트 광고');
    expect(firstBackSlide).toContain('공동체 고백송');
    expect(firstBackSlide).toContain('나의 반석이신 하나님');
    // 설교 후 찬양 sits after the sermon, not in the opening praise set: after
    // the uploaded 설교 slides (and the 기도 slide that follows them) and
    // before the 광고 title.
    const orderedSlides = await Promise.all(
      slides.map((_, i) => zip.file(`ppt/slides/slide${i + 1}.xml`)!.async('string')),
    );
    const positionOf = (text: string) => orderedSlides.findIndex((xml) => xml.includes(text));
    expect(positionOf('축복하노라')).toBeGreaterThan(positionOf('플레이스홀더 제목'));
    expect(positionOf('축복하노라')).toBeLessThan(positionOf('테스트 광고'));
    // The opening praise set still comes first, before the scripture slides.
    expect(positionOf('새 노래로 찬양해')).toBeLessThan(positionOf('하나님과 화평을 누리자'));
    const allText = (await Promise.all(slides.map((path) => zip.file(path)!.async('string')))).join('\n');
    expect(allText).toContain('주님의 사랑');
    expect(allText).toContain('새 노래로 찬양해');
    expect(allText).toContain('하나님과 화평을 누리자');
    expect(allText).toContain('송별');
    expect(allText).toContain('플레이스홀더 제목');
    expect(allText).toContain('테스트 광고');
    expect(allText).toContain('공동체 고백송');
    expect(allText).toContain('축복하노라');
    expect(allText).toContain('나의 반석이신 하나님');
    // Celebrate the Light's lyric slides were replaced, not left alongside.
    expect(allText).not.toContain('Celebrate the light 온 세상 비추네');

    const outputPath = process.env.WRITE_VALIDATION_DECK;
    if (outputPath) {
      mkdirSync(join(outputPath, '..'), { recursive: true });
      writeFileSync(outputPath, deck);
    }
  }, 20000);
});
