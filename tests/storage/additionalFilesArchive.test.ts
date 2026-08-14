import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { decodeAdditionalFiles, encodeAdditionalFiles } from '../../src/lib/storage/additionalFilesArchive';
import type { AdditionalFile } from '../../src/lib/additionalFiles/types';

function uploaded(
  id: string,
  name: string,
  kind: AdditionalFile['kind'],
  bytes: number[],
  slideCount: number,
): AdditionalFile {
  return { id, name, kind, data: new Uint8Array(bytes).buffer, slideCount };
}

describe('additional-files library archive', () => {
  it('round-trips names, kinds, bytes, counts, and order', async () => {
    const input = [
      uploaded('pdf-id', '주보 pages.pdf', 'pdf', [0x25, 0x50, 0x44, 0x46, 1], 2),
      uploaded('png-id', 'photo.png', 'png', [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 2], 1),
    ];

    const encoded = await encodeAdditionalFiles(input);
    expect(encoded?.name).toBe('additional-files.zip');
    const decoded = await decodeAdditionalFiles(encoded!);

    expect(decoded.map(({ name, kind, slideCount }) => ({ name, kind, slideCount }))).toEqual([
      { name: '주보 pages.pdf', kind: 'pdf', slideCount: 2 },
      { name: 'photo.png', kind: 'png', slideCount: 1 },
    ]);
    expect(new Uint8Array(decoded[0].data)).toEqual(new Uint8Array(input[0].data));
    expect(new Uint8Array(decoded[1].data)).toEqual(new Uint8Array(input[1].data));
    expect(decoded[0].id).not.toBe(input[0].id);
  });

  it('represents an empty list as no archive', async () => {
    await expect(encodeAdditionalFiles([])).resolves.toBeNull();
  });

  it('rejects a manifest that references a missing file', async () => {
    const zip = new JSZip();
    zip.file(
      'manifest.json',
      JSON.stringify({
        version: 1,
        files: [{ path: 'files/0000', name: 'missing.pdf', kind: 'pdf', slideCount: 1 }],
      }),
    );
    const bytes = await zip.generateAsync({ type: 'uint8array' });

    await expect(
      decodeAdditionalFiles({ name: 'additional-files.zip', data: bytes.buffer as ArrayBuffer }),
    ).rejects.toThrow('추가 자료 보관 파일이 손상되었습니다');
  });

  it('rejects an unknown archive version instead of partially restoring it', async () => {
    const zip = new JSZip();
    zip.file('manifest.json', JSON.stringify({ version: 2, files: [] }));
    const bytes = await zip.generateAsync({ type: 'uint8array' });

    await expect(
      decodeAdditionalFiles({ name: 'additional-files.zip', data: bytes.buffer as ArrayBuffer }),
    ).rejects.toThrow('추가 자료 보관 파일이 손상되었습니다');
  });
});
