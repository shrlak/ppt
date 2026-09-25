// Reads a 수련회 찬양 콘티's song table.
//
// The conti's first page is one table: a column per part of the retreat
// (금요일 오후 예배, 금요일 오후 기도회, 토요일 오전 특강, … 주일 예배), each
// holding a numbered song list. The PDF's text comes out column by column —
// every header first, then each column's list — with long titles wrapped
// onto a second line ("1. 주 안에서" / "기뻐해*"). A list starting again at 1
// is the next column.
import type { ContiSlotKey } from './types';

export interface ContiSlot {
  /** The column's header, e.g. "금요일 오후 예배 (20m, 4곡)". */
  label: string;
  /** Which part of the retreat it is, when the header says. */
  key?: ContiSlotKey;
  songs: string[];
}

const DAY_LINE = /^(금요일|토요일|주일|일요일)/;
const NUMBERED = /^(\d{1,2})\s*[.)]\s*(.*)$/;
/** "X 주품에" — a song struck from the set. */
const STRUCK = /^[xX✕×]\s+/;

export function slotKey(label: string): ContiSlotKey | undefined {
  const day = /^금요일/.test(label) ? '금' : /^토요일/.test(label) ? '토' : /^(주일|일요일)/.test(label) ? '주일' : null;
  if (!day) return undefined;
  const part = /찬양\s*집회/.test(label)
    ? '찬양집회'
    : /기도회/.test(label)
      ? '기도회'
      : /특강/.test(label)
        ? '특강'
        : '예배';
  return { day, part };
}

/** Title as sung: markers (*, ***) and spacing dropped. */
function cleanTitle(value: string): string {
  return value.replace(/\*+/g, '').replace(/\s+/g, ' ').trim();
}

export function parseRetreatConti(text: string): ContiSlot[] {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const firstItem = lines.findIndex((line) => NUMBERED.test(line));
  if (firstItem < 0) return [];

  // Headers: a day word opens one, the lines after it complete it.
  const labels: string[] = [];
  for (const line of lines.slice(0, firstItem)) {
    if (DAY_LINE.test(line)) labels.push(line);
    else if (labels.length > 0) labels[labels.length - 1] += ` ${line}`;
  }

  // Lists: a "1." after any item starts the next column.
  const groups: string[][] = [];
  let lastNumber = 0;
  for (const line of lines.slice(firstItem)) {
    const numbered = line.match(NUMBERED);
    if (numbered) {
      const n = Number(numbered[1]);
      if (groups.length === 0 || n <= lastNumber) groups.push([]);
      groups[groups.length - 1].push(numbered[2]);
      lastNumber = n;
    } else if (groups.length > 0) {
      const group = groups[groups.length - 1];
      if (group.length > 0) group[group.length - 1] += ` ${line}`;
    }
  }

  return groups.map((items, index) => {
    const label = (labels[index] ?? `${index + 1}번째 목록`).replace(/\s+/g, ' ').trim();
    const key = slotKey(label);
    return {
      label,
      ...(key ? { key } : {}),
      songs: items
        .map((item) => item.trim())
        .filter((item) => !STRUCK.test(item))
        .map(cleanTitle)
        .filter(Boolean),
    };
  });
}
