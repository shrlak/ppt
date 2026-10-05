import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  addPrayer,
  applyPrayerFlags,
  checkedSongIds,
  createPrayer,
  movePrayerSlide,
  placePrayers,
  prayerHasContent,
  releaseRemovedSongs,
  removePrayer,
  setPrayerAfter,
  topicLines,
  withPrayerPerCheckedSong,
  type PrayerState,
} from '../../src/praise/prayers';
import { parsePraisePassage, passageRanges, resolvePraisePassage, type BibleLoader } from '../../src/praise/scripture';
import { planPraiseDeck } from '../../src/praise/planner';
import type { BookChapters } from '../../src/bible/types';
import type { Song } from '../../src/lib/utils/types';
import type { PraisePrayer } from '../../src/praise/types';

function song(id: string): Song {
  return { id, title: id, sections: [{ label: 'V', lines: [`${id} 가사`] }], order: ['V'], linesPerSlide: 3 };
}

const songs = ['a', 'b', 'c', 'd'].map(song);

/** A 기도 with a topic typed into it, named so the test can follow it. */
function typed(name: string): PraisePrayer {
  const prayer = createPrayer();
  return {
    ...prayer,
    id: name,
    slides: prayer.slides.map((slide) => (slide.kind === 'topics' ? { ...slide, text: `${name} 기도제목` } : slide)),
  };
}

function check(state: PrayerState, ...ids: string[]): PrayerState {
  return ids.reduce((current, id) => setPrayerAfter(songs, current, id, true), state);
}

const empty: PrayerState = { extras: {}, prayers: [] };

/** Which 기도 follows which song: "a:A b:B end:C". */
function pairing(state: PrayerState): string {
  return placePrayers(songs, state.extras, state.prayers)
    .map((placed) => `${placed.afterSongId ?? 'end'}:${placed.prayer.id}`)
    .join(' ');
}

describe('pairing 기도 with the checked songs', () => {
  it('puts 기도 1 after the first checked song, 기도 2 after the second, however the songs were checked', () => {
    // 기도 written ahead of time keep their numbers.
    const state = { extras: {}, prayers: [typed('A'), typed('B')] };
    const checked = check(state, 'c', 'a');
    expect(checkedSongIds(songs, checked.extras)).toEqual(['a', 'c']);
    expect(pairing(checked)).toBe('a:A c:B');
    expect(checked.prayers.every((prayer) => prayer.releasedFrom === undefined)).toBe(true);
  });

  it('brings in a new 기도 / Prayer when a song is checked and none is waiting', () => {
    const state = check(empty, 'b');
    expect(state.prayers).toHaveLength(1);
    expect(state.prayers[0].slides.map((slide) => slide.kind)).toEqual(['topics', 'title']);
    // 기도제목 is headed in both languages, the deck's "한글 | English".
    expect(state.prayers[0].slides[0]).toMatchObject({ heading: '기도제목', headingEn: 'Prayer Prompt' });
    expect(prayerHasContent(state.prayers[0])).toBe(false);
  });

  it('checking a song between two others gives it a 기도 of its own without moving theirs', () => {
    const state = check({ extras: {}, prayers: [typed('A'), typed('C')] }, 'a', 'c');
    const next = setPrayerAfter(songs, state, 'b', true);
    expect(pairing(next)).toMatch(/^a:A b:\S+ c:C$/);
  });

  it('unchecking a song sets its typed 기도 aside, and every other song keeps its own', () => {
    const state = check({ extras: {}, prayers: [typed('A'), typed('B'), typed('C')] }, 'a', 'b', 'c');
    const unchecked = setPrayerAfter(songs, state, 'b', false);
    expect(pairing(unchecked)).toBe('a:A c:C end:B');
    // Checking it again is an undo.
    const again = setPrayerAfter(songs, unchecked, 'b', true);
    expect(pairing(again)).toBe('a:A b:B c:C');
    expect(again.prayers[1].releasedFrom).toBeUndefined();
    // Checking another song instead hands the set-aside 기도 to it.
    expect(pairing(setPrayerAfter(songs, unchecked, 'd', true))).toBe('a:A c:C d:B');
  });

  it('drops a 기도 nothing was typed into when its song is unchecked, so a stray check leaves nothing behind', () => {
    const state = setPrayerAfter(songs, check(empty, 'a'), 'a', false);
    expect(state.prayers).toEqual([]);
    expect(placePrayers(songs, state.extras, state.prayers)).toEqual([]);
  });

  it('adds a 기도 at the end, waiting for a song, and the next checked song takes it', () => {
    const added = addPrayer(check({ extras: {}, prayers: [typed('A')] }, 'a'));
    expect(added.prayers).toHaveLength(2);
    expect(pairing(added)).toMatch(/^a:A end:/);
    const waiting = added.prayers[1].id;
    expect(pairing(setPrayerAfter(songs, added, 'c', true))).toBe(`a:A c:${waiting}`);
  });

  it('removing a 기도 unchecks the song it followed and leaves the rest paired as they were', () => {
    const state = check({ extras: {}, prayers: [typed('A'), typed('B'), typed('C')] }, 'a', 'b', 'c');
    const removed = removePrayer(songs, state, 1);
    expect(checkedSongIds(songs, removed.extras)).toEqual(['a', 'c']);
    expect(pairing(removed)).toBe('a:A c:C');
    // The last 기도, waiting at the end, goes without touching any song.
    const waiting = addPrayer(removed);
    expect(checkedSongIds(songs, removePrayer(songs, waiting, 2).extras)).toEqual(['a', 'c']);
  });

  it('a song taken off the list lets go of its 기도 instead of handing it down the line', () => {
    const state = check({ extras: {}, prayers: [typed('A'), typed('B'), typed('C')] }, 'a', 'b', 'c');
    const remaining = songs.filter((candidate) => candidate.id !== 'b');
    const prayers = releaseRemovedSongs(songs, remaining, state.extras, state.prayers);
    expect(
      placePrayers(remaining, state.extras, prayers).map((placed) => `${placed.afterSongId ?? 'end'}:${placed.prayer.id}`),
    ).toEqual(['a:A', 'c:C', 'end:B']);
  });

  it('gives a checked song from a night saved before 기도 were kept a plain 기도 / Prayer', () => {
    const extras = { a: { english: { title: '', slides: {} }, prayerAfter: true } };
    const prayers = withPrayerPerCheckedSong(songs, extras, []);
    expect(prayers).toHaveLength(1);
    const plans = planPraiseDeck(songs, extras, [], prayers);
    expect(plans.filter((plan) => plan.kind === 'prayer')).toEqual([
      expect.objectContaining({ ko: '기도', en: 'Prayer', afterSongId: 'a', prayerNumber: 1 }),
    ]);
  });

  it('takes only the check marks from a newer copy, never anything else', () => {
    const target = { a: { english: { title: 'Arrived since', slides: {} } } };
    const source = { a: { english: { title: '', slides: {} }, prayerAfter: true as const } };
    expect(applyPrayerFlags(target, source)).toEqual({ a: { english: { title: 'Arrived since', slides: {} }, prayerAfter: true } });
    expect(applyPrayerFlags(source, source)).toBe(source);
  });
});

