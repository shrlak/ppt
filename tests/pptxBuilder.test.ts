import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { buildPptx, suggestFileName, xmlEscape } from '../src/lib/pptxBuilder';
import { planAllSlides } from '../src/lib/slidePlanner';
import type { Song } from '../src/lib/types';

const template = readFileSync(join(__dirname, '..', 'public', 'template.pptx'));

const songA: Song = {
  id: 'a',
  title: '주님의 사랑 & 은혜',
  key: 'E',
  sections: [
    { label: 'V1', lines: ['눈부신 햇살', '저 하늘 너머 내게 주어진'] },
    { label: 'C', lines: ['후렴 1', '후렴 2', '후렴 3', '후렴 4', '후렴 5'] },
  ],
  order: ['I', 'V1', 'C', 'I', 'C'],
  linesPerSlide: 4,
};

const songB: Song = {
  id: 'b',
  title: '입례',
  sections: [{ label: 'C', lines: ['우리 모두 예배하는 자 되어'] }],
  order: ['C'],
  linesPerSlide: 4,
};

describe('buildPptx', () => {
  it('creates the planned number of slides with consistent part lists', async () => {
    const songs = [songA, songB];
    const expected = planAllSlides(songs).length;
    const out = await buildPptx(template, songs);
    const zip = await JSZip.loadAsync(out);

    const slideFiles = Object.keys(zip.files).filter((f) =>
      /^ppt\/slides\/slide\d+\.xml$/.test(f),
    );
    expect(slideFiles).toHaveLength(expected);

    const presentation = await zip.file('ppt/presentation.xml')!.async('string');
    expect(presentation.match(/<p:sldId /g)).toHaveLength(expected);
    expect(presentation).not.toContain('GoogleSlidesCustomDataVersion2');

    const contentTypes = await zip.file('[Content_Types].xml')!.async('string');
    expect(contentTypes.match(/PartName="\/ppt\/slides\/slide\d+\.xml"/g)).toHaveLength(expected);
    expect(contentTypes).not.toContain('notesSlides');
    expect(contentTypes).not.toContain('/ppt/metadata');

    const presRels = await zip.file('ppt/_rels/presentation.xml.rels')!.async('string');
    expect(presRels.match(/relationships\/slide"/g)).toHaveLength(expected);
    expect(presRels).not.toContain('presentationmetadata');

    // No notes slides remain; template media and layouts are kept.
    expect(Object.keys(zip.files).some((f) => f.startsWith('ppt/notesSlides/'))).toBe(false);
    expect(zip.file('ppt/media/image2.png')).not.toBeNull();
    expect(zip.file('ppt/slideLayouts/slideLayout1.xml')).not.toBeNull();
  });

  it('escapes XML in titles and writes lyrics into slides', async () => {
    const out = await buildPptx(template, [songA, songB]);
    const zip = await JSZip.loadAsync(out);

    const slide1 = await zip.file('ppt/slides/slide1.xml')!.async('string');
    expect(slide1).toContain('주님의 사랑 &amp; 은혜');

    const slide2 = await zip.file('ppt/slides/slide2.xml')!.async('string');
    expect(slide2).toContain('눈부신 햇살');
    expect(slide2).toContain('저 하늘 너머 내게 주어진');
    // Corner label carries the (escaped) song title.
    expect(slide2).toContain('주님의 사랑 &amp; 은혜');
  });

  it('sets 1.25 line spacing on lyric paragraphs', async () => {
    const out = await buildPptx(template, [songA]);
    const zip = await JSZip.loadAsync(out);
    const slide2 = await zip.file('ppt/slides/slide2.xml')!.async('string');
    expect(slide2).toContain('<a:lnSpc><a:spcPct val="125000"/></a:lnSpc>');
    expect(slide2).not.toContain('<a:lnSpc><a:spcPct val="115000"/></a:lnSpc>');
  });

  it('gives every slide a rels file pointing at an existing layout', async () => {
    const out = await buildPptx(template, [songA, songB]);
    const zip = await JSZip.loadAsync(out);
    const slideFiles = Object.keys(zip.files).filter((f) =>
      /^ppt\/slides\/slide\d+\.xml$/.test(f),
    );
    for (const f of slideFiles) {
      const relPath = f.replace('slides/', 'slides/_rels/') + '.rels';
      const rels = await zip.file(relPath)!.async('string');
      const layout = rels.match(/slideLayouts\/(slideLayout\d+\.xml)/)?.[1];
      expect(layout, `${relPath} references a layout`).toBeTruthy();
      expect(zip.file(`ppt/slideLayouts/${layout}`)).not.toBeNull();
    }
  });

  it('chunks long sections across multiple slides, each part once', async () => {
    const out = await buildPptx(template, [songA]);
    const zip = await JSZip.loadAsync(out);
    // songA: title, V1(2 lines -> 1 slide), C(5 lines -> 4+1 slides) = 4 slides.
    // Repeats in the 콘티 order (I, C again) add nothing further.
    const slideFiles = Object.keys(zip.files).filter((f) =>
      /^ppt\/slides\/slide\d+\.xml$/.test(f),
    );
    expect(slideFiles).toHaveLength(4);
    const slide4 = await zip.file('ppt/slides/slide4.xml')!.async('string');
    expect(slide4).toContain('후렴 5');
  });

  it('rejects an empty song list', async () => {
    await expect(buildPptx(template, [])).rejects.toThrow();
  });
});

describe('suggestFileName', () => {
  it('uses the upcoming Sunday for a Saturday conti date', () => {
    expect(suggestFileName('7/11/26')).toBe('0712.pptx');
  });
  it('keeps a Sunday conti date unchanged', () => {
    expect(suggestFileName('7/12/26')).toBe('0712.pptx');
  });
  it('handles a Sunday in the next year', () => {
    expect(suggestFileName('12/31/26')).toBe('0103.pptx');
  });
  it('uses the current week when the conti date is missing or invalid', () => {
    const friday = new Date(2026, 6, 10);
    expect(suggestFileName(undefined, friday)).toBe('0712.pptx');
    expect(suggestFileName('not-a-date', friday)).toBe('0712.pptx');
  });
});

describe('xmlEscape', () => {
  it('escapes the five XML special characters', () => {
    expect(xmlEscape(`<a & "b" 'c'>`)).toBe('&lt;a &amp; &quot;b&quot; &apos;c&apos;&gt;');
  });

  it('replaces or strips characters XML 1.0 cannot carry', () => {
    // Vertical tab (Word soft line break) and form feed (OCR page separator)
    // become spaces; other control characters and lone surrogates vanish.
    expect(xmlEscape('주\u000B님\u000C의')).toBe('주 님 의');
    expect(xmlEscape('사\u0000랑\u0007과\u001F')).toBe('사랑과');
    expect(xmlEscape('은\uD800혜')).toBe('은혜');
    expect(xmlEscape('平\t안\n과\r기쁨')).toBe('平\t안\n과\r기쁨');
  });
});
