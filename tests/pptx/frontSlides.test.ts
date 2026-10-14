import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import {
  applyFrontSlideDate,
  formatFrontSlideDate,
  rewriteDateParagraphs,
} from '../../src/lib/pptx/frontSlides';
import { serviceSunday } from '../../src/lib/pptx/pptxBuilder';
import { assertPptxIntegrity } from '../../src/lib/pptx/pptxPackage';

const frontSlides = readFileSync(join(__dirname, '..', '..', 'public', 'front-slides.pptx'));

/** Every `<a:t>` run's text on the slide, joined. */
async function slideText(deck: Uint8Array | Buffer, name: string): Promise<string> {
  const zip = await JSZip.loadAsync(deck);
  const xml = await zip.file(`ppt/slides/${name}`)!.async('string');
  return [...xml.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((match) => match[1]).join('');
}

describe('formatFrontSlideDate', () => {
  it('prints MM/DD/YYYY, the way the bundled welcome slide does', () => {
    expect(formatFrontSlideDate(new Date(2026, 6, 12))).toBe('07/12/2026');
    expect(formatFrontSlideDate(new Date(2026, 9, 18))).toBe('10/18/2026');
  });
});

describe('serviceSunday', () => {
  it('is the Sunday of the conti date, like the download name', () => {
    // A Saturday conti belongs to the next day's service.
    expect(serviceSunday('7/11/26')).toEqual(new Date(2026, 6, 12));
    expect(serviceSunday('2026.10.18')).toEqual(new Date(2026, 9, 18));
  });

  it('falls back to the coming Sunday when the conti has no date', () => {
    expect(serviceSunday(undefined, new Date(2026, 9, 14))).toEqual(new Date(2026, 9, 18));
  });
});

describe('rewriteDateParagraphs', () => {
  it('collapses a date split across runs into the first run, keeping its formatting', () => {
    const xml =
      '<a:p><a:pPr algn="r"/>' +
      '<a:r><a:rPr lang="ko-KR" sz="2100" b="0"/><a:t>0</a:t></a:r>' +
      '<a:r><a:rPr lang="ko-KR" sz="2100"/><a:t>7</a:t></a:r>' +
      '<a:r><a:rPr lang="ko-KR" sz="2100"/><a:t>/12/2026</a:t></a:r>' +
      '<a:endParaRPr sz="2100"/></a:p>';
    expect(rewriteDateParagraphs(xml, '10/18/2026')).toBe(
      '<a:p><a:pPr algn="r"/>' +
        '<a:r><a:rPr lang="ko-KR" sz="2100" b="0"/><a:t>10/18/2026</a:t></a:r>' +
        '<a:endParaRPr sz="2100"/></a:p>',
    );
  });

  it('leaves every other paragraph alone', () => {
    const xml =
      '<a:p><a:r><a:t>빛주사랑</a:t></a:r></a:p>' +
      '<a:p><a:r><a:t>로마서 5:1-2</a:t></a:r></a:p>' +
      '<a:p><a:r><a:t>Sunday 7/12/2026</a:t></a:r></a:p>';
    expect(rewriteDateParagraphs(xml, '10/18/2026')).toBe(xml);
  });
});

describe('applyFrontSlideDate', () => {
  it("prints the service Sunday on the welcome slide's date line", async () => {
    expect(await slideText(frontSlides, 'slide2.xml')).toBe('빛주사랑대학청년부07/12/2026');

    const result = await applyFrontSlideDate(frontSlides, new Date(2026, 9, 18));

    expect(result.applied).toBe(true);
    expect(await slideText(result.data, 'slide2.xml')).toBe('빛주사랑대학청년부10/18/2026');
    await expect(assertPptxIntegrity(result.data)).resolves.toBeUndefined();
  });

  it('touches nothing but the date', async () => {
    const result = await applyFrontSlideDate(frontSlides, new Date(2026, 9, 18));
    for (const name of ['slide1.xml', 'slide3.xml', 'slide4.xml', 'slide5.xml']) {
      expect(await slideText(result.data, name)).toBe(await slideText(frontSlides, name));
    }
  });

  it('returns the deck byte-for-byte when it already reads that date', async () => {
    const result = await applyFrontSlideDate(frontSlides, new Date(2026, 6, 12));
    expect(result.applied).toBe(false);
    expect(Buffer.from(result.data).equals(frontSlides)).toBe(true);
  });

  it('sends a deck it cannot read out unchanged instead of failing the PPT', async () => {
    const broken = new Uint8Array([1, 2, 3]);
    const result = await applyFrontSlideDate(broken, new Date(2026, 9, 18));
    expect(result).toEqual({ data: broken, applied: false });
  });
});