describe('a 기도’s slides', () => {
  it('reads topics one to a line, dropping blank lines and typed bullets', () => {
    expect(topicLines('- 첫째\n\n• 둘째 \n  셋째\r\n1. 넷째')).toEqual(['첫째', '둘째', '셋째', '1. 넷째']);
  });

  it('moves a slide within its 기도', () => {
    const prayer = createPrayer();
    const [topics, title] = prayer.slides;
    expect(movePrayerSlide(prayer, title.id, -1).slides).toEqual([title, topics]);
    expect(movePrayerSlide(prayer, title.id, 1)).toBe(prayer);
  });

  it('lays the night out: songs, then each 기도’s slides in its own order, then a waiting 기도 at the end', () => {
    const first: PraisePrayer = {
      id: 'first',
      slides: [
        { id: 't', kind: 'topics', heading: '기도제목', headingEn: 'Prayer Prompt', text: '하나\n둘' },
        {
          id: 's',
          kind: 'scripture',
          reference: '행1:8',
          passage: { rangeKo: '사도행전 1장 8절', rangeEn: 'Acts 1:8', verses: [{ refKo: '사도행전 1장 8절', refEn: 'Acts 1:8', ko: '오직', en: 'but' }] },
        },
        { id: 'p', kind: 'title', ko: '통성기도', en: 'Corporate Prayer' },
        // Nothing typed: no slide.
        { id: 'e', kind: 'topics', heading: '기도제목', headingEn: 'Prayer Prompt', text: '  ' },
      ],
    };
    const extras = { b: { english: { title: '', slides: {} }, prayerAfter: true } };
    const plans = planPraiseDeck(songs, extras, [{ fileId: 'closing', placement: 'end' }], [first, typed('W')]);
    const kinds = plans.map((plan) => (plan.kind === 'additional' ? `file:${plan.fileId}` : plan.kind));
    expect(kinds).toEqual([
      'cover',
      'title', 'lyrics',
      'title', 'lyrics', 'prayer-topics', 'scripture', 'prayer',
      'title', 'lyrics',
      'title', 'lyrics',
      'prayer-topics', 'prayer',
      'file:closing',
    ]);
    expect(plans[5]).toMatchObject({
      kind: 'prayer-topics',
      heading: '기도제목 | Prayer Prompt',
      topics: ['하나', '둘'],
      afterSongId: 'b',
      prayerNumber: 1,
    });
    expect(plans[12]).toMatchObject({ kind: 'prayer-topics', afterSongId: null, prayerNumber: 2 });
  });
});

