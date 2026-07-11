import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { buildBiblePptx } from '../src/bible/pptxBuilder';
import type { VerseSlidePlan } from '../src/bible/versePlanner';
import { buildAnnouncementDeck } from '../src/lib/announcementBuilder';
import { buildPptx } from '../src/lib/pptxBuilder';
import { mergePptxDecks } from '../src/lib/pptxMerge';
import { assertPptxIntegrity, findBrokenRelationships } from '../src/lib/pptxPackage';
import { extractSlideSubset } from '../src/lib/pptxSlices';
import type { Song } from '../src/lib/types';

const publicDir = join(__dirname, '..', 'public');
const frontSlides = readFileSync(join(publicDir, 'front-slides.pptx'));
const backSlides = readFileSync(join(publicDir, 'back-slides.pptx'));
const serviceTemplate = readFileSync(join(publicDir, 'service-template.pptx'));
const lyricsTemplate = readFileSync(join(publicDir, 'template.pptx'));
const bibleTemplate = readFileSync(join(publicDir, 'bible-template.pptx'));

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

describe('complete service deck', () => {
  it('keeps the mandatory sequence and produces a repair-free PPTX package', async () => {
    let deck: Uint8Array<ArrayBufferLike> = new Uint8Array(frontSlides);
    deck = await mergePptxDecks(deck, await buildPptx(lyricsTemplate, [song]));
    deck = await mergePptxDecks(deck, await extractSlideSubset(serviceTemplate, [17]));
    deck = await mergePptxDecks(deck, await buildBiblePptx(bibleTemplate, biblePlan));
    deck = await mergePptxDecks(deck, await extractSlideSubset(serviceTemplate, [31]));
    deck = await mergePptxDecks(deck, await extractSlideSubset(serviceTemplate, [32]));
    deck = await mergePptxDecks(
      deck,
      await buildAnnouncementDeck(serviceTemplate, 33, [
        { title: '테스트 광고', bodyLines: ['광고 내용입니다.'] },
      ]),
    );
    deck = await mergePptxDecks(deck, backSlides);

    await expect(assertPptxIntegrity(deck)).resolves.toBeUndefined();
    const zip = await JSZip.loadAsync(deck);
    expect(await findBrokenRelationships(zip)).toEqual([]);

    const slides = slideFiles(zip);
    expect(slides.length).toBeGreaterThanOrEqual(4 + 3 + 1 + 1 + 1 + 1 + 21);

    const first = await zip.file('ppt/slides/slide1.xml')!.async('string');
    expect(first).toContain('빛주사랑');
    const firstLyricsSlide = await zip.file('ppt/slides/slide5.xml')!.async('string');
    expect(firstLyricsSlide).toContain('주님의 사랑');
    const backStart = slides.length - 21 + 1;
    const slideBeforeBack = await zip.file(`ppt/slides/slide${backStart - 1}.xml`)!.async('string');
    const firstBackSlide = await zip.file(`ppt/slides/slide${backStart}.xml`)!.async('string');
    expect(slideBeforeBack).toContain('테스트 광고');
    expect(firstBackSlide).toContain('공동체 고백송');
    const allText = (await Promise.all(slides.map((path) => zip.file(path)!.async('string')))).join('\n');
    expect(allText).toContain('주님의 사랑');
    expect(allText).toContain('하나님과 화평을 누리자');
    expect(allText).toContain('테스트 광고');
    expect(allText).toContain('공동체 고백송');

    const outputPath = process.env.WRITE_VALIDATION_DECK;
    if (outputPath) {
      mkdirSync(join(outputPath, '..'), { recursive: true });
      writeFileSync(outputPath, deck);
    }
  });
});
