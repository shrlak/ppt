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
  it('pairs a page with the saved entry it might be, without ending the page there', () => {
    const plan = planScoreBatch(
      [
        { title: '\uc8fc\ub2d8\uc758 \uc0ac\ub791', order: [], sections: [] },
        { title: '\ucc98\uc74c \ubcf4\ub294 \ub178\ub798', order: [], sections: [] },
      ],
      ['\uc0c8 \ucc2c\uc591 (p.2)', '\uc0c8 \ucc2c\uc591 (p.3)'],
      library,
    );

    expect(plan.libraryCandidates[0]).toBe(library[0]);
    expect(plan.libraryCandidates[1]).toBeUndefined();
  });

  it('uses the conti title when title recognition is blank', () => {
    const plan = planScoreBatch([{ order: [], sections: [] }], ['\uc8fc\ub2d8\uc758 \uc0ac\ub791'], library);
    expect(plan.libraryCandidates[0]).toBe(library[0]);
  });

  it('prefers the newly recognized title over a stale conti title', () => {
    const plan = planScoreBatch(
      [{ title: '\ucc98\uc74c \ubcf4\ub294 \ub178\ub798', order: [], sections: [] }],
      ['\uc8fc\ub2d8\uc758 \uc0ac\ub791'],
      library,
    );
    expect(plan.libraryCandidates[0]).toBeUndefined();
  });

  it('never offers an entry whose title merely resembles the recognized one', () => {
    // A near miss is a different song, and its lyrics are the wrong lyrics.
    const plan = planScoreBatch(
      [{ title: '\uc8fc\ub2d8\uc758 \uc0ac\ub791\uc774 \ub098\ub97c', order: [], sections: [] }],
      [''],
      library,
    );
    expect(plan.libraryCandidates[0]).toBeUndefined();
  });
});
