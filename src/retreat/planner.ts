// Plans one 수련회 session's deck: which of the template's designs each slide
// uses and what it says. Pure, so the download, the slide count and the
// on-screen preview read the same plan.
import { parseAnnouncements } from '../lib/utils/announcementBuilder';
import type { RetreatPassage } from './scripture';
import { lyricSlides } from './songs';
import type { RetreatInfo, RetreatSession } from './types';

export type RetreatSlidePlan =
  | { kind: 'cover' }
  | { kind: 'title' }
  | { kind: 'section'; label: string }
  | { kind: 'songTitle'; title: string; songId: string }
  | { kind: 'lyrics'; title: string; lines: string[]; songId: string }
  | { kind: 'passage'; passageKo: string }
  | { kind: 'verse'; passageKo: string; passageEn: string; verseNo: string; ko: string; en: string }
  | { kind: 'sermon'; title: string }
  | { kind: 'blank' }
  | { kind: 'prayer'; label: string }
  | { kind: 'benediction'; label: string }
  | { kind: 'announcementDivider'; label: string }
  | { kind: 'announcement'; title: string; lines: string[] };

/**
 * Every slide of a session, in order. `passages` holds each scripture
 * block's resolved verses (by block id); a block not resolved yet still
 * gets its 설교말씀 divider, so the deck's shape never depends on a download.
 */
export function planRetreatSession(
  session: RetreatSession,
  passages: Record<string, RetreatPassage | null | undefined> = {},
): RetreatSlidePlan[] {
  const plans: RetreatSlidePlan[] = [];
  if (session.poster) plans.push({ kind: 'cover' });
  for (const block of session.blocks) {
    switch (block.kind) {
      case 'title':
        plans.push({ kind: 'title' });
        break;
      case 'songs':
        if (block.label.trim()) plans.push({ kind: 'section', label: block.label.trim() });
        for (const song of block.songs) {
          const title = song.title.trim();
          if (!title) continue;
          plans.push({ kind: 'songTitle', title, songId: song.id });
          for (const lines of lyricSlides(song.lyrics)) plans.push({ kind: 'lyrics', title, lines, songId: song.id });
        }
        break;
      case 'scripture': {
        const passage = passages[block.id];
        if (!block.passage.trim()) break;
        plans.push({ kind: 'passage', passageKo: passage?.passageKo ?? block.passage.trim() });
        for (const verse of passage?.verses ?? []) {
          plans.push({
            kind: 'verse',
            passageKo: passage!.passageKo,
            passageEn: passage!.passageEn,
            verseNo: String(verse.verse),
            ko: verse.ko,
            en: verse.en ? `${verse.verse} ${verse.en}` : '',
          });
        }
        break;
      }
      case 'sermon':
        plans.push({ kind: 'sermon', title: block.title.trim() });
        break;
      case 'blank':
        plans.push({ kind: 'blank' });
        break;
      case 'prayer':
        plans.push({ kind: 'prayer', label: block.label.trim() || '기도' });
        break;
      case 'benediction':
        plans.push({ kind: 'benediction', label: block.label.trim() || '축도' });
        break;
      case 'announcements': {
        plans.push({ kind: 'announcementDivider', label: block.label.trim() || '광고' });
        const items = parseRetreatAnnouncements(block.text);
        items.forEach((item, index) =>
          plans.push({
            kind: 'announcement',
            title: `${index + 1}. <${item.title.trim()}>`,
            lines: item.bodyLines.filter((line) => line.trim()),
          }),
        );
        break;
      }
    }
  }
  return plans;
}

/**
 * 광고 text as the Sunday 광고 step takes it ("1. <제목>" and its lines), or
 * just "1. 제목" — the brackets are printed on the slide either way.
 */
export function parseRetreatAnnouncements(text: string): { title: string; bodyLines: string[] }[] {
  if (!text.trim()) return [];
  const bracketed = parseAnnouncements(text);
  if (bracketed.length > 0) return bracketed;
  const items: { title: string; bodyLines: string[] }[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const numbered = line.match(/^\d+\s*[.)]\s*(.+)$/);
    if (numbered) items.push({ title: numbered[1].trim(), bodyLines: [] });
    else if (line && items.length > 0) items[items.length - 1].bodyLines.push(line);
  }
  return items;
}

/** The title slide's two runs: “2026 + 빛주사랑 겨울 수련회”. */
export function titleLines(info: RetreatInfo): [string, string] {
  const title = info.title.trim();
  const match = title.match(/^(\S+)\s+(.+)$/);
  if (!match) return [`“${title}”`, ''];
  return [`“${match[1]}`, ` ${match[2]}”`];
}

/** Sermon titles are printed in quotes, as the retreat decks did. */
export function quotedSermonTitle(title: string): string {
  const trimmed = title.trim();
  if (!trimmed) return '';
  return /^[“"]/.test(trimmed) ? trimmed : `“${trimmed}”`;
}

/** "2027-01-15" + "금요일 저녁예배" → "0115_Retreat_Evening.pptx" (ASCII, see praise). */
export function suggestRetreatFileName(session: RetreatSession, index: number, today = new Date()): string {
  const match = session.date.trim().match(/^\d{4}-(\d{1,2})-(\d{1,2})$/);
  const month = match ? match[1].padStart(2, '0') : String(today.getMonth() + 1).padStart(2, '0');
  const day = match ? match[2].padStart(2, '0') : String(today.getDate()).padStart(2, '0');
  const part = /특강/.test(session.name)
    ? 'Lecture'
    : /폐회/.test(session.name)
      ? 'Closing'
      : /저녁|예배|집회/.test(session.name)
        ? 'Evening'
        : `Session${index + 1}`;
  return `${month}${day}_Retreat_${part}.pptx`;
}
