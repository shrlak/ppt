import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  dateFromFileName,
  classifyPages,
  continuesCover,
  findCoverPages,
  looksLikeCoverText,
  deriveSongsFromMusicPages,
  looksLikeInfoPage,
  matchSongsToPages,
  nameUntitledRowsFromLayout,
  parseCoverText,
  parseSermonInfoText,
  splitLyricsAndConfessionSongs,
  untitledSongTitle,
} from '../../src/lib/utils/contiText';
import { isPlaceholderTitle } from '../../src/lib/utils/contiAlignment';
import type { LibraryEntry } from '../../src/lib/utils/types';

const coverText = readFileSync(join(__dirname, '..', 'fixtures', 'cover.txt'), 'utf-8');
const coverTableText = readFileSync(join(__dirname, '..', 'fixtures', 'cover-table.txt'), 'utf-8');
const continuationText = readFileSync(join(__dirname, '..', 'fixtures', 'cover-continuation.txt'), 'utf-8');
const notesText = readFileSync(join(__dirname, '..', 'fixtures', 'notes.txt'), 'utf-8');

describe('parseCoverText', () => {
  const info = parseCoverText(coverText);

  it('parses the real example cover page', () => {
    expect(info).not.toBeNull();
    expect(info?.date).toBe('7/11/26');
    expect(info?.sermonTitle).toBe('하나님과 화평을 누리자');
    expect(info?.scripture).toBe('로마서 5장 1-11절');
  });

  it('extracts the song list with keys and descriptions', () => {
    expect(info?.songs.map((s) => [s.title, s.key])).toEqual([
      ['주님의 사랑', 'E'],
      ['주 은혜임을', 'F'],
      ['입례', 'F'],
    ]);
    for (const s of info?.songs ?? []) {
      expect(s.description?.length).toBeGreaterThan(3);
    }
  });

  it('returns null for non-cover text', () => {
    expect(parseCoverText('그냥 아무 내용 없는 페이지')).toBeNull();
    expect(parseCoverText(notesText)).toBeNull();
  });
});

describe('parseCoverText — 순서/찬양/키 table layout', () => {
  const info = parseCoverText(coverTableText);

  it('reads the service fields written as label | value rows', () => {
    expect(info).not.toBeNull();
    expect(info?.date).toBe('2026.08.09');
    expect(info?.sermonTitle).toBe('청년의 때');
    expect(info?.scripture).toBe('전도서 12 장 1-8 절');
  });

  it('reads every table row, keeping modulation chains as the key', () => {
    expect(info?.songs.map((s) => [s.title, s.key])).toEqual([
      ['매일매일', 'A'],
      ['청년의 기도', 'F -> Gb'],
      ['어려운 일 당할 때', 'F -> Ab -> G'],
      ['입례', 'F -> G'],
    ]);
  });

  it('attaches the bullet commentary to the song it describes', () => {
    const daily = info?.songs.find((s) => s.title === '매일매일');
    expect(daily?.description).toContain('청년의 때를 살아가는 지금');
    // The wrapped second line of the description is kept with it.
    expect(daily?.description).toContain('결단하여야 합니다');
  });

  it('never mistakes numbered 본문 prose for a table row', () => {
    const titles = info?.songs.map((s) => s.title) ?? [];
    expect(titles).toHaveLength(4);
    expect(titles.some((t) => t.includes('전도자가'))).toBe(false);
  });
});

