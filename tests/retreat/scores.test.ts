import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ParsedScore } from '../../src/lib/ai/scoreParser';
import {
  applyScoreSongs,
  matchKnownTitle,
  retreatScorePages,
  scoreLyricsText,
  titleInPageText,
  titlesWithoutLyrics,
} from '../../src/retreat/scores';
import { resolveSong } from '../../src/retreat/songs';
import { decodeRetreatSource, encodeRetreatSource } from '../../src/retreat/source';
import { defaultRetreat, type RetreatState } from '../../src/retreat/types';

// Every model call is answered here, one made-up page reading per image.
const recognize = vi.fn();
vi.mock('../../src/lib/ai/adaptiveRecognition', () => ({
  recognizeAdaptiveBatch: (...args: unknown[]) => recognize(...args),
}));
vi.mock('../../src/lib/ai/aiSettings', () => ({ getSyncedAiSettings: async () => ({ attempts: [] }) }));
vi.mock('../../src/lib/learning/learningClient', () => ({ fetchModelReliabilities: async () => [] }));

const { readRetreatScores } = await import('../../src/retreat/scoreReader');

const root = join(__dirname, '..', '..');
const contiText = readFileSync(join(root, 'tests', 'fixtures', 'retreat-conti.txt'), 'utf8');

/** Invented lyrics — no real 악보 belongs in a fixture. */
function reading(title: string, overrides: Partial<ParsedScore> = {}): ParsedScore {
  return {
    pageType: 'score',
    title,
    order: ['V', 'C'],
    sections: [
      { label: 'V', lines: ['가나다라 마바사', '아자차카 타파하'] },
      { label: 'C', lines: ['높이 높이 노래해'] },
    ],
    ...overrides,
  };
}

function withSongs(titles: Record<string, string>): RetreatState {
  const state = defaultRetreat();
  const block = state.sessions[0].blocks.find((candidate) => candidate.kind === 'songs')!;
  if (block.kind === 'songs') {
    block.songs = Object.entries(titles).map(([title, lyrics], index) => ({ id: `s${index}`, title, lyrics }));
  }
  return state;
}

function page(label: string, text = '') {
  return { label, text, render: async () => `data:image/png;base64,${label}` };
}

describe('retreatScorePages', () => {
  it('leaves the song table out and keeps the pages after it', () => {
    expect(retreatScorePages([contiText, '', '주 안에서 기뻐해 1. 주님 주신 기쁨'])).toEqual([2, 3]);
  });
});

describe('titles', () => {
  it('finds the longest known title a text layer prints', () => {
    expect(titleInPageText('주님의 임재 앞에서 Key=G 1. 가나다', ['임재', '주님의 임재 앞에서'])).toBe('주님의 임재 앞에서');
    expect(titleInPageText('', ['임재'])).toBeUndefined();
    expect(titleInPageText('주님의 시선 머무는 곳', ['시선'], 3)).toBeUndefined();
  });

  it('forgives a misread syllable against the table, not against the long lists', () => {
    expect(matchKnownTitle('주님 임재 앞에서', ['주님의 임재 앞에서'], [])).toBe('주님의 임재 앞에서');
    expect(matchKnownTitle('주님 임재 앞에서', [], ['주님의 임재 앞에서'])).toBeUndefined();
    expect(matchKnownTitle('시선', [], ['내게로부터 눈을 들어 (시선)'])).toBe('내게로부터 눈을 들어 (시선)');
  });
});

describe('score lyrics', () => {
  it('lays a reading out in its printed order', () => {
    expect(scoreLyricsText(reading('x', { order: ['C', 'V'] }))).toBe('높이 높이 노래해\n\n가나다라 마바사\n아자차카 타파하');
    expect(scoreLyricsText(reading('x', { sections: [] }))).toBe('');
  });

  it('fills only songs without lyrics, and keeps the list without repeats', () => {
    const state = withSongs({ '낮은 자의 하나님': '', '모두 찬양해': '이미 있는 가사' });
    expect(titlesWithoutLyrics(state)).toEqual(['낮은 자의 하나님']);
    const { state: next, filled } = applyScoreSongs(state, [
      { title: '낮은자의 하나님', lyrics: '' },
      { title: '낮은 자의 하나님', lyrics: '읽은 가사' },
      { title: '모두 찬양해', lyrics: '다른 가사' },
    ]);
    expect(filled).toEqual(['낮은 자의 하나님']);
    const songs = next.sessions[0].blocks.find((block) => block.kind === 'songs');
    expect(songs?.kind === 'songs' && songs.songs.map((song) => [song.lyrics, song.source])).toEqual([
      ['읽은 가사', 'score'],
      ['이미 있는 가사', undefined],
    ]);
    expect(next.scoreSongs).toEqual([
      { title: '낮은 자의 하나님', lyrics: '읽은 가사' },
      { title: '모두 찬양해', lyrics: '다른 가사' },
    ]);
  });

  it('is a lyrics source after last year and the library, and survives the snapshot', () => {
    const scoreSongs = [{ title: '새 노래', lyrics: '읽은 가사' }];
    expect(resolveSong('새 노래', [], [], scoreSongs)).toMatchObject({ lyrics: '읽은 가사', source: 'score' });
    const seeded = resolveSong('새 노래', [{ title: '새 노래', slides: [['작년 가사']] }], [], scoreSongs);
    expect(seeded).toMatchObject({ lyrics: '작년 가사', source: 'retreat' });

    const state = { ...defaultRetreat(), scoreSongs };
    expect(decodeRetreatSource(encodeRetreatSource(state))!.state.scoreSongs).toEqual(scoreSongs);
    const legacy = JSON.parse(new TextDecoder().decode(encodeRetreatSource(defaultRetreat()).data));
    delete legacy.state.scoreSongs;
    expect(decodeRetreatSource({ name: 's', data: new TextEncoder().encode(JSON.stringify(legacy)).buffer as ArrayBuffer })!.state.scoreSongs).toEqual([]);
  });
});

