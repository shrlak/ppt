// Reads the worship team's KakaoTalk notice and makes its song list final.
//
// The notice is where the leader confirms the week: the 찬양곡 in the order
// they will be sung, under the names the team uses, each with its key, and
// the 공동체 고백 apart from them. The conti PDF may still carry an older
// title (`주 신실하심 놀라워` for `주님의 은혜 넘치네`), a typo, or a song the
// team dropped. So when both are given, the notice decides WHICH songs, in
// WHAT order, under WHAT names and keys — and the conti supplies what only
// it has: each song's 악보 page, its commentary and its 진행 순서.
//
// 🌱2026년 10월 04일 주일예배🌱
// 📖 본문: 로마서 8장 31-39절
// 📖 주제: 끝까지 흔들리지 않을 이유
// 🎶찬양곡:
// 1️⃣ 주님의 은혜 넘치네 (G)
// 2️⃣ 그 사랑 (G)
// 🤝공동체 고백:
// 🎵 우리는 주의 움직이는 교회 (G)
import type { ContiSongEntry } from './types';
import { normalizeTitle } from '../storage/library';
import { isTitleSlip } from './contiAlignment';
import { normalizeKeyChain } from './contiText';

export interface AnnouncedSong {
  title: string;
  key?: string;
}

export interface WorshipAnnouncement {
  /** Service date, written the way a conti cover writes it: `2026.10.04`. */
  date?: string;
  scripture?: string;
  /** The 주제 / 설교 제목 line. */
  theme?: string;
  /** The 찬양곡, in the order they are sung. */
  songs: AnnouncedSong[];
  /** The 공동체 고백 song, which the back slides carry. */
  confession?: AnnouncedSong;
}

/** Emoji, keycaps and their joiners — the notice's decoration, never content. */
const DECORATION = /[\p{Extended_Pictographic}️︎‍⃣]/gu;
/** `1️⃣` `🔟` `1.` `1)` `①` `-` `•` — how a list line is numbered or bulleted. */
const LIST_MARK = /^(?:\d{1,2}\s*️?⃣|\u{1F51F}|[①-⑳]|\d{1,2}\s*[.)](?!\d)|[-•·*▪◦]\s)\s*/u;
/** `🎶찬양곡:` `📖 본문: 로마서 …` — a labeled line: a short label, a colon, maybe a value. */
const LABELED = /^([^:：]{1,14})[:：]\s*(.*)$/;
const SONG_LIST_LABEL = /찬양\s*곡|찬양\s*순서|곡\s*순서|찬양\s*리스트|셋\s*리스트|콘티|set\s*list/i;
const CONFESSION_LABEL = /공동체\s*고백/;
const SCRIPTURE_LABEL = /^(?:본문|말씀)$/;
const THEME_LABEL = /^(?:주제|설교\s*제목|말씀\s*제목|제목)$/;
const KOREAN_DATE = /(\d{4})\s*년\s*(\d{1,2})\s*월\s*(\d{1,2})\s*일/;
const ISO_DATE = /\b(\d{4})\s*[./-]\s*(\d{1,2})\s*[./-]\s*(\d{1,2})\b/;

function undecorated(line: string): string {
  return line.replace(DECORATION, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * One song as a notice writes it: `주님의 은혜 넘치네 (G)`, `그 사랑 - G`,
 * `우리가 넉넉히 이기느니라 [A]`, `임재 (F -> G)`, or a bare title.
 */
export function parseAnnouncedSong(raw: string): AnnouncedSong | null {
  const line = raw.replace(LIST_MARK, '');
  const text = undecorated(line).replace(LIST_MARK, '');
  if (!/\p{L}/u.test(text)) return null;
  const bracketed = /^(.*?)\s*[(（[]\s*([^)）\]]{1,24})\s*[)）\]]\s*$/.exec(text);
  if (bracketed) {
    const key = normalizeKeyChain(bracketed[2]);
    if (key && bracketed[1].trim()) return { title: bracketed[1].trim(), key };
  }
  const dashed = /^(.*?)\s+[-–—|/]\s*(\S.*)$/.exec(text);
  if (dashed) {
    const key = normalizeKeyChain(dashed[2]);
    if (key && dashed[1].trim()) return { title: dashed[1].trim(), key };
  }
  return { title: text };
}

/**
 * Read a worship notice. Returns null when it lists no 찬양곡 — a notice
 * without its song list has nothing to decide.
 */
export function parseWorshipAnnouncement(text: string): WorshipAnnouncement | null {
  const result: WorshipAnnouncement = { songs: [] };
  let section: 'songs' | 'confession' | 'other' | null = null;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = undecorated(rawLine);
    if (!line) continue;

    if (!result.date) {
      const date = KOREAN_DATE.exec(line) ?? ISO_DATE.exec(line);
      if (date) {
        result.date = `${date[1]}.${date[2].padStart(2, '0')}.${date[3].padStart(2, '0')}`;
        if (section === null) continue;
      }
    }

    // A numbered or bulleted line is a list entry even if a title holds a colon.
    const listed = LIST_MARK.test(rawLine.trim()) || LIST_MARK.test(line);
    // `찬양 순서` / `공동체 고백` on a line of their own head a section too.
    if (!listed && line.length <= 14 && !/[()（）[\]]/.test(line)) {
      if (CONFESSION_LABEL.test(line)) {
        section = 'confession';
        continue;
      }
      if (SONG_LIST_LABEL.test(line)) {
        section = 'songs';
        continue;
      }
    }
    const labeled = listed ? null : LABELED.exec(line);
    if (labeled && !/https?$/i.test(labeled[1])) {
      const label = labeled[1].trim();
      const value = labeled[2].trim();
      if (CONFESSION_LABEL.test(label)) {
        section = 'confession';
        const song = value ? parseAnnouncedSong(value) : null;
        if (song) result.confession ??= song;
      } else if (SONG_LIST_LABEL.test(label)) {
        section = 'songs';
        // `찬양곡: 그 사랑, 임재` — the list on the label's own line.
        for (const part of value ? value.split(/\s*[,，、]\s*/) : []) {
          const song = parseAnnouncedSong(part);
          if (song) result.songs.push(song);
        }
      } else {
        section = 'other';
        if (SCRIPTURE_LABEL.test(label) && value) result.scripture ??= value;
        if (THEME_LABEL.test(label) && value) result.theme ??= value;
      }
      continue;
    }

    if (section === 'songs') {
      const song = parseAnnouncedSong(rawLine.trim());
      if (song) result.songs.push(song);
    } else if (section === 'confession' && !result.confession) {
      const song = parseAnnouncedSong(rawLine.trim());
      if (song) result.confession = song;
    }
  }

  return result.songs.length > 0 ? result : null;
}

