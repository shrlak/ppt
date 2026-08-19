import { describe, expect, it } from 'vitest';
import { dragCarriesFiles, isPdfFile, readContiDrop } from '../../src/lib/utils/fileDrop';

const pdf = (name = 'conti.pdf') => new File([new Uint8Array([1])], name, { type: 'application/pdf' });

describe('dragCarriesFiles', () => {
  it('accepts a drag that carries files', () => {
    expect(dragCarriesFiles({ types: ['Files'] })).toBe(true);
    expect(dragCarriesFiles({ types: ['text/plain', 'Files'] })).toBe(true);
  });

  it('ignores dragged text, links and in-page drags', () => {
    expect(dragCarriesFiles({ types: ['text/plain'] })).toBe(false);
    expect(dragCarriesFiles({ types: ['text/uri-list', 'text/html'] })).toBe(false);
    expect(dragCarriesFiles({ types: [] })).toBe(false);
    expect(dragCarriesFiles(null)).toBe(false);
    expect(dragCarriesFiles(undefined)).toBe(false);
  });
});

describe('isPdfFile', () => {
  it('reads the MIME type when the browser sends one', () => {
    expect(isPdfFile(pdf())).toBe(true);
  });

  it('falls back to the file name, whatever its case', () => {
    expect(isPdfFile(new File([], 'CONTI.PDF'))).toBe(true);
    expect(isPdfFile(new File([], 'conti.pdf', { type: '' }))).toBe(true);
  });

  it('rejects the other files this app takes', () => {
    expect(isPdfFile(new File([], 'sermon.pptx'))).toBe(false);
    expect(isPdfFile(new File([], 'slide.png', { type: 'image/png' }))).toBe(false);
    expect(isPdfFile(new File([], 'pdf-notes.txt'))).toBe(false);
  });
});

describe('readContiDrop', () => {
  it('picks the dropped PDF', () => {
    const file = pdf();
    expect(readContiDrop([file])).toEqual({ kind: 'pdf', file });
  });

  it('takes the first PDF when it arrives alongside other files', () => {
    const file = pdf('second.pdf');
    expect(readContiDrop([new File([], 'note.txt'), file, pdf('third.pdf')])).toEqual({
      kind: 'pdf',
      file,
    });
  });

  it('reports files it cannot use instead of silently dropping them', () => {
    expect(readContiDrop([new File([], 'sermon.pptx'), new File([], 'photo.jpg')])).toEqual({
      kind: 'unsupported',
      names: ['sermon.pptx', 'photo.jpg'],
    });
  });

  it('says nothing was dropped when the transfer is empty', () => {
    expect(readContiDrop([])).toEqual({ kind: 'empty' });
    expect(readContiDrop(null)).toEqual({ kind: 'empty' });
    expect(readContiDrop(undefined)).toEqual({ kind: 'empty' });
  });
});
