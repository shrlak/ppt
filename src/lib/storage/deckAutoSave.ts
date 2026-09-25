// Change detection for auto-saving the current deck into the PPT 라이브러리.
// Every edit to what the entry stores is saved, however small; the
// fingerprint below only keeps an unchanged deck from being uploaded again. Kept apart from pptLibrary.ts so it
// stays free of browser storage APIs and can be unit tested directly.
import type { Song } from '../utils/types';
import type { DeckSourceBible } from './deckSource';

/**
 * Idle time after the last edit before the deck is auto-saved. Long enough
 * that typing a lyric line or an announcement is one save rather than one per
 * keystroke, and comfortably longer than the 편집기 thumbnail debounce so the
 * two rebuilds don't stack up on every pause.
 */
export const AUTO_SAVE_DEBOUNCE_MS = 4000;

/** How long a failed auto-save waits before the same inputs are retried. */
export const AUTO_SAVE_RETRY_MS = 30_000;

/** Re-check interval while another save (manual or auto) is still running. */
export const AUTO_SAVE_BUSY_POLL_MS = 800;

export interface AutoSaveFile {
  name: string;
  data: ArrayBuffer;
}

/** Everything that feeds buildMergedDeck(), plus the name it is saved under. */
export interface AutoSaveInputs {
  name: string;
  contiDate?: string;
  songs: Song[];
  bible: DeckSourceBible;
  /** A per-session 성경 template override still changes the built deck. */
  bibleTemplate: AutoSaveFile | null;
  announcementText: string;
  sermonFile: AutoSaveFile | null;
  contiFile: AutoSaveFile | null;
  /** Ordered raw files appended after Back/End. Order changes the generated deck. */
  additionalFiles: AutoSaveFile[];
  /** 관리자 설정 replacements for the bundled front/back decks. */
  frontDeck: AutoSaveFile | null;
  backDeck: AutoSaveFile | null;
  /** 관리자 설정's 공동체 고백송 — it rewrites a block of the back deck. */
  confessionSong?: string;
}

/**
 * Binary inputs are identified by name and size rather than hashed: the files
 * here are whole .pptx/.pdf uploads, and a replacement that matches both is
 * not worth the megabytes of hashing on every keystroke.
 */
function fileKey(file: AutoSaveFile | null): string | null {
  return file ? `${file.name}:${file.data.byteLength}` : null;
}

function songKey(song: Song) {
  // Everything the deck archives for the song, down to its key, description
  // and score page — any change is an edit worth saving. Only `id` is left
  // out: a restored deck mints fresh song ids for the editing session, and
  // that alone must not count as an edit.
  return {
    title: song.title,
    key: song.key ?? null,
    description: song.description ?? null,
    sections: song.sections.map((section) => ({ label: section.label, lines: section.lines })),
    order: song.order,
    linesPerSlide: song.linesPerSlide,
    pageIndex: song.pageIndex ?? null,
    // 설교 후 찬양 moves the song's slides to a different point in the deck.
    postSermon: !!song.postSermon,
  };
}

/**
 * A stable string that changes whenever anything the 라이브러리 entry holds
 * changes — however small the edit. Auto-save compares it against the last
 * saved one and skips the rebuild only when they match, so reopening a saved
 * deck, switching views, or retyping the same text never re-uploads an
 * identical entry.
 */
export function deckFingerprint(inputs: AutoSaveInputs): string {
  return JSON.stringify({
    name: inputs.name.trim().replace(/\.pptx$/i, ''),
    contiDate: inputs.contiDate ?? null,
    songs: inputs.songs.map(songKey),
    bible: {
      verseInput: inputs.bible.verseInput,
      sermonTitle: inputs.bible.sermonTitle,
      translations: inputs.bible.translations,
      versesPerSlide: inputs.bible.versesPerSlide,
      template: fileKey(inputs.bibleTemplate),
    },
    announcementText: inputs.announcementText,
    sermon: fileKey(inputs.sermonFile),
    conti: fileKey(inputs.contiFile),
    additional: inputs.additionalFiles.map((file) => fileKey(file)),
    front: fileKey(inputs.frontDeck),
    back: fileKey(inputs.backDeck),
    confessionSong: (inputs.confessionSong ?? '').trim(),
  });
}

export type AutoSaveStatus =
  | { state: 'idle' }
  | { state: 'pending' }
  | { state: 'saving' }
  | { state: 'saved'; at: string; syncPending: boolean }
  | { state: 'error'; message: string };

/** Status line shown next to the manual 저장 buttons. */
export function autoSaveLabel(status: AutoSaveStatus): string {
  switch (status.state) {
    case 'idle':
      return '자동 저장 켜짐 · 수정하면 라이브러리에 저장됩니다';
    case 'pending':
      return '자동 저장 대기 중…';
    case 'saving':
      return '자동 저장 중…';
    case 'saved': {
      const time = new Date(status.at).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
      return status.syncPending
        ? `${time} 자동 저장됨 · 서버 연결 시 다른 기기에도 동기화됩니다`
        : `${time} 자동 저장됨`;
    }
    case 'error':
      return `자동 저장 실패: ${status.message}`;
  }
}
