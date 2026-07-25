import { describe, expect, it } from 'vitest';
import { deckNameKey, decksWithSameName } from '../../src/lib/storage/deckNames';

const deck = (id: string, name: string, savedAt: string) => ({ id, name, savedAt });

describe('deckNameKey', () => {
  it('ignores case, surrounding space and the .pptx suffix', () => {
    expect(deckNameKey('2025-01-05 주일예배.pptx')).toBe(deckNameKey('  2025-01-05 주일예배  '));
    expect(deckNameKey('Sunday.pptx')).toBe(deckNameKey('sunday.PPTX'));
  });

  it('keeps different names apart', () => {
    expect(deckNameKey('2025-01-05.pptx')).not.toBe(deckNameKey('2025-01-12.pptx'));
  });

  it('treats a blank name as no name at all', () => {
    expect(deckNameKey('  .pptx ')).toBe('');
  });
});

describe('decksWithSameName', () => {
  const library = [
    deck('a', '2025-01-05 주일예배.pptx', '2025-01-05T00:00:00.000Z'),
    deck('b', '2025-01-05 주일예배', '2025-01-06T00:00:00.000Z'),
    deck('c', '2025-01-12 주일예배.pptx', '2025-01-12T00:00:00.000Z'),
  ];

  it('returns every colliding entry, most recently saved first', () => {
    expect(decksWithSameName(library, '2025-01-05 주일예배.pptx').map((entry) => entry.id)).toEqual(['b', 'a']);
  });

  it('returns nothing for a name the library does not hold', () => {
    expect(decksWithSameName(library, '2025-02-02.pptx')).toEqual([]);
  });

  it('skips the entry being written so it never supersedes itself', () => {
    expect(decksWithSameName(library, '2025-01-05 주일예배.pptx', 'b').map((entry) => entry.id)).toEqual(['a']);
  });

  it('never matches on a blank name', () => {
    expect(decksWithSameName([deck('d', '.pptx', '2025-01-05T00:00:00.000Z')], '')).toEqual([]);
  });
});
