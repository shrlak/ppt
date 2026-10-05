import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { buildPraiseDeck } from '../../src/praise/deckBuilder';
import { planPraiseDeck } from '../../src/praise/planner';
import {
  POSTER_SIZES,
  POSTER_TEXT_BOX,
  buildPosterSlide,
  posterInDeck,
  posterLayout,
  posterParagraphs,
} from '../../src/praise/poster';
import { decodePraiseSource, encodePraiseFiles, encodePraiseSource, praiseFingerprint, restorePraiseState } from '../../src/praise/source';
import { PRAISE_SLIDE_SIZE } from '../../src/praise/template';
import { emptyPoster, type PraisePoster } from '../../src/praise/types';
import { findBrokenRelationships } from '../../src/lib/pptx/pptxPackage';
import { slideOrderOf } from '../../src/lib/pptx/pptxSlices';
import type { AdditionalFile } from '../../src/lib/additionalFiles/types';
import type { Song } from '../../src/lib/utils/types';

const publicDir = join(__dirname, '..', '..', 'public');
const template = readFileSync(join(publicDir, 'praise-template.pptx'));
const png = readFileSync(join(__dirname, '..', 'fixtures', 'sheet-page.png'));
const pngData = png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength) as ArrayBuffer;

const song: Song = {
  id: 'goodness',
  title: '주님의 선하심',
  sections: [{ label: 'V', lines: ['사랑해요 주의 자비 변치 않네', '내 모든 삶 주의 손에 있네'] }],
  order: ['V'],
  linesPerSlide: 3,
};

function poster(patch: Partial<PraisePoster>): PraisePoster {
  return { ...emptyPoster(), enabled: true, ...patch };
}

/** A portrait flyer, as the page measures an uploaded picture. */
const flyer = { name: 'flyer.png', mimeType: 'image/png' as const, data: pngData, width: 1080, height: 1350 };

async function slideAt(deck: Uint8Array, index: number): Promise<{ xml: string; rels: string }> {
  const zip = await JSZip.loadAsync(deck);
  const name = (await slideOrderOf(zip))[index];
  return {
    xml: await zip.file(`ppt/slides/${name}`)!.async('string'),
    rels: await zip.file(`ppt/slides/_rels/${name}.rels`)!.async('string'),
  };
}

