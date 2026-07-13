import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { assertPptxIntegrity, findBrokenRelationships, stripNonVisualParts } from '../../src/lib/pptx/pptxPackage';

const frontSlides = readFileSync(join(__dirname, '..', '..', 'public', 'front-slides.pptx'));

describe('pptx package integrity', () => {
  it('removes notes parts and their incoming relationships together', async () => {
    const zip = await JSZip.loadAsync(frontSlides);
    expect(Object.keys(zip.files).some((path) => path.startsWith('ppt/notesSlides/'))).toBe(true);

    await stripNonVisualParts(zip);

    expect(Object.keys(zip.files).some((path) => path.startsWith('ppt/notesSlides/'))).toBe(false);
    expect(Object.keys(zip.files).some((path) => path.startsWith('ppt/notesMasters/'))).toBe(false);
    expect(await findBrokenRelationships(zip)).toEqual([]);
  });

  it('removes the notes master reference from presentation.xml along with the part', async () => {
    const zip = await JSZip.loadAsync(frontSlides);
    expect(await zip.file('ppt/presentation.xml')!.async('string')).toContain('<p:notesMasterIdLst>');

    await stripNonVisualParts(zip);

    // Leaving <p:notesMasterId r:id="..."/> behind after its relationship is
    // stripped makes PowerPoint prompt to repair the downloaded file.
    expect(await zip.file('ppt/presentation.xml')!.async('string')).not.toContain('notesMasterIdLst');
  });

  it('reports relationship references that have no matching relationship entry', async () => {
    const zip = await JSZip.loadAsync(frontSlides);
    await stripNonVisualParts(zip);
    const presentation = await zip.file('ppt/presentation.xml')!.async('string');
    zip.file(
      'ppt/presentation.xml',
      presentation.replace('</p:presentation>', '<p:notesMasterIdLst><p:notesMasterId r:id="rId999"/></p:notesMasterIdLst></p:presentation>'),
    );

    const errors = await findBrokenRelationships(zip);
    expect(errors.some((e) => e.includes('dangling relationship reference rId999'))).toBe(true);
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

  it('rejects a package whose XML carries characters XML cannot represent', async () => {
    const zip = await JSZip.loadAsync(frontSlides);
    await stripNonVisualParts(zip);
    const slide = await zip.file('ppt/slides/slide1.xml')!.async('string');
    // A raw form feed — what OCR text can smuggle in — is illegal even escaped.
    zip.file('ppt/slides/slide1.xml', slide.replace('</p:sld>', '\u000C</p:sld>'));
    const data = await zip.generateAsync({ type: 'uint8array' });
    await expect(assertPptxIntegrity(data)).rejects.toThrow('characters not allowed in XML');
  });
});
