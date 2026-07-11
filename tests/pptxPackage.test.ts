import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { assertPptxIntegrity, findBrokenRelationships, stripNonVisualParts } from '../src/lib/pptxPackage';

const frontSlides = readFileSync(join(__dirname, '..', 'public', 'front-slides.pptx'));

describe('pptx package integrity', () => {
  it('removes notes parts and their incoming relationships together', async () => {
    const zip = await JSZip.loadAsync(frontSlides);
    expect(Object.keys(zip.files).some((path) => path.startsWith('ppt/notesSlides/'))).toBe(true);

    await stripNonVisualParts(zip);

    expect(Object.keys(zip.files).some((path) => path.startsWith('ppt/notesSlides/'))).toBe(false);
    expect(Object.keys(zip.files).some((path) => path.startsWith('ppt/notesMasters/'))).toBe(false);
    expect(await findBrokenRelationships(zip)).toEqual([]);
  });

  it('accepts a sanitized standalone deck', async () => {
    const zip = await JSZip.loadAsync(frontSlides);
    await stripNonVisualParts(zip);
    const data = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
    await expect(assertPptxIntegrity(data)).resolves.toBeUndefined();
  });

  it('rejects a package with a missing internal relationship target', async () => {
    const zip = await JSZip.loadAsync(frontSlides);
    zip.remove('ppt/slideLayouts/slideLayout1.xml');
    const data = await zip.generateAsync({ type: 'uint8array' });
    await expect(assertPptxIntegrity(data)).rejects.toThrow('PPTX 무결성 검사 실패');
  });
});
