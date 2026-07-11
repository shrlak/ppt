import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { extractSlideSubset } from '../src/lib/pptxSlices';
import { findBrokenRelationships } from '../src/lib/pptxPackage';

const serviceTemplate = readFileSync(join(__dirname, '..', 'public', 'service-template.pptx'));

function slideFiles(zip: JSZip): string[] {
  return Object.keys(zip.files).filter((f) => /^ppt\/slides\/slide\d+\.xml$/.test(f));
}

describe('extractSlideSubset', () => {
  it('extracts a contiguous range in order (intro slides 1-4)', async () => {
    const out = await extractSlideSubset(serviceTemplate, [1, 2, 3, 4]);
    const zip = await JSZip.loadAsync(out);
    const slides = slideFiles(zip);
    expect(slides).toHaveLength(4);

    const slide1 = await zip.file('ppt/slides/slide1.xml')!.async('string');
    expect(slide1).toContain('빛주사랑');
    const slide2 = await zip.file('ppt/slides/slide2.xml')!.async('string');
    expect(slide2).toContain('신앙고백');

    const presentation = await zip.file('ppt/presentation.xml')!.async('string');
    expect(presentation.match(/<p:sldId /g)).toHaveLength(4);
  });

  it('extracts a single slide by its position (기도)', async () => {
    const out = await extractSlideSubset(serviceTemplate, [17]);
    const zip = await JSZip.loadAsync(out);
    expect(slideFiles(zip)).toHaveLength(1);
    const slide1 = await zip.file('ppt/slides/slide1.xml')!.async('string');
    expect(slide1).toContain('기도');
    expect(slide1).toContain('Prayer');
  });

  it('allows requesting the same slide position more than once', async () => {
    const out = await extractSlideSubset(serviceTemplate, [17, 17]);
    const zip = await JSZip.loadAsync(out);
    const slides = slideFiles(zip);
    expect(slides).toHaveLength(2);
    for (const path of slides) {
      const xml = await zip.file(path)!.async('string');
      expect(xml).toContain('기도');
    }
  });

  it('preserves each slide\'s rels pointing at existing parts', async () => {
    const out = await extractSlideSubset(serviceTemplate, [1, 17, 32]);
    const zip = await JSZip.loadAsync(out);
    for (const path of slideFiles(zip)) {
      const name = path.split('/').pop()!;
      const rels = await zip.file(`ppt/slides/_rels/${name}.rels`)!.async('string');
      for (const m of rels.matchAll(/Target="([^"]+)"/g)) {
        const resolved = new URL(m[1], 'zip:///ppt/slides/').pathname.replace(/^\//, '');
        expect(zip.file(resolved), `${path} references missing part ${resolved}`).not.toBeNull();
      }
    }
    expect(await findBrokenRelationships(zip)).toEqual([]);
    expect(Object.keys(zip.files).some((path) => path.startsWith('ppt/notesSlides/'))).toBe(false);
  });

  it('adds a Content_Types override for every extracted slide', async () => {
    const out = await extractSlideSubset(serviceTemplate, [1, 2, 3, 4]);
    const zip = await JSZip.loadAsync(out);
    const contentTypes = await zip.file('[Content_Types].xml')!.async('string');
    for (const path of slideFiles(zip)) {
      expect(contentTypes).toContain(`PartName="/${path}"`);
    }
  });

  it('throws for an out-of-range slide number', async () => {
    await expect(extractSlideSubset(serviceTemplate, [9999])).rejects.toThrow();
  });
});
