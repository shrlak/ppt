// Pure updates to the retreat's state: putting a conti's song lists into the
// sessions' songs blocks.
import { normalizeTitle } from '../lib/storage/library';
import type { ContiSlot } from './conti';
import type { ContiSlotKey, RetreatSong, RetreatState } from './types';

export interface ContiApplyResult {
  state: RetreatState;
  /** Column → where it went, for the summary shown after an upload. */
  placed: { label: string; target: string; count: number }[];
  /** Columns no block asked for. */
  unplaced: string[];
}

function sameSlot(a: ContiSlotKey | undefined, b: ContiSlotKey | undefined): boolean {
  return Boolean(a && b && a.day === b.day && a.part === b.part);
}

/**
 * Fill each songs block from the conti column its slot names. A song the
 * block already had (same title) keeps its lyrics as they were edited; new
 * titles are looked up with `resolve`. The 주일 column is the closing Sunday
 * service's, kept as a list for the 주일예배 generator.
 */
export function applyConti(
  state: RetreatState,
  slots: ContiSlot[],
  resolve: (title: string) => RetreatSong,
): ContiApplyResult {
  const placed: ContiApplyResult['placed'] = [];
  const unplaced: string[] = [];
  let closingSongs = state.closingSongs;
  let sessions = state.sessions;

  for (const slot of slots) {
    if (slot.key?.day === '주일') {
      closingSongs = slot.songs;
      placed.push({ label: slot.label, target: '주일 폐회예배 (주일예배 생성기)', count: slot.songs.length });
      continue;
    }
    let found = false;
    sessions = sessions.map((session) => ({
      ...session,
      blocks: session.blocks.map((block) => {
        if (found || block.kind !== 'songs' || !sameSlot(block.slot, slot.key)) return block;
        found = true;
        const existing = new Map(block.songs.map((song) => [normalizeTitle(song.title), song]));
        placed.push({ label: slot.label, target: `${session.name} · ${block.label}`, count: slot.songs.length });
        return { ...block, songs: slot.songs.map((title) => existing.get(normalizeTitle(title)) ?? resolve(title)) };
      }),
    }));
    if (!found) unplaced.push(slot.label);
  }
  return { state: { ...state, sessions, closingSongs }, placed, unplaced };
}