const root = join(__dirname, '..', '..');
const loadBible: BibleLoader = async (translation) => {
  const file = translation === 'nkrv' ? 'ko_nkrv.json' : 'en_nasb.json';
  expect(['nkrv', 'nasb']).toContain(translation);
  const raw = JSON.parse(readFileSync(join(root, 'public', 'bible-text', file), 'utf8')) as { chapters: BookChapters }[];
  return new Map(raw.map((book, index) => [index + 1, book.chapters]));
};

describe('말씀 passages', () => {
  it('reads a passage typed the Korean way, the short way or the English way', () => {
    const spans = (input: string) =>
      parsePraisePassage(input).refs.map((ref) => `${ref.bookId}:${ref.startChapter}:${ref.startVerse}-${ref.endChapter}:${ref.endVerse}`);
    const acts = ['44:1:3-1:5', '44:1:8-1:8'];
    expect(spans('사도행전 1장 3-5, 8절')).toEqual(acts);
    expect(spans('행1:3-5,8')).toEqual(acts);
    expect(spans('Acts 1:3-5, 8')).toEqual(acts);
    expect(spans('1 John 4:8')).toEqual(['62:4:8-4:8']);
    expect(spans('시편 23편')).toEqual(['19:1:undefined-1:undefined'.replace('1:undefined-1', '23:undefined-23')]);
    // A book alone is not a passage.
    expect(parsePraisePassage('사도행전')).toEqual({ refs: [], invalidTokens: ['행'] });
  });

  it('spells the whole passage the way last year’s 말씀 slides did', () => {
    const { refs } = parsePraisePassage('행1:3-5,8 2:1-4 롬8:28');
    const verse = (chapter: number, n: number) => ({ chapter, verse: n, text: '' });
    const ranges = passageRanges([
      { ref: refs[0], first: verse(1, 3), last: verse(1, 5) },
      { ref: refs[1], first: verse(1, 8), last: verse(1, 8) },
      { ref: refs[2], first: verse(2, 1), last: verse(2, 4) },
      { ref: refs[3], first: verse(8, 28), last: verse(8, 28) },
    ]);
    expect(ranges).toEqual({
      ko: '사도행전 1장 3-5, 8절, 2장 1-4절, 로마서 8장 28절',
      en: 'Acts 1:3-5, 8; 2:1-4; Romans 8:28',
    });
  });

  it('reads each verse in 개역개정 and NASB, one slide a verse', async () => {
    const passage = (await resolvePraisePassage('사도행전 1장 3-5, 8절', loadBible))!;
    expect(passage.rangeKo).toBe('사도행전 1장 3-5, 8절');
    expect(passage.rangeEn).toBe('Acts 1:3-5, 8');
    expect(passage.verses.map((verse) => `${verse.refKo} / ${verse.refEn}`)).toEqual([
      '사도행전 1장 3절 / Acts 1:3',
      '사도행전 1장 4절 / Acts 1:4',
      '사도행전 1장 5절 / Acts 1:5',
      '사도행전 1장 8절 / Acts 1:8',
    ]);
    expect(passage.verses[0].ko).toMatch(/^그가 고난 받으신 후에/);
    expect(passage.verses[0].en).toMatch(/^To these He also presented Himself alive/);
  });

  it('keeps a pair of verses 개역개정 prints as one together, with the English of both', async () => {
    const passage = (await resolvePraisePassage('신6:18', loadBible))!;
    expect(passage.verses).toHaveLength(1);
    expect(passage.verses[0].refKo).toBe('신명기 6장 18-19절');
    expect(passage.verses[0].refEn).toBe('Deuteronomy 6:18-19');
    expect(passage.verses[0].en).toMatch(/^You shall do what is right and good/);
    expect(passage.verses[0].en).toMatch(/as the Lord has spoken\.?$/);
  });

  it('counts 시편 in 편 and refuses a passage too long to project', async () => {
    const psalm = (await resolvePraisePassage('시23:1', loadBible))!;
    expect(psalm.verses[0].refKo).toBe('시편 23편 1절');
    expect(psalm.rangeEn).toBe('Psalms 23:1');
    await expect(resolvePraisePassage('시119', loadBible)).rejects.toThrow(/너무 깁니다/);
    expect(await resolvePraisePassage('아무거나', loadBible)).toBeNull();
  });
});