describe('parseCoverText — layout variations', () => {
  it('finds the table from its header row when no 찬양 콘티 heading is written', () => {
    const info = parseCoverText(
      ['날짜 | 2026.08.09', '본문 | 전도서 12장 1-8절', '순서 찬양 키', '1 첫째 곡 A', '2 둘째 곡 F'].join('\n'),
    );
    expect(info?.songs.map((s) => [s.title, s.key])).toEqual([
      ['첫째 곡', 'A'],
      ['둘째 곡', 'F'],
    ]);
  });

  it('accepts the column names other contis use', () => {
    const info = parseCoverText(
      ['날짜: 2026.08.09', '번호 | 곡명 | Key', '1 첫째 곡 A', '2 둘째 곡 Bb'].join('\n'),
    );
    expect(info?.songs.map((s) => [s.title, s.key])).toEqual([
      ['첫째 곡', 'A'],
      ['둘째 곡', 'Bb'],
    ]);
  });

  it('accepts 찬양 순서 as the section heading, numbered or not', () => {
    for (const heading of ['2. 찬양 순서', '찬양 순서', '찬양 콘티']) {
      const info = parseCoverText(['본문: 로마서 5장 1-11절', heading, '1 첫째 곡 A'].join('\n'));
      expect(info?.songs.map((s) => s.title)).toEqual(['첫째 곡']);
    }
  });

  it('prefers an explicit 설교 제목 over a 주제 row, whichever comes first', () => {
    expect(parseSermonInfoText('주제 | 청년의 때\n설교 제목: 하나님과 화평을 누리자')).toEqual({
      sermonTitle: '하나님과 화평을 누리자',
      scripture: undefined,
    });
    // With only a 주제 row, that is the best available sermon title.
    expect(parseSermonInfoText('주제 | 청년의 때').sermonTitle).toBe('청년의 때');
  });

  it('does not read a page of lyrics as a cover', () => {
    const lyricsPage = ['주님의 사랑', '가나다라 마바사 아자차', '카타파하 그 이름 높이'].join('\n');
    expect(parseCoverText(lyricsPage)).toBeNull();
  });

  it('needs service context, not just something table-shaped', () => {
    // A song list with no date, sermon title or 본문 is not a cover page.
    expect(parseCoverText('순서 찬양 키\n1 첫째 곡 A')).toBeNull();
  });
});

/** The 2026.08.09-style cover with the first song's title written by hand. */
function handwrittenCover(rows: string[], tail: string[] = []): string {
  return [
    '본문 | 전도서 12 장 1-8 절',
    '날짜 | 2026.10.04',
    '2. 찬양 콘티 (Plan A)',
    '순서 찬양 키',
    ...rows,
    ...tail,
    '3. 본문',
    '1. 너는 청년의 때에 너의 창조주를 기억하라 G',
  ].join('\n');
}