/** Same song: the same title, or the same title with a letter or two slipped. */
function sameTitle(a: string, b: string): boolean {
  return normalizeTitle(a) === normalizeTitle(b) || isTitleSlip(a, b);
}

/** Keys that cannot tell two songs apart: equal, or one of them unknown. */
function keysAgree(a: string | undefined, b: string | undefined): boolean {
  return !a || !b || a === b;
}

export interface AnnouncementMatch<T> {
  /** Every announced song in order, with the item it was found as, if any. */
  pairs: { announced: AnnouncedSong; item?: T }[];
  /** Items the notice does not list. */
  dropped: T[];
}

/**
 * Pair the notice's songs with what the conti (or the song cards) already has.
 *
 * By title first — exactly, or with a letter slipped. When as many songs
 * are left on each side, they are the same songs under other names, and are
 * paired in order where the keys agree: the conti calling the first song
 * `주 신실하심 놀라워 (G)` while the notice calls it `주님의 은혜 넘치네 (G)`.
 * Otherwise the leftovers are songs the notice added and the conti's it
 * dropped — pairing those would hand a new song another song's notes.
 */
export function matchAnnouncement<T extends { title: string; key?: string }>(
  items: T[],
  announced: AnnouncedSong[],
): AnnouncementMatch<T> {
  const used = new Set<T>();
  const pairs: { announced: AnnouncedSong; item?: T }[] = announced.map((song) => ({ announced: song }));

  for (const pair of pairs) {
    const exact = items.find((item) => !used.has(item) && normalizeTitle(item.title) === normalizeTitle(pair.announced.title));
    if (exact) {
      pair.item = exact;
      used.add(exact);
    }
  }
  for (const pair of pairs) {
    if (pair.item) continue;
    const slip = items.find((item) => !used.has(item) && sameTitle(item.title, pair.announced.title));
    if (slip) {
      pair.item = slip;
      used.add(slip);
    }
  }
  const leftover = items.filter((item) => !used.has(item));
  const unpaired = pairs.filter((pair) => !pair.item);
  if (leftover.length === unpaired.length) {
    unpaired.forEach((pair, index) => {
      if (!keysAgree(leftover[index].key, pair.announced.key)) return;
      pair.item = leftover[index];
      used.add(leftover[index]);
    });
  }

  return { pairs, dropped: items.filter((item) => !used.has(item)) };
}

/** True when an entry is the notice's 공동체 고백 song. */
export function isAnnouncedConfession(title: string, announcement: WorshipAnnouncement): boolean {
  return !!announcement.confession && sameTitle(title, announcement.confession.title);
}

/**
 * The conti's song list made final by the notice: the notice's songs, order,
 * names and keys; each one's 악보 page, commentary and 진행 from the conti
 * entry it was found as. A song only the notice lists takes the next page no
 * listed song holds (the title pass moves it if that is not its page).
 */
export function applyAnnouncementToEntries(
  entries: ContiSongEntry[],
  announcement: WorshipAnnouncement,
  musicPages: number[],
): NoticeOutcome<ContiSongEntry> & { entries: ContiSongEntry[] } {
  const listed = entries.filter((entry) => !isAnnouncedConfession(entry.title, announcement));
  const { pairs, dropped } = matchAnnouncement(listed, announcement.songs);
  const held = new Set(
    pairs.map((pair) => pair.item?.pageIndex).filter((page): page is number => page != null),
  );
  const free = musicPages.filter((page) => !held.has(page));
  const final = pairs.map(({ announced, item }): ContiSongEntry => {
    if (item) return { ...item, title: announced.title, key: announced.key ?? item.key };
    const pageIndex = free.shift();
    return { title: announced.title, ...(announced.key ? { key: announced.key } : {}), ...(pageIndex != null ? { pageIndex } : {}) };
  });
  return { entries: final, ...noticeOutcome(pairs, dropped) };
}

/** What making a list final by the notice changed, for telling the user. */
export interface NoticeOutcome<T> {
  /** Songs the notice calls by another name than the conti did. */
  renamed: { from: string; to: string }[];
  /** Songs only the notice lists. */
  added: string[];
  /** What the notice does not list. */
  dropped: T[];
}

export function noticeOutcome<T extends { title: string }>(
  pairs: { announced: AnnouncedSong; item?: T }[],
  dropped: T[],
): NoticeOutcome<T> {
  return {
    renamed: pairs
      .filter(({ announced, item }) => item && normalizeTitle(item.title) !== normalizeTitle(announced.title))
      .map(({ announced, item }) => ({ from: (item as T).title, to: announced.title })),
    added: pairs.filter(({ item }) => !item).map(({ announced }) => announced.title),
    dropped,
  };
}
