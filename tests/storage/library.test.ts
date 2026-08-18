import { describe, expect, it } from 'vitest';
import {
  findEntry,
  mergeLibraries,
  normalizeTitle,
  sanitizeLibraryEntry,
  selectReusableEntry,
  upsertEntry,
} from '../../src/lib/storage/library';
import { sanitizeLyricsEntry } from '../../worker/src/library.js';
import type { LibraryEntry } from '../../src/lib/utils/types';

const entry = (title: string, key = 'C'): LibraryEntry => ({
  title,
  key,
  sections: [{ label: 'C', lines: ['가사'] }],
  order: ['C'],
});

describe('normalizeTitle', () => {
  it('ignores whitespace, punctuation and case', () => {
    expect(normalizeTitle('주님의  사랑!')).toBe(normalizeTitle('주님의 사랑'));
    expect(normalizeTitle('Celebrate The Light')).toBe(normalizeTitle('celebrate the light'));
  });
});

describe('mergeLibraries', () => {
  it('lets user entries override bundled ones', () => {
    const merged = mergeLibraries([entry('주님의 사랑', 'E')], [entry('주님의사랑', 'G')]);
    expect(merged).toHaveLength(1);
    expect(merged[0].key).toBe('G');
  });

  it('keeps distinct entries from both sides', () => {
    const merged = mergeLibraries([entry('A')], [entry('B')]);
    expect(merged.map((e) => e.title).sort()).toEqual(['A', 'B']);
  });
});

describe('findEntry', () => {
  it('never answers with a title that merely resembles the one asked for', () => {
    // "\uc8fc\ub2d8\uc758 \uc0ac\ub791\uc774 \ub098\ub97c" is a different song; loading its
    // words would put lyrics the page never had on the screen.
    const shelf = [entry('\uc8fc\ub2d8\uc758 \uc0ac\ub791\uc774 \ub098\ub97c')];
    expect(findEntry(shelf, '\uc8fc\ub2d8\uc758 \uc0ac\ub791')).toBeUndefined();
    expect(findEntry(shelf, '\uc8fc\ub2d8\uc758 \uc0ac\ub791\uc774 \ub098\ub97c')?.title).toBe(
      '\uc8fc\ub2d8\uc758 \uc0ac\ub791\uc774 \ub098\ub97c',
    );
  });

  it('finds by normalized title', () => {
    expect(findEntry([entry('주님의 사랑')], '주님의사랑')?.title).toBe('주님의 사랑');
    expect(findEntry([entry('주님의 사랑')], '없는 곡')).toBeUndefined();
    expect(findEntry([entry('주님의 사랑')], '')).toBeUndefined();
  });
});

describe('upsertEntry', () => {
  it('replaces an existing entry by title', () => {
    const next = upsertEntry([entry('A', 'C')], entry('A', 'D'));
    expect(next).toHaveLength(1);
    expect(next[0].key).toBe('D');
  });

  it('appends new entries', () => {
    const next = upsertEntry([entry('A')], entry('B'));
    expect(next.map((e) => e.title)).toEqual(['A', 'B']);
  });
});

describe('sanitizeLibraryEntry', () => {
  it('migrates legacy entries to verified and never lets a draft hide a verified entry', () => {
    const legacy = entry('은혜의 노래');
    const draft = { ...entry('은혜의 노래'), verification: 'draft' as const, version: 2 };
    const migrated = sanitizeLibraryEntry(legacy)!;
    expect(migrated.verification).toBe('verified');
    expect(migrated.version).toBe(1);
    expect(selectReusableEntry([draft, migrated], { title: '은혜의 노래' })?.verification).toBe('verified');
  });

  it('keeps an explicit draft state and rejects unusable rows', () => {
    expect(sanitizeLibraryEntry({ ...entry('새 노래'), verification: 'draft' })?.verification).toBe('draft');
    expect(sanitizeLibraryEntry({ ...entry('새 노래'), verification: 'bogus' })?.verification).toBe('verified');
    expect(sanitizeLibraryEntry({ title: '  ', sections: [] })).toBeNull();
    expect(sanitizeLibraryEntry(null)).toBeNull();
  });

  it('keeps an artist and only well-shaped provenance fields', () => {
    const clean = sanitizeLibraryEntry({
      ...entry('은혜의 노래'),
      artist: ' 새로운 팀 ',
      provenance: { source: 'web', webSourceUrl: 'https://example.test/song', confidence: 0.9, junk: [1] },
    })!;
    expect(clean.artist).toBe('새로운 팀');
    expect(clean.provenance).toEqual({
      source: 'web',
      webSourceUrl: 'https://example.test/song',
      confidence: 0.9,
    });
    expect(
      sanitizeLibraryEntry({ ...entry('은혜의 노래'), provenance: { source: 'ufo', confidence: 4 } })?.provenance,
    ).toBeUndefined();
  });

  it('produces the same shape as the proxy-side sanitizer (kept in lockstep)', () => {
    const raw = { ...entry('은혜의 노래'), artist: '새로운 팀', verification: 'edited', version: 3 };
    expect(sanitizeLibraryEntry(raw)).toEqual(sanitizeLyricsEntry(raw));
  });
});

describe('selectReusableEntry', () => {
  it('does not reuse a draft as authoritative lyrics', () => {
    const draft = { ...entry('새 노래'), verification: 'draft' as const, version: 2 };
    expect(selectReusableEntry([draft], { title: '새 노래' })).toBeUndefined();
  });

  it('prefers the highest saved version of a confirmed song', () => {
    const older = { ...entry('은혜의 노래', 'C'), verification: 'verified' as const, version: 1 };
    const newer = { ...entry('은혜의 노래', 'G'), verification: 'edited' as const, version: 4 };
    expect(selectReusableEntry([older, newer], { title: '은혜의 노래' })?.key).toBe('G');
  });

  it('keeps two songs with the same title but different artists apart', () => {
    const byTeam = { ...entry('같은 제목'), artist: '첫째 팀', verification: 'verified' as const, version: 1 };
    expect(selectReusableEntry([byTeam], { title: '같은 제목', artist: '둘째 팀' })).toBeUndefined();
    expect(selectReusableEntry([byTeam], { title: '같은 제목', artist: '첫째 팀' })?.artist).toBe('첫째 팀');
    // An unknown artist on either side must not block the match.
    expect(selectReusableEntry([byTeam], { title: '같은 제목' })?.artist).toBe('첫째 팀');
  });

  it('ignores a blank identity', () => {
    expect(selectReusableEntry([entry('은혜의 노래')], { title: '   ' })).toBeUndefined();
  });
});

describe('upsertEntry verification precedence', () => {
  it('never lets a later draft overwrite a verified library entry', () => {
    const verified = { ...entry('은혜의 노래'), verification: 'verified' as const, version: 2 };
    const draft = { ...entry('은혜의 노래'), verification: 'draft' as const, version: 3 };
    expect(upsertEntry([verified], draft)[0]).toEqual(verified);
  });

  it('lets an explicit edited save replace anything already stored', () => {
    const draft = { ...entry('은혜의 노래', 'C'), verification: 'draft' as const, version: 5 };
    const edited = { ...entry('은혜의 노래', 'G'), verification: 'edited' as const, version: 2 };
    expect(upsertEntry([draft], edited)[0].key).toBe('G');
  });

  it('still appends a draft for a song the library does not have', () => {
    const draft = { ...entry('처음 보는 곡'), verification: 'draft' as const, version: 1 };
    expect(upsertEntry([entry('은혜의 노래')], draft).map((e) => e.title)).toEqual(['은혜의 노래', '처음 보는 곡']);
  });
});