describe('parseCoverText — a title written by hand', () => {
  const rest = ['2 그 사랑 G', '3 우리가 넉넉히 이기느니라 A', '4 임재 G'];

  it('keeps a row with no title text in its slot, with its key', () => {
    // The handwritten title is ink: only the order number and the key are text.
    const info = parseCoverText(handwrittenCover(['1 G', ...rest]));
    expect(info?.songs.map((s) => [s.title, s.key])).toEqual([
      [untitledSongTitle(1), 'G'],
      ['그 사랑', 'G'],
      ['우리가 넉넉히 이기느니라', 'A'],
      ['임재', 'G'],
    ]);
    // A placeholder is what the 악보's own title replaces.
    expect(isPlaceholderTitle(info?.songs[0].title)).toBe(true);
  });

  it('treats a title in glyphs the PDF cannot map to letters as unwritten', () => {
    const info = parseCoverText(handwrittenCover(['1 \uE01A\uE02B\uE03C G', ...rest]));
    expect(info?.songs.map((s) => [s.title, s.key])).toEqual([
      [untitledSongTitle(1), 'G'],
      ['그 사랑', 'G'],
      ['우리가 넉넉히 이기느니라', 'A'],
      ['임재', 'G'],
    ]);
  });

  it('puts back together a row whose cells came out on separate lines', () => {
    // A handwriting font sits on its own baseline, so each cell is a line.
    const info = parseCoverText(handwrittenCover(['1', '주님의 은혜 넘치네', 'G', ...rest]));
    expect(info?.songs.map((s) => [s.title, s.key])).toEqual([
      ['주님의 은혜 넘치네', 'G'],
      ['그 사랑', 'G'],
      ['우리가 넉넉히 이기느니라', 'A'],
      ['임재', 'G'],
    ]);
  });

  it('keeps a row whose title and key both came out empty', () => {
    const info = parseCoverText(handwrittenCover(['1', ...rest]));
    expect(info?.songs.map((s) => s.title)).toEqual([
      untitledSongTitle(1),
      '그 사랑',
      '우리가 넉넉히 이기느니라',
      '임재',
    ]);
    expect(info?.songs[0].key).toBeUndefined();
  });

  it('names the row from the commentary bullet that describes it', () => {
    const info = parseCoverText(
      handwrittenCover(
        ['1 G', ...rest],
        ['• 주님의 은혜 넘치네 (G Key)', 'o 주님의 은혜를 고백하는 찬양입니다.', '• 그 사랑 (G Key)', 'o 십자가의 사랑.'],
      ),
    );
    expect(info?.songs.map((s) => s.title)).toEqual(['주님의 은혜 넘치네', '그 사랑', '우리가 넉넉히 이기느니라', '임재']);
    expect(info?.songs[0].description).toContain('은혜를 고백');
    expect(info?.songs[1].description).toContain('십자가의 사랑');
  });

  it('gives a bullet whose title is also handwritten to the unnamed row', () => {
    const info = parseCoverText(
      handwrittenCover(
        ['1 G', ...rest],
        ['• 그 사랑 (G Key)', 'o 십자가의 사랑.', '• (G Key)', 'o 은혜를 고백하는 찬양입니다.'],
      ),
    );
    expect(info?.songs.map((s) => s.title)).toEqual([
      untitledSongTitle(1),
      '그 사랑',
      '우리가 넉넉히 이기느니라',
      '임재',
    ]);
    expect(info?.songs[0].description).toContain('은혜를 고백');
    // The unnamed bullet's text never runs on into the song above it.
    expect(info?.songs[1].description).not.toContain('은혜를 고백');
  });

  it('does not take a stray page number for a song', () => {
    const info = parseCoverText(handwrittenCover(['1 매일매일 A', '2 청년의 기도 F', '1']));
    expect(info?.songs.map((s) => s.title)).toEqual(['매일매일', '청년의 기도']);
  });

  it('reads a number and title whose key cell came out on the next line', () => {
    const info = parseCoverText(handwrittenCover(['1 주님의 은혜 넘치네', 'G', ...rest]));
    expect(info?.songs.map((s) => [s.title, s.key])).toEqual([
      ['주님의 은혜 넘치네', 'G'],
      ['그 사랑', 'G'],
      ['우리가 넉넉히 이기느니라', 'A'],
      ['임재', 'G'],
    ]);
  });

  it('does not take a numbered note under the table for a song', () => {
    const info = parseCoverText(handwrittenCover(['1 G', ...rest, '5 분 기도 후 마무리']));
    expect(info?.songs.map((s) => s.title)).toEqual([
      untitledSongTitle(1),
      '그 사랑',
      '우리가 넉넉히 이기느니라',
      '임재',
    ]);
  });

  it('pairs the unnamed row with the first score page', () => {
    const info = parseCoverText(handwrittenCover(['1 G', ...rest]))!;
    const pageTexts = ['cover', '', '', '', ''];
    matchSongsToPages(info, pageTexts, [2, 3, 4, 5]);
    expect(info.songs.map((s) => s.pageIndex)).toEqual([2, 3, 4, 5]);
  });

  it('finds a title the PDF drew last, in its row between the number and the key', () => {
    // The handwriting font came out after the whole page, so the text read
    // the row as `1 G` — but the title still sits in row 1 on the page.
    const info = parseCoverText(handwrittenCover(['1 G', ...rest]))!;
    const at = (str: string, x: number, y: number, size = 10.5) => ({ str, x, y, width: str.length * size, size });
    nameUntitledRowsFromLayout(info, [
      {
        width: 595,
        height: 842,
        items: [
          // `1. 말씀 묵상` has a number but no key beside it: not a table row.
          at('1.', 40, 700),
          at('말씀 묵상', 60, 700),
          at('1', 150, 500),
          at('G', 440, 500),
          at('2', 150, 480),
          at('그 사랑', 270, 480),
          at('G', 440, 480),
          // Larger, and on a baseline of its own.
          at('주님의 은혜 넘치네', 230, 503, 18),
        ],
      },
    ]);
    expect(info.songs.map((s) => s.title)).toEqual(['주님의 은혜 넘치네', '그 사랑', '우리가 넉넉히 이기느니라', '임재']);
  });

  it('keeps the placeholder when the row really holds no text', () => {
    const info = parseCoverText(handwrittenCover(['1 G', ...rest]))!;
    const at = (str: string, x: number, y: number) => ({ str, x, y, width: str.length * 10.5, size: 10.5 });
    nameUntitledRowsFromLayout(info, [
      { width: 595, height: 842, items: [at('1', 150, 500), at('G', 440, 500), at('2', 150, 480), at('그 사랑', 270, 480)] },
    ]);
    expect(info.songs[0].title).toBe(untitledSongTitle(1));
  });

  it('leaves the typed table exactly as it read before', () => {
    expect(parseCoverText(coverTableText)?.songs.map((s) => [s.title, s.key])).toEqual([
      ['매일매일', 'A'],
      ['청년의 기도', 'F -> Gb'],
      ['어려운 일 당할 때', 'F -> Ab -> G'],
      ['입례', 'F -> G'],
    ]);
  });
});