describe('readRetreatScores', () => {
  beforeEach(() => {
    recognize.mockReset();
  });

  it('with a table, reads titles off scans and lyrics only for the table songs still without them', async () => {
    recognize.mockImplementation(async (urls: string[], _settings: unknown, mode: string) => ({
      scores: urls.map((url) => {
        const label = url.split(',')[1];
        if (label === 'cover') return { ...reading(''), pageType: 'non_score' };
        const title = { a: '낮은자의 하나님', b: '모두 찬양해', c: '다른 곡' }[label] ?? '';
        return mode === 'titles' ? { title, order: [], sections: [] } : reading(title);
      }),
    }));
    const result = await readRetreatScores([page('cover'), page('a'), page('b'), page('c'), page('t', '주가 일하시네 1. 가나다')], {
      tableTitles: ['낮은 자의 하나님', '모두 찬양해', '주가 일하시네'],
      knownTitles: [],
      needsLyrics: (title) => title === '낮은 자의 하나님',
      readUntitled: false,
    });

    const modes = recognize.mock.calls.map((call) => [call[2], (call[0] as string[]).map((url) => url.split(',')[1])]);
    // The page whose text layer names its song is never sent; only one page is read in full.
    expect(modes).toEqual([
      ['titles', ['cover', 'a', 'b', 'c']],
      ['full', ['a']],
    ]);
    expect(recognize.mock.calls[1][3]).toEqual(['낮은 자의 하나님']);
    expect(result.error).toBeUndefined();
    expect(result.songs.map((song) => song.title)).toEqual(['낮은 자의 하나님', '모두 찬양해', '다른 곡', '주가 일하시네']);
    expect(result.songs[0].lyrics).toContain('가나다라 마바사');
    expect(result.songs.slice(1).every((song) => !song.lyrics)).toBe(true);
  });

  it('without a table, reads every page with no known lyrics, a few pages per request', async () => {
    recognize.mockImplementation(async (urls: string[]) => ({
      scores: urls.map((url) => reading(`곡 ${url.split(',')[1]}`)),
    }));
    const pages = Array.from({ length: 8 }, (_, index) => page(String(index + 1)));
    const result = await readRetreatScores(pages, {
      tableTitles: [],
      knownTitles: [],
      needsLyrics: () => true,
      readUntitled: true,
    });
    expect(recognize.mock.calls.map((call) => [call[2], (call[0] as string[]).length])).toEqual([
      ['titles', 6],
      ['titles', 2],
      ['full', 6],
      ['full', 2],
    ]);
    expect(result.songs).toHaveLength(8);
    expect(result.songs.every((song) => song.lyrics.includes('높이 높이 노래해'))).toBe(true);
  });

  it('trusts the lyrics reading over a title a text layer only seemed to print', async () => {
    recognize.mockImplementation(async (urls: string[]) => ({ scores: urls.map(() => reading('주가 일하시네')) }));
    // "시선" is sung in this page's lyrics; the page is another song.
    const result = await readRetreatScores([page('a', '주님의 시선 머무는 곳 1. 가나다')], {
      tableTitles: ['시선', '주가 일하시네'],
      knownTitles: [],
      needsLyrics: () => true,
      readUntitled: false,
    });
    expect(recognize.mock.calls.map((call) => call[2])).toEqual(['full']);
    expect(result.songs).toEqual([{ title: '주가 일하시네', lyrics: expect.stringContaining('가나다라 마바사') }]);
  });

  it('keeps what the text layers said when the models cannot be reached', async () => {
    recognize.mockRejectedValue(new Error('자동 인식이 꺼져 있습니다.'));
    const result = await readRetreatScores([page('a', '모두 찬양해 1. 가나다'), page('b')], {
      tableTitles: [],
      knownTitles: ['모두 찬양해'],
      needsLyrics: () => false,
      readUntitled: true,
    });
    expect(result.error).toBe('자동 인식이 꺼져 있습니다.');
    expect(result.songs).toEqual([{ title: '모두 찬양해', lyrics: '' }]);
  });
});
