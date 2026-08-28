import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { applyConfessionSong, findConfessionBlock } from '../../src/lib/pptx/confessionSlides';
import { assertPptxIntegrity, findBrokenRelationships } from '../../src/lib/pptx/pptxPackage';
import { extractSlideSubset } from '../../src/lib/pptx/pptxSlices';
import type { Song } from '../../src/lib/utils/types';

const backSlides = readFileSync(join(__dirname, '..', '..', 'public', 'back-slides.pptx'));

function song(title: string, lines: string[], linesPerSlide = 4): Song {
  return {
    id: 'confession',
    title,
    sections: [{ label: 'C', lines }],
    order: ['C'],
    linesPerSlide,
  };
}

/** Slide part names in presentation order, the way PowerPoint reads them. */
async function slideOrder(zip: JSZip): Promise<string[]> {
  const presentation = await zip.file('ppt/presentation.xml')!.async('string');
  const rels = await zip.file('ppt/_rels/presentation.xml.rels')!.async('string');
  const section = presentation.match(/<p:sldIdLst>([\s\S]*?)<\/p:sldIdLst>/)![1];
  const names: string[] = [];
  for (const match of section.matchAll(/r:id="(rId\d+)"/g)) {
    const target = rels.match(new RegExp(`Id="${match[1]}"[^>]*Target="slides/(slide\\d+\\.xml)"`));
    if (target) names.push(target[1]);
  }
  return names;
}