describe('parseCoverText — Plan A, with a Plan B after it', () => {
  // Laid out like the 2026.10.04 conti: the Plan A table, its commentary
  // (the first bullet mistyping the title), then a Plan B with no order
  // column, and a tablet's reading of handwriting drawn after everything.
  const cover = [
    '예배 찬양 콘티',
    '본문 | 로마서 8 장 31 – 39 절',
    '주제 | 끝까지 흔들리지 않을 이유',
    '날짜 | 2026.10.04',
    '1. 말씀 묵상',
    '하나님의 사랑에서 우리를 끊을 수 없습니다.',
    '2. 찬양 콘티 (Plan A)',
    '순서 찬양 키',
    '1 주 신실하심 놀라워 G',
    '2 그 사랑 G',
    '3 우리가 넉넉히 이기느니라 A',
    '4 임재 G',
    '• 주 신실하신 놀라워 (G Key)',
    'o 하나님의 사랑과 은혜는 결코 우리를 놓지',
    '않으십니다.',
    '• 그 사랑 (G key)',
    'o 변함 없으신 사랑입니다.',
    '• 우리가 넉넉히 이기느니라 (A key)',
    'o 로마서 8 장의 내용입니다.',
    '주업의은혜 넘치네',
    '예넘지네',
    '3. 찬양 콘티 (PLAN B)',
    '찬양 키',
    '예수 피를 힘입어 G',
    '그 사랑 얼마나 G',
    '• 예수 피를 힘입어 (G key)',
    'o 보혈에 힘입어 나아갑니다.',
    '• 그 사랑 얼마나(G key)',
    'o 영혼을 채워 주십니다.',
    '4. 본문',
    '31. 그런즉 이 일에 대하여 우리가 무슨 말 하리요',
  ].join('\n');
  const info = parseCoverText(cover);

  it('lists the Plan A songs in their order, and nothing else', () => {
    expect(info?.songs.map((s) => [s.title, s.key])).toEqual([
      ['주 신실하심 놀라워', 'G'],
      ['그 사랑', 'G'],
      ['우리가 넉넉히 이기느니라', 'A'],
      ['임재', 'G'],
    ]);
  });

  it('gives a mistyped bullet to the row it describes instead of adding a song', () => {
    expect(info?.songs[0].description).toContain('결코 우리를 놓지 않으십니다.');
  });

  it('keeps text drawn after a finished description out of it', () => {
    expect(info?.songs[2].description).toBe('로마서 8 장의 내용입니다.');
  });

  it('still reads the service fields', () => {
    expect(info?.date).toBe('2026.10.04');
    expect(info?.sermonTitle).toBe('끝까지 흔들리지 않을 이유');
    expect(info?.scripture).toBe('로마서 8 장 31 – 39 절');
  });

  it('takes a second plan when it is the only one written', () => {
    const planB = parseCoverText(['날짜 | 2026.10.04', '찬양 콘티 (Plan B)', '순서 찬양 키', '1 첫째 곡 G'].join('\n'));
    expect(planB?.songs.map((s) => s.title)).toEqual(['첫째 곡']);
  });

  it('does not join a song a bullet names when the table lists the order', () => {
    const withExtra = parseCoverText(
      ['날짜 | 2026.10.04', '순서 찬양 키', '1 첫째 곡 G', '• 첫째 곡 (G Key)', '• 다른 곡 (A Key)'].join('\n'),
    );
    expect(withExtra?.songs.map((s) => s.title)).toEqual(['첫째 곡']);
  });

  it('does not mistake a different song for a typo of a short title', () => {
    const titles = parseCoverText(
      ['날짜 | 2026.10.04', '순서 찬양 키', '1 그 사랑 G', '• 그 사랑 얼마나 (G Key)', 'o 다른 곡입니다.'].join('\n'),
    )?.songs;
    expect(titles?.map((s) => s.title)).toEqual(['그 사랑']);
    expect(titles?.[0].description).toBeUndefined();
  });
});