function texts(xml: string): string[] {
  return [...xml.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((match) => match[1]);
}

describe('the poster in the plan', () => {
  it('goes first, ahead of the cover, only when it is switched on and has something on it', () => {
    expect(planPraiseDeck([song], {}, [], [], poster({ title: 'Praise Night' })).slice(0, 2)).toEqual([
      { kind: 'poster' },
      { kind: 'cover' },
    ]);
    // Placed 'start', a file still follows the cover, not the poster.
    expect(
      planPraiseDeck([song], {}, [{ fileId: 'f', placement: 'start' }], [], poster({ title: 'Praise Night' })).slice(0, 3),
    ).toEqual([{ kind: 'poster' }, { kind: 'cover' }, { kind: 'additional', fileId: 'f' }]);
    expect(planPraiseDeck([song], {}, [], [], poster({ enabled: false, title: 'Praise Night' }))[0]).toEqual({ kind: 'cover' });
    expect(planPraiseDeck([song], {}, [], [], poster({}))[0]).toEqual({ kind: 'cover' });
    expect(posterInDeck(poster({ title: '   ' }))).toBe(false);
    expect(posterInDeck(poster({ image: flyer }))).toBe(true);
  });
});

describe('posterLayout', () => {
  it('shows the whole of a portrait flyer, centred, the background around it', () => {
    const layout = posterLayout(poster({ image: flyer, background: '112233' }));
    const picture = layout.picture!;
    expect(layout.background).toBe('112233');
    expect(picture.y).toBe(0);
    expect(picture.cy).toBe(PRAISE_SLIDE_SIZE.cy);
    expect(picture.x).toBeGreaterThan(0);
    expect(picture.x * 2 + picture.cx).toBeCloseTo(PRAISE_SLIDE_SIZE.cx, -1);
    expect(picture.cx / picture.cy).toBeCloseTo(1080 / 1350, 3);
    expect(layout.text).toBeNull();
  });

  it('fills the slide with the picture when asked, its edges running past the slide', () => {
    const picture = posterLayout(poster({ image: flyer, fit: 'cover' })).picture!;
    expect(picture.x).toBe(0);
    expect(picture.cx).toBe(PRAISE_SLIDE_SIZE.cx);
    expect(picture.y).toBeLessThan(0);
    expect(picture.y + picture.cy).toBeGreaterThan(PRAISE_SLIDE_SIZE.cy);
    expect(picture.cx / picture.cy).toBeCloseTo(1080 / 1350, 3);
  });

  it('keeps each line on one line: a short title at full size, a long one shrunk, the details at one size', () => {
    const short = posterParagraphs({ title: 'Praise Night', subtitle: '', details: '' });
    expect(short).toEqual([{ role: 'title', text: 'Praise Night', sz: POSTER_SIZES.title.base, spaceBefore: 0 }]);

    const paragraphs = posterParagraphs({
      title: 'EM & KM Praise Night — 주의 임재 안에서 함께 예배합니다',
      subtitle: '주의 임재 안에서',
      details: '2026년 9월 26일 (토) 오후 7시\n\n  Korean Central Church of Pittsburgh  ',
    });
    expect(paragraphs.map((paragraph) => paragraph.role)).toEqual(['title', 'subtitle', 'detail', 'detail']);
    expect(paragraphs[0].sz).toBeLessThan(POSTER_SIZES.title.base);
    expect(paragraphs[1].sz).toBe(POSTER_SIZES.subtitle.base);
    // Blank lines are dropped, the rest trimmed, every detail line one size.
    expect(paragraphs[3].text).toBe('Korean Central Church of Pittsburgh');
    expect(paragraphs[2].sz).toBe(paragraphs[3].sz);
    expect(paragraphs[1].spaceBefore).toBeGreaterThan(0);
    expect(paragraphs[2].spaceBefore).toBeGreaterThan(0);
    expect(paragraphs[3].spaceBefore).toBe(0);
  });

  it('brings every line down together when there are more than the slide can hold', () => {
    const details = Array.from({ length: 20 }, (_, index) => `안내 ${index + 1}`).join('\n');
    const paragraphs = posterParagraphs({ title: 'Praise Night', subtitle: '부제', details });
    const heightPt = paragraphs.reduce((sum, paragraph) => sum + (paragraph.sz / 100) * 1.2 + paragraph.spaceBefore / 100, 0);
    expect(heightPt).toBeLessThanOrEqual(POSTER_TEXT_BOX.cy / 12700);
    expect(paragraphs[0].sz).toBeLessThan(POSTER_SIZES.title.base);
  });
});

describe('buildPosterSlide', () => {
  it('is an ordinary picture and an ordinary text box on a plain background, so it stays editable', () => {
    const xml = buildPosterSlide(poster({ image: flyer, title: 'A & B <Night>', details: '7PM', textColor: 'FFEEDD' }));
    expect(xml).toContain('<p:pic>');
    expect(xml).toContain('name="PraisePosterPicture"');
    expect(xml).toContain('r:embed="rId2"');
    expect(xml).toContain('<p:cNvSpPr txBox="1"/>');
    expect(xml).toContain('<a:srgbClr val="FFEEDD"/>');
    // Over a picture the words get a shadow; the text is escaped.
    expect(xml).toContain('<a:outerShdw');
    expect(texts(xml)).toEqual(['A &amp; B &lt;Night&gt;', '7PM']);
    // No background picture: nothing baked in where it cannot be edited.
    expect(xml.match(/<p:bg>[\s\S]*?<\/p:bg>/)![0]).not.toContain('<a:blip');
  });

  it('leaves out what is not there: no picture, no shadow, no empty text box', () => {
    const words = buildPosterSlide(poster({ title: 'Praise Night' }));
    expect(words).not.toContain('<p:pic>');
    expect(words).not.toContain('<a:outerShdw');
    const picture = buildPosterSlide(poster({ image: flyer }));
    expect(picture).not.toContain('PraisePosterText');
  });
});

describe('buildPraiseDeck with a poster', () => {
  it('opens the deck with the poster, its picture in the package, then the cover', async () => {
    const { deck, overview } = await buildPraiseDeck({
      template,
      songs: [song],
      extras: {},
      date: '2026-09-26',
      poster: poster({ image: flyer, title: 'EM & KM Praise Night', details: '09/26/2026\nPittsburgh' }),
    });
    expect(overview.slice(0, 2).map((row) => row.label)).toEqual(['포스터', '표지']);

    const first = await slideAt(deck, 0);
    expect(texts(first.xml)).toEqual(['EM &amp; KM Praise Night', '09/26/2026', 'Pittsburgh']);
    expect(first.rels).toContain('Target="../media/praise-poster.png"');
    // Drawn on the template's blank layout: no placeholder shows through.
    const layout = first.rels.match(/Target="\.\.\/(slideLayouts\/[^"]+)"/)![1];
    const zip = await JSZip.loadAsync(deck);
    expect(await zip.file(`ppt/${layout}`)!.async('string')).toMatch(/<p:sldLayout\b[^>]*type="blank"/);
    expect(zip.file('ppt/media/praise-poster.png')).not.toBeNull();
    expect(await zip.file('[Content_Types].xml')!.async('string')).toMatch(/Extension="png"/);
    expect(await findBrokenRelationships(zip)).toEqual([]);

    expect(texts((await slideAt(deck, 1)).xml)).toEqual(['09/26/2026']);
  });

  it('builds a poster of words alone, and leaves a switched-off poster out', async () => {
    const words = await buildPraiseDeck({ template, songs: [song], extras: {}, date: '', poster: poster({ title: 'Praise Night' }) });
    const first = await slideAt(words.deck, 0);
    expect(texts(first.xml)).toEqual(['Praise Night']);
    expect(first.rels).not.toContain('relationships/image');
    expect(await findBrokenRelationships(await JSZip.loadAsync(words.deck))).toEqual([]);

    const off = await buildPraiseDeck({
      template,
      songs: [song],
      extras: {},
      date: '',
      poster: poster({ enabled: false, title: 'Praise Night' }),
    });
    expect(off.overview[0].label).toBe('표지');
    expect(off.overview).toHaveLength(words.overview.length - 1);
  });
});

