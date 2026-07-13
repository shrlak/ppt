import { describe, expect, it } from 'vitest';
import {
  findEntry,
  mergeLibraries,
  normalizeTitle,
  upsertEntry,
} from '../../src/lib/storage/library';
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