describe('parseSermonInfoText', () => {
  it('reads labeled sermon metadata without requiring a song list', () => {
    expect(parseSermonInfoText('설교 제목: “믿음으로 걷기”\n본문: 히브리서 11장 1-3절')).toEqual({
      sermonTitle: '믿음으로 걷기',
      scripture: '히브리서 11장 1-3절',
    });
  });

  it('does not guess a sermon title from unrelated page text', () => {
    expect(parseSermonInfoText('주님의 사랑\n가사 한 줄')).toEqual({
      sermonTitle: undefined,
      scripture: undefined,
    });
  });
});

describe('findCoverPages', () => {
  it('reads a cover that spans two pages as one document', () => {
    // 어려운 일 당할 때 is a table row on page 1 and a commentary bullet on
    // page 2. Parsing the pages separately loses the pairing, and the song
    // keeps its order number but never gains its description.
    const pages = [coverTableText, continuationText, 'I - V - C - junk OCR'];
    expect(findCoverPages(pages)).toEqual([1, 2]);

    const cover = parseCoverText(findCoverPages(pages).map((page) => pages[page - 1]).join('\n'));
    const hard = cover?.songs.find((song) => song.title === '어려운 일 당할 때');
    expect(hard?.key).toBe('F -> Ab -> G');
    expect(hard?.description).toContain('하나님은 우리와 함께');
  });

  it('stops at one page when nothing follows the cover', () => {
    expect(findCoverPages([coverText, 'I - V - C - junk OCR'])).toEqual([1]);
  });

  it('has no cover to find in a conti of nothing but scores', () => {
    expect(findCoverPages(['I - V - C', 'I - V - C'])).toEqual([]);
  });

  it('follows a write-up that runs onto a third page', () => {
    // The tail of the commentary: too little prose to read as an information
    // page on its own, but its `• 제목 (Key)` bullets are cover marks all the
    // same. Left out of the cover it would be recognized as a fourth song.
    const bulletTail = ['\u2022 \uc785\ub840 (F -> G)', 'o \uc785\ub840\uacf1\uc785\ub2c8\ub2e4.'].join('\n');
    const pages = [coverTableText, continuationText, bulletTail, 'I - V - C - junk OCR'];
    expect(findCoverPages(pages)).toEqual([1, 2, 3]);
  });

  it('ends the cover at the first page of sheet music', () => {
    // A write-up page that turns up AFTER the scores have started is not part
    // of the cover — the cover is the leading run, not every typed page.
    expect(findCoverPages([coverTableText, 'I - V - C - junk OCR', continuationText])).toEqual([1]);
  });
});

describe('continuesCover', () => {
  it('stops at a score page', () => {
    expect(continuesCover('I - V - C - junk OCR')).toBe(false);
    // A lyric line opening with 말씀 matches the 본문 label; only a real
    // chapter/verse after it makes the page part of the write-up.
    expect(continuesCover('\ub9d0\uc500 \uadf8\ub300\ub85c \uc0b4\uc544\uac00\ub9ac\ub77c')).toBe(false);
    expect(continuesCover('\ubcf8\ubb38 | \uc804\ub3c4\uc11c 12\uc7a5 1-8\uc808')).toBe(true);
  });

  it('never takes the session-notes page for part of the cover', () => {
    // It repeats the song list, and parseCoverText refuses any text with it.
    expect(continuesCover(notesText)).toBe(false);
  });
});

