import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  classifyPages,
  deriveSongsFromMusicPages,
  looksLikeInfoPage,
  matchSongsToPages,
  parseCoverText,
  parseSermonInfoText,
  splitLyricsAndConfessionSongs,
} from '../../src/lib/utils/contiText';
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

  it('keeps a typed cover continuation out of the score pages', () => {
    // The 08.09.26 conti runs its write-up onto a second page. Left in
    // musicPages it would be matched to 어려운 일 당할 때, then dropped as a
    // non-score page — taking the song with it.
    const { coverIndex, infoPages, musicPages } = classifyPages([
      coverTableText,
      continuationText,
      'I - V - C - junk OCR',
    ]);
    expect(coverIndex).toBe(1);
    expect(infoPages).toEqual([2]);
    expect(musicPages).toEqual([3]);
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

  it('handles an empty conti', () => {
    expect(splitLyricsAndConfessionSongs([])).toEqual({ lyricsSongs: [] });
  });
});