async function textsOf(zip: JSZip, name: string): Promise<string> {
  const xml = await zip.file(`ppt/slides/${name}`)!.async('string');
  return [...xml.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((match) => match[1]).join(' / ');
}

/** Every slide's text, in presentation order. */
async function deckTexts(data: Uint8Array): Promise<string[]> {
  const zip = await JSZip.loadAsync(data);
  const names = await slideOrder(zip);
  return Promise.all(names.map((name) => textsOf(zip, name)));
}

describe('the 공동체 고백 block in the bundled back deck', () => {
  it('is the 공동체 고백 marker slide plus the lyric slides that name its song', async () => {
    const block = await findConfessionBlock(await JSZip.loadAsync(backSlides));
    expect(block).not.toBeNull();
    expect(block!.markerIndex).toBe(0);
    expect(block!.currentTitle).toBe('Celebrate the Light');
    // The 'Happy Lord's Day' slide after the lyrics no longer names the song,
    // which is exactly what ends the block.
    expect(block!.lyricSlides).toEqual(['slide2.xml', 'slide3.xml']);
  });
});

describe('applyConfessionSong', () => {
  it('prints the new song on the marker slide and in the lyric slides', async () => {
    const result = await applyConfessionSong(
      backSlides,
      song('나의 반석이신 하나님', ['첫째 줄', '둘째 줄', '셋째 줄', '넷째 줄']),
    );
    expect(result.applied).toBe(true);
    expect(result.previousTitle).toBe('Celebrate the Light');
    expect(result.slideCount).toBe(1);

    const texts = await deckTexts(result.data);
    // The marker keeps its wording, its quotes and its standing instruction —
    // only the song's name changes.
    expect(texts[0]).toContain('공동체 고백송');
    expect(texts[0]).toContain('“나의 반석이신 하나님”');
    expect(texts[0]).toContain('자리에서 일어나');
    expect(texts[0]).not.toContain('Celebrate the Light');
    expect(texts[1]).toContain('첫째 줄');
    expect(texts[1]).toContain('넷째 줄');
    expect(texts[1]).toContain('나의 반석이신 하나님');
    // The slide that followed the block is untouched and still follows it.
    expect(texts[2]).toContain('Happy Lord’s Day');
    expect(texts.join('\n')).not.toContain('Celebrate the light 온 세상 비추네');
  });

  it('grows and shrinks the block to fit the song, keeping a repair-free package', async () => {
    const long = await applyConfessionSong(
      backSlides,
      song('긴 고백송', ['1줄', '2줄', '3줄', '4줄', '5줄', '6줄', '7줄', '8줄', '9줄'], 3),
    );
    expect(long.slideCount).toBe(3);
    const longZip = await JSZip.loadAsync(long.data);
    await expect(assertPptxIntegrity(long.data)).resolves.toBeUndefined();
    expect(await findBrokenRelationships(longZip)).toEqual([]);
    expect((await slideOrder(longZip)).length).toBe(22);

    const short = await applyConfessionSong(backSlides, song('짧은 고백송', ['한 줄']));
    expect(short.slideCount).toBe(1);
    const shortZip = await JSZip.loadAsync(short.data);
    await expect(assertPptxIntegrity(short.data)).resolves.toBeUndefined();
    expect(await findBrokenRelationships(shortZip)).toEqual([]);
    const shortOrder = await slideOrder(shortZip);
    expect(shortOrder.length).toBe(20);
    // The dropped slide's part is gone, not just unreferenced.
    expect(shortZip.file('ppt/slides/slide3.xml')).toBeNull();
    expect(await textsOf(shortZip, shortOrder[2])).toContain('Happy Lord’s Day');
  });

  it('leaves the rest of the deck exactly as it was', async () => {
    const before = await deckTexts(new Uint8Array(backSlides));
    const after = await deckTexts(
      (await applyConfessionSong(backSlides, song('새 고백송', ['가사 한 줄']))).data,
    );
    // Marker + one lyric slide replace marker + two, so everything from 'Happy
    // Lord's Day' on shifts by one and is otherwise identical.
    expect(after.slice(2)).toEqual(before.slice(3));
  });

  it('does nothing when the deck already prints that song', async () => {
    const result = await applyConfessionSong(backSlides, song('celebrate  THE light', ['가사']));
    expect(result.applied).toBe(false);
    expect(result.reason).toBe('already-current');
    expect(result.data.byteLength).toBe(backSlides.byteLength);
    expect(await deckTexts(result.data)).toEqual(await deckTexts(new Uint8Array(backSlides)));
  });

  it('does nothing when the song has no lyrics to print', async () => {
    const result = await applyConfessionSong(backSlides, song('가사 없는 곡', []));
    expect(result).toMatchObject({ applied: false, reason: 'no-lyrics' });
  });

  it('retitles a song name that the deck split across several runs', async () => {
    // Formatting changes mid-name (half of it bolded, say) leave the title in
    // two <a:t> elements — a deck authored by hand routinely looks like this.
    const zip = await JSZip.loadAsync(backSlides);
    const marker = await zip.file('ppt/slides/slide1.xml')!.async('string');
    expect(marker).toContain('<a:t>“Celebrate the Light”</a:t>');
    zip.file(
      'ppt/slides/slide1.xml',
      marker.replace(
        '<a:t>“Celebrate the Light”</a:t>',
        '<a:t>“Celebrate </a:t></a:r><a:r><a:rPr lang="en-US" b="1"/><a:t>the Light”</a:t>',
      ),
    );
    const split = await zip.generateAsync({ type: 'uint8array' });

    const result = await applyConfessionSong(split, song('새 고백송', ['가사 한 줄']));
    expect(result.applied).toBe(true);
    const texts = await deckTexts(result.data);
    expect(texts[0]).toContain('“새 고백송”');
    expect(texts[0]).not.toContain('Celebrate');
  });

  it('does nothing when the deck has no 공동체 고백 slide', async () => {
    // An administrator-supplied back deck that starts at 송별.
    const withoutBlock = await extractSlideSubset(backSlides, [5, 6, 7]);
    const result = await applyConfessionSong(withoutBlock, song('새 고백송', ['가사']));
    expect(result).toMatchObject({ applied: false, reason: 'no-block' });
  });

  it('hands back the deck it was given rather than throwing on a file it cannot read', async () => {
    // A confession song that cannot be printed must never fail the week's PPT.
    const notADeck = new Uint8Array([1, 2, 3, 4]);
    const result = await applyConfessionSong(notADeck, song('새 고백송', ['가사']));
    expect(result).toMatchObject({ applied: false, reason: 'failed' });
    expect(result.data).toBe(notADeck);
  });
});