describe('classifyPages', () => {
  it('identifies cover, notes, and music pages', () => {
    const { coverIndex, notesIndex, musicPages } = classifyPages([
      coverText,
      notesText,
      'junk music one',
      'junk music two',
    ]);
    expect(coverIndex).toBe(1);
    expect(notesIndex).toBe(2);
    expect(musicPages).toEqual([3, 4]);
  });

  it('reads a two-page cover as one cover, not as a score page', () => {
    // The 08.09.26 conti runs its write-up onto a second page. Left in
    // musicPages it would be matched to 어려운 일 당할 때, then dropped as a
    // non-score page — taking the song with it.
    const { coverPages, coverIndex, infoPages, musicPages } = classifyPages([
      coverTableText,
      continuationText,
      'I - V - C - junk OCR',
    ]);
    expect(coverPages).toEqual([1, 2]);
    expect(coverIndex).toBe(1);
    expect(infoPages).toEqual([]);
    expect(musicPages).toEqual([3]);
  });

  it('never looks past the second page for a cover', () => {
    // A score page whose OCR happens to carry both sermon fields would
    // otherwise be taken for the cover, and a wrong cover takes the whole
    // song list with it.
    const lateCoverShapedPage = ['설교: 뒤늦게 나온 제목', '본문: 시편 1편 1-6절'].join('\n');
    const { coverPages, musicPages } = classifyPages([
      'I - V - C - junk OCR',
      'I - V - C - junk OCR',
      lateCoverShapedPage,
    ]);
    expect(coverPages).toEqual([]);
    expect(musicPages).toEqual([1, 2, 3]);
  });

  it('finds a sparse cover by its sermon title and 본문 sitting together', () => {
    // Too little prose to look like an information page and no key column for
    // the song table, so without the paired sermon fields this page would fall
    // through to musicPages and be recognized as an imaginary song.
    const sparseCover = [
      '2026.08.09',
      '설교 제목: 청년의 때',
      '본문: 전도서 12장 1-8절',
      '1. 매일매일',
      '2. 청년의 기도',
    ].join('\n');
    const { coverPages, musicPages } = classifyPages([sparseCover, 'I - V - C - junk OCR']);
    expect(coverPages).toEqual([1]);
    expect(musicPages).toEqual([2]);
  });

  it('does not call a page a cover on one sermon field alone', () => {
    // 본문 turns up on its own all over a conti — in the printed-passage
    // section, and in OCR noise. Only the pair identifies the cover.
    expect(looksLikeCoverText('본문: 전도서 12장 1-8절')).toBe(false);
    expect(looksLikeCoverText('설교 제목: 청년의 때')).toBe(false);
    expect(looksLikeCoverText('설교 제목: 청년의 때\n본문: 전도서 12장 1-8절')).toBe(true);
  });

  it('takes the cover from page 2 when page 1 is a blank title page', () => {
    const { coverPages, musicPages } = classifyPages([
      '   ',
      '설교 제목: 청년의 때\n본문: 전도서 12장 1-8절',
      'I - V - C - junk OCR',
    ]);
    expect(coverPages).toEqual([2]);
    expect(musicPages).toEqual([1, 3]);
  });

  it('starts the music pages at the first score page, however long the cover', () => {
    const bulletTail = ['\u2022 \uc785\ub840 (F -> G)', 'o \uc785\ub840\uacf1\uc785\ub2c8\ub2e4.'].join('\n');
    const { coverPages, musicPages } = classifyPages([
      coverTableText,
      continuationText,
      bulletTail,
      'I - V - C - junk one',
      'I - V - C - junk two',
    ]);
    expect(coverPages).toEqual([1, 2, 3]);
    expect(musicPages).toEqual([4, 5]);
  });

  it('leaves a score page with a lyric text layer alone', () => {
    // Prose volume alone must not exclude a page — it needs a structural mark.
    const lyricTextLayer = Array.from({ length: 40 }, () => '주님의 사랑이 나를 채우시네').join('\n');
    expect(looksLikeInfoPage(lyricTextLayer)).toBe(false);
    expect(looksLikeInfoPage(continuationText)).toBe(true);
  });
});

