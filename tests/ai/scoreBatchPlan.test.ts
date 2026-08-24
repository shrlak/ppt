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

/** Every model read the same title. */
const AGREED = [1];

describe('planScoreBatch', () => {
  it('answers a page from the library when the models agree on its title', () => {
    const plan = planScoreBatch(
      [
        { title: '주님의 사랑', order: [], sections: [] },
        { title: '처음 보는 노래', order: [], sections: [] },
      ],
      ['새 찬양 (p.2)', '새 찬양 (p.3)'],
      library,
      [1, 1],
    );

    // The saved lyrics stand in for the page; it never reaches the lyrics pass.
    expect(plan.libraryMatches[0]).toBe(library[0]);
    expect(plan.libraryCandidates[0]).toBeUndefined();
    expect(plan.libraryMatches[1]).toBeUndefined();
    expect(plan.libraryCandidates[1]).toBeUndefined();
  });

  it('holds the entry back as a candidate when the models disagree on the title', () => {
    // Two of three models read this title. That is exactly when loading the
    // library copy on the title alone would put another song on the screen, so
    // the page is still read and the saved copy has to match what it says.
    const plan = planScoreBatch(
      [{ title: '주님의 사랑', order: [], sections: [] }],
      [''],
      library,
      [0.66],
    );
    expect(plan.libraryMatches[0]).toBeUndefined();
    expect(plan.libraryCandidates[0]).toBe(library[0]);
  });

  it('treats a title with no measured agreement as unsettled', () => {
    const plan = planScoreBatch([{ title: '주님의 사랑', order: [], sections: [] }], [''], library);
    expect(plan.libraryMatches[0]).toBeUndefined();
    expect(plan.libraryCandidates[0]).toBe(library[0]);
  });

  it('uses the conti title when title recognition is blank', () => {
    // A printed conti title is text out of the PDF, not a reading of pixels.
    const plan = planScoreBatch([{ order: [], sections: [] }], ['주님의 사랑'], library, [0]);
    expect(plan.libraryMatches[0]).toBe(library[0]);
  });

  it('never matches on a placeholder title the conti gave an unnamed page', () => {
    const plan = planScoreBatch([{ order: [], sections: [] }], ['새 찬양 (p.3)'], library, [0]);
    expect(plan.libraryMatches[0]).toBeUndefined();
    expect(plan.libraryCandidates[0]).toBeUndefined();
  });

  it('prefers the newly recognized title over a stale conti title', () => {
    const plan = planScoreBatch(
      [{ title: '처음 보는 노래', order: [], sections: [] }],
      ['주님의 사랑'],
      library,
      AGREED,
    );
    expect(plan.libraryMatches[0]).toBeUndefined();
    expect(plan.libraryCandidates[0]).toBeUndefined();
  });

  it('never offers an entry whose title merely resembles the recognized one', () => {
    // A near miss is a different song, and its lyrics are the wrong lyrics.
    const plan = planScoreBatch(
      [{ title: '주님의 사랑이 나를', order: [], sections: [] }],
      [''],
      library,
      AGREED,
    );
    expect(plan.libraryMatches[0]).toBeUndefined();
    expect(plan.libraryCandidates[0]).toBeUndefined();
  });

  it('never answers a page from a draft somebody has not confirmed', () => {
    const drafts: LibraryEntry[] = [{ ...library[0], verification: 'draft' }];
    const plan = planScoreBatch(
      [{ title: '주님의 사랑', order: [], sections: [] }],
      [''],
      drafts,
      AGREED,
    );
    expect(plan.libraryMatches[0]).toBeUndefined();
    expect(plan.libraryCandidates[0]).toBeUndefined();
  });

  it('keeps two songs that share a title apart by artist', () => {
    const plan = planScoreBatch(
      [{ title: '주님의 사랑', artist: '다른 아티스트', order: [], sections: [] }],
      [''],
      [{ ...library[0], artist: '원래 아티스트' }],
      AGREED,
    );
    expect(plan.libraryMatches[0]).toBeUndefined();
  });
});
