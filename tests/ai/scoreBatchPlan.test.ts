import { describe, expect, it } from 'vitest';
import { planScoreBatch } from '../../src/lib/ai/scoreBatchPlan';
import type { LibraryEntry } from '../../src/lib/utils/types';

const library: LibraryEntry[] = [
  {
    title: '주님의 사랑',
    key: 'E',
    order: ['I', 'V1'],
    sections: [{ label: 'V1', lines: ['저장된 가사'] }],
  },
];

describe('planScoreBatch', () => {
  it('stops saved titles after the title pass and sends only unknown songs to lyrics', () => {
    const plan = planScoreBatch(
      [
        { title: '주님의 사랑', order: [], sections: [] },
        { title: '처음 보는 노래', order: [], sections: [] },
      ],
      ['새 찬양 (p.2)', '새 찬양 (p.3)'],
      library,
    );

    expect(plan.libraryMatches[0]).toBe(library[0]);
    expect(plan.libraryMatches[1]).toBeUndefined();
    expect(plan.lyricIndexes).toEqual([1]);
  });

  it('uses the conti title when title recognition is blank', () => {
    const plan = planScoreBatch([{ order: [], sections: [] }], ['주님의 사랑'], library);
    expect(plan.libraryMatches[0]).toBe(library[0]);
    expect(plan.lyricIndexes).toEqual([]);
  });

  it('prefers the newly recognized title over a stale conti title', () => {
    const plan = planScoreBatch(
      [{ title: '처음 보는 노래', order: [], sections: [] }],
      ['주님의 사랑'],
      library,
    );
    expect(plan.libraryMatches[0]).toBeUndefined();
    expect(plan.lyricIndexes).toEqual([0]);
  });
});