describe('matchSongsToPages', () => {
  it('matches by title text when present, else sequentially', () => {
    const info = parseCoverText(coverText)!;
    const pageTexts = [coverText, notesText, 'garbled', '주 은혜임을 KaMU', 'garbled 2'];
    matchSongsToPages(info, pageTexts, [3, 4, 5]);
    // 주 은혜임을 finds its page by text; the others fill remaining pages in order.
    expect(info.songs.find((s) => s.title === '주 은혜임을')?.pageIndex).toBe(4);
    expect(info.songs.find((s) => s.title === '주님의 사랑')?.pageIndex).toBe(3);
    expect(info.songs.find((s) => s.title === '입례')?.pageIndex).toBe(5);
  });
});

describe('deriveSongsFromMusicPages', () => {
  const library: LibraryEntry[] = [
    { title: '주 은혜임을', key: 'F', sections: [{ label: 'C', lines: ['가사'] }], order: ['C'] },
  ];

  it('builds one song per music page, in page order', () => {
    const pageTexts = ['garbled', '주 은혜임을 KaMU', 'garbled 2'];
    const songs = deriveSongsFromMusicPages(pageTexts, [1, 2, 3], library);
    expect(songs.map((s) => s.pageIndex)).toEqual([1, 2, 3]);
  });

  it('matches the library by page text and stubs the rest', () => {
    const pageTexts = ['garbled', '주 은혜임을 KaMU', 'garbled 2'];
    const songs = deriveSongsFromMusicPages(pageTexts, [1, 2, 3], library);
    expect(songs[1]).toMatchObject({ title: '주 은혜임을', key: 'F', pageIndex: 2 });
    expect(songs[0].title).toBe('새 찬양 (p.1)');
    expect(songs[2].title).toBe('새 찬양 (p.3)');
  });

  it('splits off a derived 공동체 고백송 when its page text matches', () => {
    const withConfession: LibraryEntry[] = [
      ...library,
      { title: 'Celebrate the Light', key: 'G', sections: [{ label: 'C', lines: ['가사'] }], order: ['C'] },
    ];
    const songs = deriveSongsFromMusicPages(['a', 'Celebrate the Light', 'c'], [1, 2, 3], withConfession);
    const { lyricsSongs, confessionSong } = splitLyricsAndConfessionSongs(songs);
    expect(lyricsSongs.map((s) => s.pageIndex)).toEqual([1, 3]);
    expect(confessionSong?.pageIndex).toBe(2);
  });
});

describe('splitLyricsAndConfessionSongs', () => {
  it('excludes Celebrate the Light (공동체 고백송) wherever it appears', () => {
    const songs = [
      { title: '주님의 사랑', key: 'E' },
      { title: 'Celebrate The Light!', key: 'G' },
      { title: '입례', key: 'F' },
    ];
    const { lyricsSongs, confessionSong } = splitLyricsAndConfessionSongs(songs);
    expect(lyricsSongs.map((song) => song.title)).toEqual(['주님의 사랑', '입례']);
    expect(confessionSong?.title).toBe('Celebrate The Light!');
  });

  it('keeps every song — including a final 입례 — when the 고백송 is absent', () => {
    const info = parseCoverText(coverText)!;
    const { lyricsSongs, confessionSong } = splitLyricsAndConfessionSongs(info.songs);
    expect(lyricsSongs.map((song) => song.title)).toEqual(['주님의 사랑', '주 은혜임을', '입례']);
    expect(confessionSong).toBeUndefined();
  });

  it('takes the 고백송 named in 관리자 설정 instead of the default', () => {
    const songs = [
      { title: '주님의 사랑', key: 'E' },
      { title: '나의 반석이신 하나님', key: 'G' },
      { title: 'Celebrate the Light', key: 'G' },
    ];
    const { lyricsSongs, confessionSong } = splitLyricsAndConfessionSongs(songs, '나의 반석이신 하나님');
    expect(confessionSong?.title).toBe('나의 반석이신 하나님');
    expect(lyricsSongs.map((song) => song.title)).toEqual(['주님의 사랑', 'Celebrate the Light']);
  });

  it('recognizes a cover that names the slot rather than the song', () => {
    const songs = [{ title: '주님의 사랑' }, { title: '공동체 고백송' }, { title: '축복하노라' }];
    const { confessionSong, postSermonSong } = splitLyricsAndConfessionSongs(songs);
    expect(confessionSong?.title).toBe('공동체 고백송');
    expect(postSermonSong?.title).toBe('축복하노라');
  });

  it('reads the song after the 고백송 as the 설교 후 찬양', () => {
    const songs = [
      { title: '주님의 사랑', key: 'E' },
      { title: 'Celebrate the Light', key: 'G' },
      { title: '축복하노라', key: 'F' },
      { title: '입례', key: 'F' },
    ];
    const { lyricsSongs, postSermonSong } = splitLyricsAndConfessionSongs(songs);
    expect(postSermonSong?.title).toBe('축복하노라');
    // It still needs generated lyric slides — only its position in the deck
    // differs, so it stays in the list the 찬양 step edits.
    expect(lyricsSongs.map((song) => song.title)).toEqual(['주님의 사랑', '축복하노라', '입례']);
  });

  it('leaves the 설교 후 찬양 unset when the 고백송 is last or absent', () => {
    expect(
      splitLyricsAndConfessionSongs([{ title: '주님의 사랑' }, { title: 'Celebrate the Light' }])
        .postSermonSong,
    ).toBeUndefined();
    expect(
      splitLyricsAndConfessionSongs([{ title: '주님의 사랑' }, { title: '입례' }]).postSermonSong,
    ).toBeUndefined();
  });

  it('handles an empty conti', () => {
    expect(splitLyricsAndConfessionSongs([])).toEqual({ lyricsSongs: [] });
  });
});

