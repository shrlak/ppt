import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { buildImageDeck, containRect } from '../../src/lib/pptx/imageDeckBuilder';
import { assertPptxIntegrity, findBrokenRelationships } from '../../src/lib/pptx/pptxPackage';

const template = readFileSync(join(__dirname, '..', '..', 'public', 'template.pptx'));
const png1x1 = new Uint8Array(
  Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nGQAAAAASUVORK5CYII=', 'base64'),
);
const jpeg1x1 = new Uint8Array(
  Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABBQJ//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAwEBPwF//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAgEBPwF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQAGPwJ//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPyF//9oADAMBAAIAAwAAABD/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAEDAQE/EB//xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAECAQE/EB//xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAE/EB//2Q==', 'base64'),
);

describe('containRect', () => {
  it('centers a portrait image on a 4:3 slide without cropping', () => {
    expect(containRect(1000, 2000)).toEqual({ x: 2_857_500, y: 0, cx: 3_429_000, cy: 6_858_000 });
  });

  it('centers a wide image vertically without cropping', () => {
    expect(containRect(2000, 1000)).toEqual({ x: 0, y: 1_143_000, cx: 9_144_000, cy: 4_572_000 });
  });

  it('rejects non-positive dimensions', () => {
    expect(() => containRect(0, 100)).toThrow('이미지 크기');
  });
});

describe('buildImageDeck', () => {
  it('creates one valid image slide and relationship per source image', async () => {
    const result = await buildImageDeck(template, [
      { data: png1x1, mimeType: 'image/png', width: 1, height: 1 },
      { data: jpeg1x1, mimeType: 'image/jpeg', width: 1, height: 1 },
    ]);
    const zip = await JSZip.loadAsync(result);
    const slides = Object.keys(zip.files).filter((path) => /^ppt\/slides\/slide\d+\.xml$/.test(path));
    const media = Object.keys(zip.files).filter((path) => /^ppt\/media\/additional-image-\d+\.(png|jpg)$/.test(path));

    expect(slides).toHaveLength(2);
    expect(media).toEqual(['ppt/media/additional-image-1.png', 'ppt/media/additional-image-2.jpg']);
    for (const [index, path] of slides.entries()) {
      const xml = await zip.file(path)!.async('string');
      expect(xml).toContain(`<p:cNvPr id="${1000 + index}" name="추가 자료 ${index + 1}"/>`);
      expect(xml).toContain(`<a:blip r:embed="rIdAdditionalImage${index + 1}"/>`);
      expect(xml).not.toContain('눈부신 햇살');
    }
    expect(await findBrokenRelationships(zip)).toEqual([]);
    await expect(assertPptxIntegrity(result)).resolves.toBeUndefined();
  });

  it('rejects an empty image list', async () => {
    await expect(buildImageDeck(template, [])).rejects.toThrow('이미지가 없습니다');
  });
});
