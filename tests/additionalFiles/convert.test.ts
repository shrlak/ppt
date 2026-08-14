import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { convertAdditionalFile, inspectAdditionalUpload } from '../../src/lib/additionalFiles/convert';

const frontSlides = readFileSync(join(__dirname, '..', '..', 'public', 'front-slides.pptx'));
const template = readFileSync(join(__dirname, '..', '..', 'public', 'template.pptx'));

describe('additional PPTX conversion', () => {
  it('passes a valid PPTX through and reports its real slide count', async () => {
    const file = await inspectAdditionalUpload(new File([frontSlides], 'extra.pptx'));

    expect(file.kind).toBe('pptx');
    expect(file.slideCount).toBe(4);
    const converted = await convertAdditionalFile(file, template.buffer as ArrayBuffer);
    expect(converted.slideCount).toBe(4);
    expect(converted.deck).toEqual(new Uint8Array(frontSlides));
  });

  it('rejects a ZIP that is not a presentation and names the file', async () => {
    const zip = new JSZip();
    zip.file('hello.txt', 'no slides');
    const bytes = await zip.generateAsync({ type: 'uint8array' });

    await expect(
      inspectAdditionalUpload(new File([bytes.buffer as ArrayBuffer], 'fake.pptx')),
    ).rejects.toThrow('fake.pptx');
  });

  it('rejects an empty supported file and names it', async () => {
    await expect(inspectAdditionalUpload(new File([], 'empty.png'))).rejects.toThrow('empty.png');
  });
});
