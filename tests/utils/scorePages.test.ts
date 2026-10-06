import { describe, expect, it } from 'vitest';
import type { ParsedScore } from '../../src/lib/ai/scoreParser';
import { alignPagesToConti } from '../../src/lib/utils/contiAlignment';
import {
  combinePageReadings,
  foldRepeatedTitles,
  groupContiPages,
  mergeReadings,
  type PageGroupingInput,
} from '../../src/lib/utils/scorePages';

function titles(map: Record<number, string>): (page: number) => string | undefined {
  return (page) => map[page];
}

function grouping(input: Partial<PageGroupingInput> & Pick<PageGroupingInput, 'songs' | 'spares'>) {
  const pages = [...input.songs.map((song) => song.page), ...input.spares].sort((a, b) => a - b);
  return groupContiPages({ musicPages: pages, titleOf: () => undefined, bilingual: false, ...input });
}

function reading(sections: [string, string[]][], extra: Partial<ParsedScore> = {}): ParsedScore {
  return { order: [], sections: sections.map(([label, lines]) => ({ label, lines })), ...extra };
}

describe('groupContiPages', () => {
  it('gives a page printing a listed song’s title to that song', () => {
    const result = grouping({
      songs: [
        { title: '주님의 선하심', page: 2 },
        { title: '부르신 곳에서', page: 4 },
      ],
      spares: [5],
      titleOf: titles({ 2: '주님의 선하심', 4: '부르신 곳에서', 5: '부르신 곳에서' }),
    });
    expect(result.pages).toEqual([[2], [4, 5]]);
    expect(result.unclaimed).toEqual([]);
  });

  it('takes a page with no title as the page before it carrying on, three pages long too', () => {
    const result = grouping({
      songs: [
        { title: 'A곡', page: 2 },
        { title: 'B곡', page: 5 },
      ],
      spares: [3, 4, 6],
      titleOf: titles({ 2: 'A곡', 5: 'B곡' }),
    });
    expect(result.pages).toEqual([[2, 3, 4], [5, 6]]);
  });

  it('keeps out a page with a title of its own that no listed song has', () => {
    const result = grouping({
      songs: [{ title: 'A곡', page: 2 }],
      spares: [3],
      titleOf: titles({ 2: 'A곡', 3: 'Plan B 곡' }),
    });
    expect(result.pages).toEqual([[2]]);
    expect(result.unclaimed).toEqual([3]);
  });

  it('does not guess continuations when the title pass read nothing', () => {
    const result = grouping({
      songs: [
        { title: 'A곡', page: 2 },
        { title: 'B곡', page: 3 },
      ],
      spares: [4, 5],
    });
    expect(result.pages).toEqual([[2], [3]]);
    expect(result.unclaimed).toEqual([4, 5]);
  });

  it('never takes a page that is no 악보', () => {
    const result = grouping({
      songs: [{ title: 'A곡', page: 2 }],
      spares: [3],
      titleOf: titles({ 2: 'A곡' }),
      isNonScore: (page) => page === 3,
    });
    expect(result.pages).toEqual([[2]]);
  });

  it('puts a 찬양집회 song’s English page under its Korean one', () => {
    const result = grouping({
      songs: [
        { title: '주님의 선하심', page: 1 },
        { title: '부르신 곳에서', page: 3 },
      ],
      spares: [2, 4],
      titleOf: titles({ 1: '주님의 선하심', 2: 'Goodness of God', 3: '부르신 곳에서', 4: 'The Place You Called Me' }),
      bilingual: true,
    });
    expect(result.pages).toEqual([
      [1, 2],
      [3, 4],
    ]);
  });

  it('takes the English page printed before the Korean one when the song before already has its English', () => {
    const result = grouping({
      songs: [
        { title: '주님의 선하심', page: 1 },
        { title: '부르신 곳에서', page: 4 },
      ],
      spares: [2, 3],
      titleOf: titles({ 1: '주님의 선하심', 2: 'Goodness of God', 3: 'At the Place You Called Me', 4: '부르신 곳에서' }),
      bilingual: true,
    });
    expect(result.pages).toEqual([
      [1, 2],
      [4, 3],
    ]);
  });

  it('leaves an English-titled page alone on a Sunday conti', () => {
    const result = grouping({
      songs: [{ title: '주님의 선하심', page: 1 }],
      spares: [2],
      titleOf: titles({ 1: '주님의 선하심', 2: 'Goodness of God' }),
    });
    expect(result.unclaimed).toEqual([2]);
  });

  it('matches the English title the conti printed, and puts the Korean page first', () => {
    // The English 악보 came first in the PDF, so the song was first given it.
    const result = grouping({
      songs: [{ title: '하늘 위에 주님밖에', englishTitle: 'God is the Strength of my Heart', page: 1 }],
      spares: [2],
      titleOf: titles({ 1: 'God is the Strength of my Heart', 2: '하늘 위에 주님밖에' }),
      bilingual: true,
    });
    expect(result.pages).toEqual([[2, 1]]);
  });
});

