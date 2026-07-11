import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { mergePptxDecks } from '../src/lib/pptxMerge';
import { buildPptx } from '../src/lib/pptxBuilder';
import { buildBiblePptx } from '../src/bible/pptxBuilder';
import type { Song } from '../src/lib/types';
import type { VerseSlidePlan } from '../src/bible/versePlanner';
import { assertPptxIntegrity, findBrokenRelationships } from '../src/lib/pptxPackage';

const lyricsTemplate = readFileSync(join(__dirname, '..', 'public', 'template.pptx'));
const bibleTemplate = readFileSync(join(__dirname, '..', 'public', 'bible-template.pptx'));
const frontSlides = readFileSync(join(__dirname, '..', 'public', 'front-slides.pptx'));
const backSlides = readFileSync(join(__dirname, '..', 'public', 'back-slides.pptx'));

const songs: Song[] = [
  {
    id: 'a',
    title: '주님의 사랑',
    sections: [{ label: 'V1', lines: ['눈부신 햇살', '저 하늘 너머 내게 주어진'] }],
    order: ['I', 'V1'],
    linesPerSlide: 4,
  },
];

const biblePlan: VerseSlidePlan = {
  globalData: { title: '요한복음', etitle: 'John', rangeKo: '요한복음 3:16', rangeEn: 'John 3:16', sermonTitle: '' },
  verseSlides: [
    {
      title: '요한복음',
      etitle: 'John',
      chapter: '3',
      verse: '16',
      rangeKo: '요한복음 3:16',
      rangeEn: 'John 3:16',
      body: '하나님이 세상을 이처럼 사랑하사',
    },
  ],
};

function slideFiles(zip: JSZip): string[] {
  return Object.keys(zip.files).filter((f) => /^ppt\/slides\/slide\d+\.xml$/.test(f));
}

describe('mergePptxDecks', () => {
  it('appends the second deck\'s slides after the first, preserving both texts', async () => {
    const lyricsDeck = await buildPptx(lyricsTemplate, songs);
    const bibleDeck = await buildBiblePptx(bibleTemplate, biblePlan);

    const lyricsZip = await JSZip.loadAsync(lyricsDeck);
    const bibleZip = await JSZip.loadAsync(bibleDeck);
    const lyricsSlideCount = slideFiles(lyricsZip).length;
    const bibleSlideCount = slideFiles(bibleZip).length;

    const merged = await mergePptxDecks(lyricsDeck, bibleDeck);
    const mergedZip = await JSZip.loadAsync(merged);
    const mergedSlides = slideFiles(mergedZip);

    expect(mergedSlides).toHaveLength(lyricsSlideCount + bibleSlideCount);

    // presentation.xml must list exactly as many sldId entries as slide files.
    const presentation = await mergedZip.file('ppt/presentation.xml')!.async('string');
    expect(presentation.match(/<p:sldId /g)).toHaveLength(mergedSlides.length);
    // Both the base's original master and the appended one should be present.
    expect(presentation.match(/<p:sldMasterId /g)).toHaveLength(2);

    // First slide (lyrics title) comes before the bible slides.
    const firstSlide = await mergedZip.file('ppt/slides/slide1.xml')!.async('string');
    expect(firstSlide).toContain('주님의 사랑');

    const allText = (await Promise.all(mergedSlides.map((f) => mergedZip.file(f)!.async('string')))).join('\n');
    expect(allText).toContain('눈부신 햇살');
    expect(allText).toContain('하나님이 세상을 이처럼 사랑하사');
    expect(allText).toContain('요한복음 3:16');
  });

  it('keeps every slide\'s relationships resolvable to an existing part', async () => {
    const lyricsDeck = await buildPptx(lyricsTemplate, songs);
    const bibleDeck = await buildBiblePptx(bibleTemplate, biblePlan);
    const merged = await mergePptxDecks(lyricsDeck, bibleDeck);
    const zip = await JSZip.loadAsync(merged);

    for (const slidePath of slideFiles(zip)) {
      const name = slidePath.split('/').pop()!;
      const relsPath = `ppt/slides/_rels/${name}.rels`;
      const relsFile = zip.file(relsPath);
      expect(relsFile, `${relsPath} should exist`).not.toBeNull();
      const relsXml = await relsFile!.async('string');
      for (const m of relsXml.matchAll(/Target="([^"]+)"/g)) {
        const target = m[1];
        if (/^https?:/.test(target)) continue; // external, not a package part
        const resolved = new URL(target, 'zip:///ppt/slides/').pathname.replace(/^\//, '');
        expect(zip.file(resolved), `${slidePath} references missing part ${resolved}`).not.toBeNull();
      }
    }
    expect(await findBrokenRelationships(zip)).toEqual([]);
  });

  it('does not corrupt the base deck\'s own theme/master content', async () => {
    const lyricsDeck = await buildPptx(lyricsTemplate, songs);
    const bibleDeck = await buildBiblePptx(bibleTemplate, biblePlan);
    const lyricsZip = await JSZip.loadAsync(lyricsDeck);
    const originalTheme = await lyricsZip.file('ppt/theme/theme1.xml')!.async('string');

    const merged = await mergePptxDecks(lyricsDeck, bibleDeck);
    const mergedZip = await JSZip.loadAsync(merged);
    const mergedTheme = await mergedZip.file('ppt/theme/theme1.xml')!.async('string');
    expect(mergedTheme).toBe(originalTheme);

    // The bible deck's theme was copied in under a unique renamed path.
    const renamedThemes = Object.keys(mergedZip.files).filter((f) => /^ppt\/theme\/merged-.*\.xml$/.test(f));
    expect(renamedThemes.length).toBeGreaterThan(0);
  });

  it('adds a Content_Types override for every merged slide', async () => {
    const lyricsDeck = await buildPptx(lyricsTemplate, songs);
    const bibleDeck = await buildBiblePptx(bibleTemplate, biblePlan);
    const merged = await mergePptxDecks(lyricsDeck, bibleDeck);
    const zip = await JSZip.loadAsync(merged);
    const contentTypes = await zip.file('[Content_Types].xml')!.async('string');
    for (const path of slideFiles(zip)) {
      expect(contentTypes).toContain(`PartName="/${path}"`);
    }
  });

  it('throws when the addition deck has no slides', async () => {
    const lyricsDeck = await buildPptx(lyricsTemplate, songs);
    const emptyZip = new JSZip();
    // Minimal but slide-less package should be rejected rather than silently no-op.
    await expect(mergePptxDecks(lyricsDeck, await emptyZip.generateAsync({ type: 'uint8array' }))).rejects.toThrow();
  });

  it('merges the supplied front and back decks without PowerPoint repair relationships', async () => {
    const merged = await mergePptxDecks(frontSlides, backSlides);
    const zip = await JSZip.loadAsync(merged);
    expect(slideFiles(zip)).toHaveLength(25);
    expect(await findBrokenRelationships(zip)).toEqual([]);
    await expect(assertPptxIntegrity(merged)).resolves.toBeUndefined();
    expect(Object.keys(zip.files).some((path) => path.startsWith('ppt/notesSlides/'))).toBe(false);
  });
});
