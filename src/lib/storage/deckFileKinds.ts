// The set of files archived on one 라이브러리 entry. Declared apart from
// pptLibrary.ts — which needs IndexedDB and the rest of the browser storage
// APIs — so the Worker's own list (PPT_FILE_KINDS in worker/src/library.js)
// can be diffed against it in a plain Node test. The two must agree: the
// client uploads a chunk stream for every kind it declares, and a kind the
// Worker's routes don't know fails the entire deck upload, not just that file.
export type SavedFileKind = 'pptx' | 'contiPdf' | 'sermonPptx' | 'source' | 'additionalFiles';

/** Every kind travels the same chunked upload/download path. */
export const SAVED_FILE_KINDS: SavedFileKind[] = [
  'pptx',
  'contiPdf',
  'sermonPptx',
  'source',
  'additionalFiles',
];