describe('parseCoverText 진행 순서', () => {
  it('takes the part order written in a song description', () => {
    const info = parseCoverText(
      ['7/11/26', '본문: 로마서 5장 1-11절', '주님의 사랑 (E): 고백의 찬양 I-V1-C-V2-C-B-C', '주 은혜임을 (F): 은혜의 찬양'].join('\n'),
    );
    expect(info?.songs[0].order).toEqual(['I', 'V1', 'C', 'V2', 'C', 'B', 'C']);
    expect(info?.songs[1].order).toBeUndefined();
  });

  it('takes an order written on the line under the song', () => {
    const info = parseCoverText(
      ['7/11/26', '본문: 로마서 5장 1-11절', '주님의 사랑 (E): 고백의 찬양', '진행: V1-PC-C-B-C'].join('\n'),
    );
    expect(info?.songs[0].order).toEqual(['V1', 'PC', 'C', 'B', 'C']);
  });

  it('reads the order under a table cover bullet', () => {
    const info = parseCoverText(
      [
        '본문 | 전도서 12 장 1-8 절',
        '날짜 | 2026.08.09',
        '2. 찬양 콘티',
        '순서 찬양 키',
        '1 매일매일 A',
        '• 매일매일 (A Key)',
        'o 결단의 찬양입니다. I-V-C-V-C-B-C',
      ].join('\n'),
    );
    expect(info?.songs[0].order).toEqual(['I', 'V', 'C', 'V', 'C', 'B', 'C']);
  });

  it('leaves the fixture covers without an order', () => {
    expect(parseCoverText(coverText)?.songs.every((song) => song.order === undefined)).toBe(true);
  });
});

describe('dateFromFileName', () => {
  const today = new Date(2026, 8, 26);
  it('reads the date a conti file is named with', () => {
    expect(dateFromFileName('2026-10-03 찬양집회.pdf', today)).toBe('2026.10.03');
    expect(dateFromFileName('praise_20261003.pdf', today)).toBe('2026.10.03');
    expect(dateFromFileName('9_27_EM__KM.pptx', today)).toBe('2026.09.27');
    expect(dateFromFileName('10.3 콘티.pdf', today)).toBe('2026.10.03');
  });

  it('finds none where the name holds no date', () => {
    expect(dateFromFileName('EM_KM_Praise_Night_Chord_Sheets_1.pdf', today)).toBeUndefined();
    expect(dateFromFileName('13_40_scan.pdf', today)).toBeUndefined();
  });
});
