import { describe, expect, it } from 'vitest';
import {
  AUTO_MARGIN,
  MIN_LYRIC_EVIDENCE,
  containment,
  nameSimilarity,
  normalizeSample,
  rankLyricsCandidates,
  scoreLyricsCandidate,
} from '../../worker/src/lyricsCandidates.js';
import type { LyricsCandidate, LyricsQuery } from '../../worker/src/lyrics.js';

const RECOGNIZED = ['빛으로 인도하시네', '영원히 노래하리', '높이 부르는 이름'];

const query: LyricsQuery = {
  title: '은혜의 노래',
  artist: '새로운 팀',
  sample: normalizeSample(RECOGNIZED.join('')),
};

function candidate(overrides: Partial<LyricsCandidate> = {}): LyricsCandidate {
  return {
    id: 'ccm:ccm.co.kr/song/1',
    title: '은혜의 노래',
    artist: '새로운 팀',
    lines: [...RECOGNIZED],
    url: 'https://ccm.co.kr/song/1',
    host: 'ccm.co.kr',
    source: 'ccm',
    sourceTrust: 0.9,
    ...overrides,
  };
}

/** Same title, completely different song — the case this scoring exists for. */
const sameTitleWrongSong = candidate({
  id: 'ccm:ccm.co.kr/song/2',
  artist: '다른 사역팀',
  lines: ['전혀 다른 노래의 첫 줄', '상관없는 둘째 줄', '이어지는 셋째 줄'],
  url: 'https://ccm.co.kr/song/2',
});

describe('scoreLyricsCandidate', () => {
  it('never auto-selects a title-only match', () => {
    const result = scoreLyricsCandidate(query, sameTitleWrongSong);
    expect(result.decision).not.toBe('auto');
  });

  it('rejects a page with no recognized-lyric evidence at all', () => {
    // Title and artist can both match while the page holds a different song.
    const result = scoreLyricsCandidate(query, { ...sameTitleWrongSong, artist: '새로운 팀' });
    expect(result.lyricsScore).toBeLessThan(MIN_LYRIC_EVIDENCE);
    expect(result.decision).toBe('reject');
  });

  it('scores title, artist and lyric evidence separately', () => {
    const result = scoreLyricsCandidate(query, candidate());
    expect(result.titleScore).toBe(1);
    expect(result.artistScore).toBe(1);
    expect(result.lyricsScore).toBeCloseTo(1, 3);
    expect(result.score).toBeGreaterThan(0.95);
  });

  it('shifts the artist weight onto the lyrics when no artist is known', () => {
    const noArtist = scoreLyricsCandidate({ ...query, artist: '' }, candidate({ artist: undefined }));
    expect(noArtist.artistScore).toBe(0);
    // Still a full-marks match: the missing field's weight went somewhere.
    expect(noArtist.score).toBeGreaterThan(0.95);
  });

  it('drops a page whose lyrics only partly overlap what was recognized', () => {
    const partial = candidate({ lines: ['빛으로 인도하시네', '완전히 다른 둘째 줄', '또 다른 셋째 줄'] });
    const result = scoreLyricsCandidate(query, partial);
    expect(result.lyricsScore).toBeLessThan(1);
    expect(result.decision).not.toBe('auto');
  });

  it('cannot be pushed to auto by source trust alone', () => {
    const trusted = scoreLyricsCandidate(query, { ...sameTitleWrongSong, sourceTrust: 1 });
    expect(trusted.decision).toBe('reject');
  });
});

describe('rankLyricsCandidates', () => {
  it('auto-selects a strong title artist and lyric match with a clear margin', () => {
    const strong = candidate();
    const weaker = candidate({
      id: 'naver:blog.naver.com/post',
      title: '은혜의 노래 (다른 편곡)',
      artist: '다른 사역팀',
      lines: ['빛으로 인도하시네', '전혀 다른 둘째 줄'],
      url: 'https://blog.naver.com/post',
      host: 'blog.naver.com',
      source: 'naver-blog',
      sourceTrust: 0.65,
    });

    const ranked = rankLyricsCandidates(query, [strong, weaker]);

    expect(ranked[0]).toMatchObject({ decision: 'auto' });
    expect(ranked[0].score - ranked[1].score).toBeGreaterThanOrEqual(AUTO_MARGIN);
  });

  it('leaves two near-identical candidates for the user to choose between', () => {
    // Within the margin at least one of them is probably the wrong song.
    const first = candidate();
    const second = candidate({ id: 'ccmpia:x', url: 'https://ccmpia.com/x', host: 'ccmpia.com', source: 'ccmpia' });
    const ranked = rankLyricsCandidates(query, [first, second]);
    expect(ranked[0].decision).toBe('review');
    expect(ranked[1].decision).toBe('review');
  });

  it('caps the list at three and orders it best first', () => {
    const many = Array.from({ length: 6 }, (_, index) =>
      candidate({ id: `ccm:${index}`, sourceTrust: 0.5 + index * 0.05 }),
    );
    const ranked = rankLyricsCandidates(query, many);
    expect(ranked).toHaveLength(3);
    expect(ranked.map((entry) => entry.score)).toEqual([...ranked.map((entry) => entry.score)].sort((a, b) => b - a));
  });

  it('promotes nothing when every candidate was rejected', () => {
    const ranked = rankLyricsCandidates(query, [sameTitleWrongSong]);
    expect(ranked[0].decision).toBe('reject');
  });
});

describe('matching primitives', () => {
  it('measures containment against the sample, not the page', () => {
    // A page holding the whole song plus a write-up still fully contains it.
    expect(containment('가나다', '가나다라마바사아자차')).toBe(1);
    expect(containment('가나다', '가')).toBeCloseTo(1 / 3, 6);
    expect(containment('', '가나다')).toBe(0);
  });

  it('ignores spacing and punctuation when comparing names', () => {
    expect(nameSimilarity('은혜의 노래', '은혜의노래!')).toBe(1);
    expect(nameSimilarity('은혜의 노래', '')).toBe(0);
    expect(nameSimilarity('은혜의 노래', '전혀 다른 제목')).toBeLessThan(0.5);
  });

  it('caps the sample so a whole song never leaves the browser', () => {
    expect(normalizeSample('가'.repeat(1000))).toHaveLength(300);
    expect(normalizeSample('은혜의 노래!')).toBe('은혜의노래');
  });
});
