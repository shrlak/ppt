import { describe, expect, it } from 'vitest';
import { detectAdditionalFileKind, moveAdditionalFile } from '../../src/lib/additionalFiles/files';
import type { AdditionalFile } from '../../src/lib/additionalFiles/types';

function item(id: string): AdditionalFile {
  return {
    id,
    name: `${id}.png`,
    kind: 'png',
    data: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).buffer,
    slideCount: 1,
  };
}

describe('detectAdditionalFileKind', () => {
  it('recognizes PDF, PNG, JPEG, and PPTX signatures', () => {
    expect(detectAdditionalFileKind('pages.bin', new Uint8Array([0x25, 0x50, 0x44, 0x46]))).toBe('pdf');
    expect(
      detectAdditionalFileKind(
        'photo.bin',
        new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      ),
    ).toBe('png');
    expect(detectAdditionalFileKind('photo.bin', new Uint8Array([0xff, 0xd8, 0xff]))).toBe('jpeg');
    expect(detectAdditionalFileKind('deck.pptx', new Uint8Array([0x50, 0x4b, 0x03, 0x04]))).toBe('pptx');
  });

  it('rejects a supported extension whose bytes have the wrong signature', () => {
    expect(() => detectAdditionalFileKind('fake.pdf', new Uint8Array([1, 2, 3]))).toThrow(
      '지원하지 않거나 손상된 파일',
    );
  });

  it('does not treat an arbitrary ZIP as a PPTX without the PPTX extension', () => {
    expect(() => detectAdditionalFileKind('archive.zip', new Uint8Array([0x50, 0x4b, 0x03, 0x04]))).toThrow(
      '지원하지 않거나 손상된 파일',
    );
  });
});

describe('moveAdditionalFile', () => {
  it('moves one item by one slot without mutating the input', () => {
    const items = [item('a'), item('b'), item('c')];
    const moved = moveAdditionalFile(items, 'b', -1);

    expect(moved.map((candidate) => candidate.id)).toEqual(['b', 'a', 'c']);
    expect(items.map((candidate) => candidate.id)).toEqual(['a', 'b', 'c']);
  });

  it('leaves boundary and unknown moves unchanged', () => {
    const items = [item('a'), item('b')];
    expect(moveAdditionalFile(items, 'a', -1)).toEqual(items);
    expect(moveAdditionalFile(items, 'b', 1)).toEqual(items);
    expect(moveAdditionalFile(items, 'missing', 1)).toEqual(items);
  });
});
