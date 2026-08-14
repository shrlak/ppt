import { describe, expect, it } from 'vitest';
import {
  autoSaveLabel,
  deckFingerprint,
  type AutoSaveInputs,
} from '../../src/lib/storage/deckAutoSave';
import type { Song } from '../../src/lib/utils/types';

const song: Song = {
  id: 'song-1',
  title: '주 은혜임을',
  key: 'E',
  description: '1절부터',
  sections: [{ label: 'V1', lines: ['내가 살아가는 날 동안', '주 은혜임을'] }],
  order: ['I', 'V1', 'C'],
  linesPerSlide: 4,
  pageIndex: 3,
};

const inputs: AutoSaveInputs = {
  name: '0726.pptx',
  contiDate: '7/26/26',
  songs: [song],
  bible: { verseInput: '요3:16', sermonTitle: '사랑', translations: ['nkrv', 'esv'], versesPerSlide: 2 },
  bibleTemplate: null,
  announcementText: '1. <새가족 환영>\n환영합니다.',
  sermonFile: { name: '설교.pptx', data: new ArrayBuffer(2048) },
  contiFile: { name: 'conti.pdf', data: new ArrayBuffer(4096) },
  additionalFiles: [
    { name: '마지막-안내.png', data: new ArrayBuffer(128) },
    { name: '선교보고.pptx', data: new ArrayBuffer(512) },
  ],
  frontDeck: null,
  backDeck: null,
};

function withSong(changes: Partial<Song>): AutoSaveInputs {
  return { ...inputs, songs: [{ ...song, ...changes }] };
}

describe('auto-save change detection', () => {
  it('is stable for the same inputs', () => {
    expect(deckFingerprint(inputs)).toBe(deckFingerprint({ ...inputs, songs: [{ ...song }] }));
  });

  it('changes when a lyric line, section order or lines-per-slide changes', () => {
    const base = deckFingerprint(inputs);
    expect(deckFingerprint(withSong({ sections: [{ label: 'V1', lines: ['다른 가사'] }] }))).not.toBe(base);
    expect(deckFingerprint(withSong({ order: ['V1', 'C', 'C'] }))).not.toBe(base);
    expect(deckFingerprint(withSong({ linesPerSlide: 2 }))).not.toBe(base);
    expect(deckFingerprint(withSong({ title: '다른 제목' }))).not.toBe(base);
  });

  it('ignores song fields that never reach a slide', () => {
    const base = deckFingerprint(inputs);
    // A reopened deck mints fresh ids for its editing session; that alone is
    // not an edit, or every 편집 would immediately re-upload the same deck.
    expect(deckFingerprint(withSong({ id: 'song-restored' }))).toBe(base);
    expect(deckFingerprint(withSong({ pageIndex: 9 }))).toBe(base);
    expect(deckFingerprint(withSong({ description: '설명 변경' }))).toBe(base);
  });

  it('changes when a song is added or removed', () => {
    expect(deckFingerprint({ ...inputs, songs: [] })).not.toBe(deckFingerprint(inputs));
    expect(deckFingerprint({ ...inputs, songs: [song, { ...song, id: 'song-2' }] })).not.toBe(
      deckFingerprint(inputs),
    );
  });

  it('tracks the file name but not its .pptx suffix or surrounding spaces', () => {
    expect(deckFingerprint({ ...inputs, name: ' 0726 ' })).toBe(deckFingerprint(inputs));
    expect(deckFingerprint({ ...inputs, name: '0802.pptx' })).not.toBe(deckFingerprint(inputs));
  });

  it('changes with the bible, announcement and conti date inputs', () => {
    const base = deckFingerprint(inputs);
    expect(deckFingerprint({ ...inputs, bible: { ...inputs.bible, verseInput: '롬5:1' } })).not.toBe(base);
    expect(deckFingerprint({ ...inputs, bible: { ...inputs.bible, sermonTitle: '다른 제목' } })).not.toBe(base);
    expect(deckFingerprint({ ...inputs, bible: { ...inputs.bible, translations: ['nkrv'] } })).not.toBe(base);
    expect(deckFingerprint({ ...inputs, bible: { ...inputs.bible, versesPerSlide: 1 } })).not.toBe(base);
    expect(deckFingerprint({ ...inputs, announcementText: '1. <다른 광고>\n내용.' })).not.toBe(base);
    expect(deckFingerprint({ ...inputs, contiDate: '8/2/26' })).not.toBe(base);
  });

  it('leaves trailing whitespace out of the announcement and title text', () => {
    expect(deckFingerprint({ ...inputs, announcementText: `${inputs.announcementText}\n` })).toBe(
      deckFingerprint(inputs),
    );
  });

  it('changes when an uploaded or administrator-replaced file changes', () => {
    const base = deckFingerprint(inputs);
    expect(deckFingerprint({ ...inputs, sermonFile: null })).not.toBe(base);
    expect(deckFingerprint({ ...inputs, sermonFile: { name: '다른설교.pptx', data: new ArrayBuffer(2048) } })).not.toBe(base);
    expect(deckFingerprint({ ...inputs, sermonFile: { name: '설교.pptx', data: new ArrayBuffer(64) } })).not.toBe(base);
    expect(deckFingerprint({ ...inputs, contiFile: null })).not.toBe(base);
    expect(deckFingerprint({ ...inputs, bibleTemplate: { name: 't.pptx', data: new ArrayBuffer(16) } })).not.toBe(base);
    expect(deckFingerprint({ ...inputs, frontDeck: { name: 'front.pptx', data: new ArrayBuffer(16) } })).not.toBe(base);
    expect(deckFingerprint({ ...inputs, backDeck: { name: 'back.pptx', data: new ArrayBuffer(16) } })).not.toBe(base);
  });

  it('treats a re-uploaded identical file as unchanged', () => {
    // Name and size identify an upload; re-reading the same .pptx must not
    // trigger a rebuild of a deck that would come out byte-identical.
    expect(deckFingerprint({ ...inputs, sermonFile: { name: '설교.pptx', data: new ArrayBuffer(2048) } })).toBe(
      deckFingerprint(inputs),
    );
  });

  it('changes when a post-End file is added, removed, or reordered', () => {
    const base = deckFingerprint(inputs);
    expect(deckFingerprint({ ...inputs, additionalFiles: inputs.additionalFiles.slice(0, 1) })).not.toBe(base);
    expect(deckFingerprint({ ...inputs, additionalFiles: [...inputs.additionalFiles].reverse() })).not.toBe(base);
    expect(
      deckFingerprint({
        ...inputs,
        additionalFiles: [
          inputs.additionalFiles[0],
          { name: '다른자료.pptx', data: new ArrayBuffer(512) },
        ],
      }),
    ).not.toBe(base);
  });
});

describe('auto-save status line', () => {
  it('names every state', () => {
    expect(autoSaveLabel({ state: 'idle' })).toContain('자동 저장');
    expect(autoSaveLabel({ state: 'pending' })).toContain('대기');
    expect(autoSaveLabel({ state: 'saving' })).toContain('저장 중');
    expect(autoSaveLabel({ state: 'error', message: '서버 오류' })).toContain('서버 오류');
  });

  it('shows the save time, and flags an entry still waiting on the server', () => {
    const at = new Date('2026-07-26T12:34:00Z').toISOString();
    expect(autoSaveLabel({ state: 'saved', at, syncPending: false })).toMatch(/자동 저장됨$/);
    expect(autoSaveLabel({ state: 'saved', at, syncPending: true })).toContain('동기화');
  });
});
