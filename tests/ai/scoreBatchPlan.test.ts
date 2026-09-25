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
  it('answers a page from the library when its recognized title is saved there', () => {
    const plan = planScoreBatch(
      [
        { title: '주님의 사랑', order: [], sections: [] },
        { title: '처음 보는 노래', order: [], sections: [] },
      ],
      ['새 찬양 (p.2)', '새 찬양 (p.3)'],
      library,
    );

    // The saved lyrics stand in for the page; it never reaches the lyrics pass.
    expect(plan.libraryMatches[0]).toBe(library[0]);
    expect(plan.libraryMatches[1]).toBeUndefined();
  });

  it('uses the conti title when title recognition is blank', () => {
    // A printed conti title is text out of the PDF, not a reading of pixels.
    const plan = planScoreBatch([{ order: [], sections: [] }], ['주님의 사랑'], library);
    expect(plan.libraryMatches[0]).toBe(library[0]);
  });

  it('loads the conti title from the library even when the models read another title', () => {
    const plan = planScoreBatch([{ title: '처음 보는 노래', order: [], sections: [] }], ['주님의 사랑'], library);
    expect(plan.libraryMatches[0]).toBe(library[0]);
  });

  it('falls back to the recognized title when the conti title is not saved', () => {
    const plan = planScoreBatch([{ title: '주님의 사랑', order: [], sections: [] }], ['다른 노래'], library);
    expect(plan.libraryMatches[0]).toBe(library[0]);
  });

  it('never matches on a placeholder title the conti gave an unnamed page', () => {
    const plan = planScoreBatch([{ order: [], sections: [] }], ['새 찬양 (p.3)'], library);
    expect(plan.libraryMatches[0]).toBeUndefined();
  });

  it('never offers an entry whose title merely resembles the recognized one', () => {
    // A near miss is a different song, and its lyrics are the wrong lyrics.
    const plan = planScoreBatch([{ title: '주님의 사랑이 나를', order: [], sections: [] }], [''], library);
    expect(plan.libraryMatches[0]).toBeUndefined();
  });

  it('loads a draft when the library holds nothing confirmed under that title', () => {
    const drafts: LibraryEntry[] = [{ ...library[0], verification: 'draft' }];
    const plan = planScoreBatch([{ title: '주님의 사랑', order: [], sections: [] }], [''], drafts);
    expect(plan.libraryMatches[0]).toBe(drafts[0]);
  });

  it('prefers the confirmed entry over a draft with the same title', () => {
    const entries: LibraryEntry[] = [
      { ...library[0], verification: 'draft', version: 5 },
      { ...library[0], verification: 'verified', version: 1 },
    ];
    const plan = planScoreBatch([{ title: '주님의 사랑', order: [], sections: [] }], [''], entries);
    expect(plan.libraryMatches[0]).toBe(entries[1]);
  });

  it('keeps two songs that share a title apart by artist', () => {
    const plan = planScoreBatch(
      [{ title: '주님의 사랑', artist: '다른 아티스트', order: [], sections: [] }],
      [''],
      [{ ...library[0], artist: '원래 아티스트' }],
    );
    expect(plan.libraryMatches[0]).toBeUndefined();
  });
});
