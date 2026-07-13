import { describe, expect, it } from 'vitest';
import { findSection, planSlides, planAllSlides, unmatchedTokens } from '../../src/lib/utils/slidePlanner';
import type { Song } from '../../src/lib/utils/types';

const lines = (n: number, prefix = 'line') =>
  Array.from({ length: n }, (_, i) => `${prefix} ${i + 1}`);

function song(partial: Partial<Song>): Song {
  return {
    id: 't',
    title: '테스트 찬양',
    sections: [],
    order: [],
    linesPerSlide: 4,
    ...partial,
  };
}

describe('findSection', () => {
  const sections = [
    { label: 'V1', lines: ['a'] },
    { label: 'PC', lines: ['b'] },
    { label: 'C', lines: ['c'] },
  ];

  it('matches exactly, case-insensitively', () => {
    expect(findSection(sections, 'pc')?.label).toBe('PC');
  });

  it('falls back V → V1', () => {
    expect(findSection(sections, 'V')?.label).toBe('V1');
  });

  it('falls back C2 → C', () => {
    expect(findSection(sections, 'C2')?.label).toBe('C');
  });

  it('returns undefined for unknown tokens', () => {
    expect(findSection(sections, 'B')).toBeUndefined();
  });
});

describe('planSlides (minimal parts, no 콘티-order expansion)', () => {
  it('leads with a single title slide', () => {
    const s = song({
      sections: [{ label: 'V1', lines: lines(2) }],
      order: ['I', 'V1'],
    });
    const plans = planSlides(s);
    expect(plans).toHaveLength(2);
    expect(plans[0]).toEqual({ kind: 'title', title: '테스트 찬양' });
    expect(plans[1].kind).toBe('lyrics');
  });

  it('emits each part exactly once even when the order repeats it', () => {
    const s = song({
      sections: [
        { label: 'V1', lines: lines(2) },
        { label: 'PC', lines: lines(2) },
        { label: 'C', lines: lines(2) },
      ],
      order: ['I', 'V1', 'PC', 'C', 'I', 'V1', 'PC', 'C', 'C'],
    });
    const plans = planSlides(s);
    // title + V1 + PC + C — repeats and mid-order 간주 add nothing
    expect(plans.map((p) => p.kind)).toEqual(['title', 'lyrics', 'lyrics', 'lyrics']);
  });

  it('dedupes aliased tokens resolving to the same section (C1/C2 → C)', () => {
    const s = song({
      sections: [{ label: 'C', lines: lines(2) }],
      order: ['C1', 'C2'],
    });
    expect(planSlides(s)).toHaveLength(2);
  });

  it('orders parts by first appearance in the 콘티 order', () => {
    const s = song({
      sections: [
        { label: 'V1', lines: ['verse'] },
        { label: 'C', lines: ['chorus'] },
      ],
      order: ['C', 'V1', 'C'],
    });
    const plans = planSlides(s);
    expect(plans[1].lines).toEqual(['chorus']);
    expect(plans[2].lines).toEqual(['verse']);
  });

  it('splits a section exceeding the line limit into balanced, evenly-sized slides', () => {
    const s = song({
      sections: [{ label: 'C', lines: lines(10) }],
      order: ['C'],
    });
    const plans = planSlides(s);
    // 10 lines at a limit of 4 -> 3 slides, sizes as equal as possible (not a lopsided 4/4/2).
    expect(plans.map((p) => p.lines?.length ?? 0)).toEqual([0, 4, 3, 3]);
  });

  it('splits an exactly-double section into two equal halves', () => {
    const s = song({
      sections: [{ label: 'C', lines: lines(6) }],
      order: ['C'],
    });
    const plans = planSlides(s);
    expect(plans.map((p) => p.lines?.length ?? 0)).toEqual([0, 3, 3]);
  });

  it('respects linesPerSlide and skips blank lines', () => {
    const s = song({
      sections: [{ label: 'V1', lines: ['a', ' ', 'b', '', 'c'] }],
      order: ['V1'],
      linesPerSlide: 2,
    });
    const plans = planSlides(s);
    expect(plans[1].lines).toEqual(['a', 'b']);
    expect(plans[2].lines).toEqual(['c']);
  });

  it('skips unknown tokens instead of failing', () => {
    const s = song({
      sections: [{ label: 'C', lines: lines(1) }],
      order: ['C', '기도'],
    });
    expect(planSlides(s)).toHaveLength(2);
  });

  it('includes all sections once when order is empty', () => {
    const s = song({
      sections: [
        { label: 'V1', lines: lines(2) },
        { label: 'C', lines: lines(2) },
      ],
      order: [],
    });
    expect(planSlides(s)).toHaveLength(3);
  });
});

describe('unmatchedTokens', () => {
  it('reports tokens without lyrics, ignoring I', () => {
    const s = song({
      sections: [
        { label: 'V1', lines: lines(2) },
        { label: 'B', lines: [' '] },
      ],
      order: ['I', 'V1', 'B', '기도', 'B'],
    });
    expect(unmatchedTokens(s).sort()).toEqual(['B', '기도']);
  });
});

describe('planAllSlides', () => {
  it('concatenates songs in order', () => {
    const a = song({ title: 'A', sections: [{ label: 'C', lines: lines(2) }], order: ['C'] });
    const b = song({ title: 'B', sections: [{ label: 'C', lines: lines(2) }], order: ['C'] });
    const plans = planAllSlides([a, b]);
    expect(plans).toHaveLength(4);
    expect(plans[0].title).toBe('A');
    expect(plans[2].title).toBe('B');
  });
});