describe('alignPagesToConti with a song’s second page', () => {
  it('does not hand a song whose title was misread a page printing another song’s title', () => {
    // B곡's title was not read; its own slot is A곡's English page.
    const songs = ['A곡', 'B곡', 'C곡'];
    const pages = ['A곡', 'A곡', '???', 'C곡'];
    expect(alignPagesToConti(songs, pages)).toEqual([0, 2, 3]);
  });
});

describe('foldRepeatedTitles', () => {
  it('folds a page printing the title of the page before it into that card', () => {
    expect(foldRepeatedTitles(['A곡', 'A곡', 'B곡', undefined, 'B곡'])).toEqual([0, 0, 2, 3, 4]);
  });
});

describe('mergeReadings', () => {
  it('adds a part only the later page has, and carries on a part broken over the page', () => {
    const merged = mergeReadings([
      reading(
        [
          ['V', ['첫 줄', '둘째 줄']],
          ['C', ['후렴 첫 줄']],
        ],
        { title: 'A곡', order: ['I', 'V', 'C', 'B', 'C'] },
      ),
      reading([
        ['C', ['후렴 둘째 줄']],
        ['B', ['브릿지']],
      ]),
    ]);
    expect(merged.title).toBe('A곡');
    expect(merged.order).toEqual(['I', 'V', 'C', 'B', 'C']);
    expect(merged.sections).toEqual([
      { label: 'V', lines: ['첫 줄', '둘째 줄'] },
      { label: 'C', lines: ['후렴 첫 줄', '후렴 둘째 줄'] },
      { label: 'B', lines: ['브릿지'] },
    ]);
  });

  it('adds nothing for a part printed again', () => {
    const merged = mergeReadings([
      reading([['C', ['후렴 첫 줄', '후렴 둘째 줄']]]),
      reading([['C', ['후렴 첫 줄', '후렴  둘째 줄!']]]),
    ]);
    expect(merged.sections).toEqual([{ label: 'C', lines: ['후렴 첫 줄', '후렴 둘째 줄'] }]);
  });
});

describe('combinePageReadings', () => {
  it('leaves a song read off one page exactly as it was read', () => {
    const only = reading(
      [
        ['V', ['첫 줄']],
        ['V', ['다른 첫 줄']],
      ],
      { sermonTitle: '설교 제목' },
    );
    expect(combinePageReadings([only])).toEqual({ score: only, english: null });
  });

  it('keeps the English page apart from the Korean song', () => {
    const combined = combinePageReadings([
      reading([['V', ['주님의 선하심']]], { title: 'Goodness of God', pageType: 'score' }),
      reading([['V', ['I love You Lord']]], { title: 'Goodness of God' }),
    ]);
    expect(combined.score.sections).toEqual([{ label: 'V', lines: ['주님의 선하심'] }]);
    expect(combined.english?.sections).toEqual([{ label: 'V', lines: ['I love You Lord'] }]);
  });

  it('takes the Korean title wherever it was printed', () => {
    const combined = combinePageReadings([
      reading([['V', ['I love You Lord']]], { title: 'Goodness of God' }),
      reading([['V', ['주님의 선하심']]], { title: '주님의 선하심' }),
    ]);
    expect(combined.score.title).toBe('주님의 선하심');
    expect(combined.english?.title).toBe('Goodness of God');
  });

  it('keeps a Korean song’s English apart while its Korean page is still unread', () => {
    const combined = combinePageReadings(
      [reading([], { title: '주님의 선하심' }), reading([['V', ['I love You Lord']]], { title: 'Goodness of God' })],
      true,
    );
    expect(combined.score.sections).toEqual([]);
    expect(combined.score.title).toBe('주님의 선하심');
    expect(combined.english?.sections).toEqual([{ label: 'V', lines: ['I love You Lord'] }]);
  });

  it('reads a song printed in English only as the song', () => {
    const combined = combinePageReadings([
      reading([['V', ['Praise the Lord']]], { title: 'Praise' }),
      reading([['C', ['Let everything that has breath']]]),
    ]);
    expect(combined.english).toBeNull();
    expect(combined.score.sections.map((section) => section.label)).toEqual(['V', 'C']);
  });
});