describe('the poster in the saved night', () => {
  const sermon: AdditionalFile = { id: 'sermon', name: '설교.png', kind: 'png', data: pngData, slideCount: 1 };
  const base = {
    date: '2026-09-26',
    songs: [song],
    extras: {},
    prayers: [],
    additionalFiles: [sermon],
    placements: [{ fileId: 'sermon', placement: 'end' as const }],
  };

  it('comes back with its picture, words and colours, beside the 추가 자료 and a new cover', async () => {
    const saved = poster({
      image: { ...flyer, data: pngData.slice(0, 100) },
      fit: 'cover',
      background: 'ABCDEF',
      title: 'Praise Night',
      subtitle: '주의 임재',
      details: '7PM\nPittsburgh',
      textColor: '010203',
    });
    const state = {
      ...base,
      coverImage: { name: 'cover.png', mimeType: 'image/png' as const, data: pngData },
      poster: saved,
    };
    const source = decodePraiseSource(encodePraiseSource(state))!;
    const restored = await restorePraiseState(source, await encodePraiseFiles(state));
    expect(restored.poster).toEqual(saved);
    expect(restored.poster!.image!.data.byteLength).toBe(100);
    expect(restored.coverImage!.data.byteLength).toBe(pngData.byteLength);
    expect(restored.additionalFiles.map((file) => file.name)).toEqual(['설교.png']);
  });

  it('keeps a switched-off poster as it was, and opens an older night with none', async () => {
    const off = poster({ enabled: false, title: 'Praise Night' });
    const state = { ...base, coverImage: null, poster: off };
    const restored = await restorePraiseState(decodePraiseSource(encodePraiseSource(state))!, await encodePraiseFiles(state));
    expect(restored.poster).toEqual(off);
    expect(restored.additionalFiles).toHaveLength(1);

    const older = { ...base, coverImage: null };
    const file = encodePraiseSource(older);
    expect(JSON.parse(new TextDecoder().decode(file.data)).poster).toBeUndefined();
    const reopened = await restorePraiseState(decodePraiseSource(file)!, await encodePraiseFiles(older));
    expect(reopened.poster).toEqual(emptyPoster());
  });

  it('counts as a change to save whenever the poster changes', () => {
    const state = { ...base, coverImage: null, poster: poster({ title: 'Praise Night' }), name: '0926_PraiseNight.pptx' };
    const before = praiseFingerprint(state);
    expect(praiseFingerprint({ ...state, poster: poster({ title: 'Praise Night!' }) })).not.toBe(before);
    expect(praiseFingerprint({ ...state, poster: poster({ title: 'Praise Night', enabled: false }) })).not.toBe(before);
    expect(praiseFingerprint({ ...state, poster: poster({ title: 'Praise Night', image: flyer }) })).not.toBe(before);
  });
});
