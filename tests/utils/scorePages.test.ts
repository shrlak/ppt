import { describe, expect, it } from 'vitest';
import type { ParsedScore } from '../../src/lib/ai/scoreParser';
import { alignPagesToConti } from '../../src/lib/utils/contiAlignment';
import {
  combinePageReadings,
  foldUnlistedPages,
  groupContiPages,
  mergeReadings,
  printedEnglish,
  withEnglishTitle,
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

describe('foldUnlistedPages', () => {
  const card = (page: number, title?: string, artist?: string, nonScore = false) => ({ page, title, artist, nonScore });

  it('folds a page printing the title of the page before it into that card', () => {
    const heads = foldUnlistedPages(
      [card(1, 'A곡'), card(2, 'A곡'), card(3, 'B곡'), card(5, 'B곡')],
      { bilingual: false },
    );
    // p.4 (a 기도 page, no 악보) sits between the two B곡 cards.
    expect(heads).toEqual([0, 0, 2, 3]);
  });

  it('takes an untitled page right after a card as the rest of its score', () => {
    const heads = foldUnlistedPages(
      [card(5, 'Our God'), card(6), card(7, '모든 능력과 모든 권세'), card(8, '예배합니다')],
      { bilingual: true },
    );
    expect(heads).toEqual([0, 0, 2, 3]);
  });

  it('does not chain untitled pages when the title pass read next to nothing', () => {
    expect(foldUnlistedPages([card(1, 'A곡'), card(2), card(3), card(4)], { bilingual: false })).toEqual([0, 1, 2, 3]);
  });

  it('never folds across a page the models found no 악보 on', () => {
    const heads = foldUnlistedPages(
      [card(1, 'A곡'), card(2, undefined, undefined, true), card(3), card(4, 'B곡')],
      { bilingual: false },
    );
    expect(heads).toEqual([0, 1, 2, 3]);
  });

  // 2026 EM&KM 찬양집회 (FINAL): no cover, 기도 pages between the sets, each
  // Korean 악보 sometimes followed by its English SongSelect sheet.
  it('reads this year’s 찬양집회 conti: an English sheet joins its Korean song only when the writers match', () => {
    const cards = [
      card(1, '하늘 위에 주님밖에', 'Eugene Greco'),
      card(2, 'God Is The Strength Of My Heart', 'Eugene Greco'),
      card(3, 'Praise', 'Brandon Lake | Chandler Moore | Chris Brown | Cody Carnes | Pat Barrett | Steven Furtick'),
      card(4, 'Praise'),
      card(5, 'Our God', 'Chris Tomlin'),
      card(6),
      card(7, '모든 능력과 모든 권세', 'Paul Baloche/Lenny LeBlanc'),
      card(8, '예배합니다', 'Rose Park'),
      card(10, '나의 백성이', 'Tom & Robin Brooks'),
      card(11, '부르신 곳에서', 'Words & Music by 김준영 & 송은정'),
      card(13, '예수 우리들의 밝은 빛', 'Takafumi Nagasawa'),
      card(14, 'Hosanna', 'Brooke Ligertwood'),
      card(15),
      card(16, '찬양의 열기', 'Matt Redman'),
      card(18, 'Call On Jesus', 'Jacob Lee | Jin Woo Lim | Joe Lee | Joshua Chang | Maximus Chung'),
      card(19),
      card(20, 'Washed', 'Elevation Rhythm - Joe L. Barnes, Joshua Holiday, and Mitch Wong'),
      card(21),
      card(22, '좋으신 하나님', 'Israel Houghton'),
    ];
    const heads = foldUnlistedPages(cards, { bilingual: true });
    const songs = [...new Set(heads)].map((head) => cards.filter((_, index) => heads[index] === head).map((c) => c.page));
    expect(songs).toEqual([[1, 2], [3, 4], [5, 6], [7], [8], [10], [11], [13], [14, 15], [16], [18, 19], [20, 21], [22]]);
  });

  it('pairs an English sheet by the English title its Korean song was saved with', () => {
    const heads = foldUnlistedPages([card(1, '부르신 곳에서'), card(2, "At The Place You've Called Me To")], {
      bilingual: true,
      englishTitleOf: (title) => (title === '부르신 곳에서' ? "At the Place You've Called Me To" : undefined),
    });
    expect(heads).toEqual([0, 0]);
  });

  it('takes an English sheet printed first, with its second page, into the Korean song after it', () => {
    const heads = foldUnlistedPages(
      [card(1, 'Above All', 'Paul Baloche'), card(2), card(3, '모든 능력과 모든 권세', 'Paul Baloche/Lenny LeBlanc')],
      { bilingual: true },
    );
    expect(heads).toEqual([2, 2, 2]);
  });

  it('keeps English and Korean apart on a Sunday conti', () => {
    const heads = foldUnlistedPages(
      [card(1, '하늘 위에 주님밖에', 'Eugene Greco'), card(2, 'God Is The Strength Of My Heart', 'Eugene Greco')],
      { bilingual: false },
    );
    expect(heads).toEqual([0, 1]);
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

describe('printedEnglish', () => {
  it('takes the English a Korean page prints beside its lyrics, and its English title', () => {
    const page = reading([['V', ['모든 능력과 모든 권세']]], {
      title: '모든 능력과 모든 권세',
      englishTitle: 'Above All',
      englishSections: [{ label: 'V', lines: ['Above all powers'] }],
    });
    expect(combinePageReadings([page]).english).toEqual({
      pageType: undefined,
      sermonTitle: undefined,
      scripture: undefined,
      title: 'Above All',
      artist: undefined,
      key: undefined,
      order: [],
      lyricRowCount: undefined,
      sections: [{ label: 'V', lines: ['Above all powers'] }],
    });
    // The Korean lyrics are left exactly as read.
    expect(combinePageReadings([page]).score).toBe(page);
  });

  it('puts an English page and the English beside the Korean together', () => {
    const korean = reading([['V', ['하늘 위에 주님밖에']]], { englishSections: [{ label: 'C', lines: ['God is the strength'] }] });
    const english = reading([['V', ['Whom have I in heaven']]], { title: 'God Is The Strength Of My Heart' });
    const merged = printedEnglish([korean, english]);
    expect(merged?.title).toBe('God Is The Strength Of My Heart');
    expect(merged?.sections).toEqual([
      { label: 'C', lines: ['God is the strength'] },
      { label: 'V', lines: ['Whom have I in heaven'] },
    ]);
  });

  it('reads a settled Korean song’s English page as its English, and an English song’s pages as none', () => {
    const english = reading([['V', ['Whom have I in heaven']]], { title: 'God Is The Strength Of My Heart' });
    expect(printedEnglish([english])).toBeNull();
    expect(printedEnglish([english], true)?.title).toBe('God Is The Strength Of My Heart');
  });

  it('gives the English the title the title pass read, when the lyrics pass read none', () => {
    expect(withEnglishTitle(null, 'Above All')).toEqual({ title: 'Above All', order: [], sections: [] });
    expect(withEnglishTitle(null, undefined)).toBeNull();
    const english = reading([['V', ['Above all powers']]]);
    expect(withEnglishTitle(english, 'Above All')?.title).toBe('Above All');
    expect(withEnglishTitle({ ...english, title: 'Above All (Live)' }, 'Above All')?.title).toBe('Above All (Live)');
  });
});

describe('mergeReadings — a part only a later page prints', () => {
  it('is added after the parts the first page’s 진행 names, so it is not left off the slides', () => {
    const merged = mergeReadings([
      reading([['V1', ['I’ll praise in the valley']], ['C', ['Praise the Lord, oh my soul']]], { order: ['I', 'V1', 'C'] }),
      reading([['B', ['I’ll praise ’cause You’re sov’reign']], ['C', ['Praise the Lord, oh my soul']]]),
    ]);
    expect(merged.order).toEqual(['I', 'V1', 'C', 'B']);
  });

  it('leaves out a part the first page prints but its 진행 skips', () => {
    const merged = mergeReadings([
      reading([['V', ['절']], ['V2', ['둘째 절']], ['C', ['후렴']]], { order: ['V', 'C'] }),
      reading([['C', ['후렴']]]),
    ]);
    expect(merged.order).toEqual(['V', 'C']);
  });
});
