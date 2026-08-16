import { describe, expect, it } from 'vitest';
import {
  cleanLyricLine,
  coerceParsedScore,
  coerceParsedScoreBatch,
  parseScoreText,
  splitNumberedVerses,
} from '../../src/lib/ai/scoreParser';

describe('page classification metadata', () => {
  it('normalizes a non-score page and its sermon fields', () => {
    expect(
      coerceParsedScore({
        pageType: 'non-score',
        sermonTitle: '  믿음으로 걷기  ',
        scripture: ' 히브리서 11장 1-3절 ',
      }),
    ).toMatchObject({
      pageType: 'non_score',
      sermonTitle: '믿음으로 걷기',
      scripture: '히브리서 11장 1-3절',
      order: [],
      sections: [],
    });
  });

  it('preserves classification and sermon metadata in the title-only batch pass', () => {
    const [result] = coerceParsedScoreBatch(
      {
        results: [
          {
            imageIndex: 0,
            pageType: 'non_score',
            sermonTitle: '새 설교',
            scripture: '요한복음 3:16',
            sections: [{ label: 'C', lines: ['가사가 아님'] }],
          },
        ],
      },
      1,
      'titles',
    );
    expect(result).toMatchObject({
      pageType: 'non_score',
      sermonTitle: '새 설교',
      scripture: '요한복음 3:16',
      sections: [],
    });
  });
});

describe('cleanLyricLine', () => {
  it('joins syllable hyphens (with or without spaces) into natural words', () => {
    expect(cleanLyricLine('Ce-le-brate the light')).toBe('Celebrate the light');
    expect(cleanLyricLine('Ce - le - brate')).toBe('Celebrate');
    expect(cleanLyricLine('찬-양-해')).toBe('찬양해');
  });

  it('leaves ordinary spacing and dangling dashes alone', () => {
    expect(cleanLyricLine('온 세상 비추네')).toBe('온 세상 비추네');
    expect(cleanLyricLine('사랑 -')).toBe('사랑 -');
  });
});

describe('parseScoreText', () => {
  it('reads the order line at the top (starting with I) and the title', () => {
    const text = ['주님의 사랑 (E)', 'I-V1-V2-PC-C-C', '주님의 사랑을 표현하는'].join('\n');
    const parsed = parseScoreText(text);
    expect(parsed.title).toBe('주님의 사랑');
    expect(parsed.key).toBe('E');
    expect(parsed.order).toEqual(['I', 'V1', 'V2', 'PC', 'C', 'C']);
  });

  it('repairs an order line whose leading I was OCR-read as l/1/|', () => {
    expect(parseScoreText('l-V1-C-C').order).toEqual(['I', 'V1', 'C', 'C']);
    expect(parseScoreText('1 V1 C').order[0]).toBe('I');
  });

  it('divides lyrics by printed part labels when present', () => {
    const text = [
      '은혜',
      'I-V1-C-B-C',
      'V1',
      '내가 주를 사랑하는 이유',
      '그 사랑 때문에',
      'C',
      '은혜 은혜 하나님의 은혜',
      'B',
      '나를 향한 그 사랑',
    ].join('\n');
    const parsed = parseScoreText(text);
    const byLabel = Object.fromEntries(parsed.sections.map((s) => [s.label, s.lines]));
    expect(byLabel.V1).toEqual(['내가 주를 사랑하는 이유', '그 사랑 때문에']);
    expect(byLabel.C).toEqual(['은혜 은혜 하나님의 은혜']);
    expect(byLabel.B).toEqual(['나를 향한 그 사랑']);
  });

  it('scaffolds parts from the order when no labels are printed', () => {
    const text = ['빛 되신 주', 'I-V1-V2-C', '어둠에 빛을 비추사', '주의 사랑으로'].join('\n');
    const parsed = parseScoreText(text);
    expect(parsed.sections.map((s) => s.label)).toEqual(['V1', 'V2', 'C']);
    // Recognized lyric lines are seeded into the first part for redistribution.
    expect(parsed.sections[0].lines.length).toBeGreaterThan(0);
  });

  it('reads an unnumbered printed Korean label ("절", "후렴") as bare V/C, not V1/C1', () => {
    const text = [
      '은혜',
      'I-V-C',
      '절',
      '내가 주를 사랑하는 이유',
      '후렴',
      '은혜 은혜 하나님의 은혜',
    ].join('\n');
    const parsed = parseScoreText(text);
    expect(parsed.sections.map((s) => s.label)).toEqual(['V', 'C']);
  });

  it('falls back to a default scaffold with neither order nor labels, unnumbered since there is no printed 1/2 distinction', () => {
    const parsed = parseScoreText('그냥 제목 같은 줄\n가사 한 줄');
    expect(parsed.order).toEqual([]);
    expect(parsed.sections.map((s) => s.label)).toEqual(['V', 'C']);
  });
});

describe('stacked verses printed under one staff', () => {
  it('splits a section the model returned with the verse numbers still attached', () => {
    expect(
      splitNumberedVerses({
        label: 'V',
        lines: ['1. 주 사랑이 나를 숨쉬게 해', '2. 주 사랑이 나를 이끄시네', '1. 세상 그 어떤 어려움 속에도', '2. 내가 갈 수 없는 그 곳으로'],
      }),
    ).toEqual([
      { label: 'V', lines: ['주 사랑이 나를 숨쉬게 해', '세상 그 어떤 어려움 속에도'] },
      { label: 'V2', lines: ['주 사랑이 나를 이끄시네', '내가 갈 수 없는 그 곳으로'] },
    ]);
  });

  it('numbers any part family, not just verses, and keeps the first one bare', () => {
    expect(
      splitNumberedVerses({ label: 'C', lines: ['1) 첫 후렴', '2) 둘째 후렴', '3) 셋째 후렴'] }),
    ).toEqual([
      { label: 'C', lines: ['첫 후렴'] },
      { label: 'C2', lines: ['둘째 후렴'] },
      { label: 'C3', lines: ['셋째 후렴'] },
    ]);
  });

  it('strips a lone verse number instead of splitting on it', () => {
    expect(splitNumberedVerses({ label: 'V', lines: ['1. 한 절뿐인 노래', '이어지는 줄'] })).toEqual([
      { label: 'V', lines: ['한 절뿐인 노래', '이어지는 줄'] },
    ]);
  });

  it('leaves an already numbered label alone — that model split it itself', () => {
    expect(splitNumberedVerses({ label: 'V2', lines: ['1. 가사 하나', '2. 가사 둘'] })).toEqual([
      { label: 'V2', lines: ['가사 하나', '가사 둘'] },
    ]);
  });

  it('keeps lines printed before the first number with the first verse', () => {
    expect(splitNumberedVerses({ label: 'V', lines: ['앞선 줄', '1. 첫 절', '2. 둘째 절'] })).toEqual([
      { label: 'V', lines: ['앞선 줄', '첫 절'] },
      { label: 'V2', lines: ['둘째 절'] },
    ]);
  });

  it('applies the split while coercing a model payload, and reads lyricRowCount', () => {
    const parsed = coerceParsedScore({
      pageType: 'score',
      title: '주 사랑이 나를 숨쉬게 해',
      lyricRowCount: 2,
      order: ['I', 'V', 'V2'],
      sections: [{ label: 'V', lines: ['1. 첫 절 가사', '2. 둘째 절 가사'] }],
    });
    expect(parsed.lyricRowCount).toBe(2);
    expect(parsed.sections).toEqual([
      { label: 'V', lines: ['첫 절 가사'] },
      { label: 'V2', lines: ['둘째 절 가사'] },
    ]);
  });
});

describe('artist recognition', () => {
  it('keeps an artist the score printed, and drops a blank one', () => {
    expect(coerceParsedScore({ title: '은혜의 노래', artist: ' 새로운 팀 ' }).artist).toBe('새로운 팀');
    expect(coerceParsedScore({ title: '은혜의 노래', artist: '   ' }).artist).toBeUndefined();
    expect(coerceParsedScore({ title: '은혜의 노래' }).artist).toBeUndefined();
  });

  it('carries the artist through the title-only batch pass', () => {
    const [result] = coerceParsedScoreBatch(
      { results: [{ imageIndex: 0, title: '은혜의 노래', artist: '새로운 팀', key: 'E' }] },
      1,
      'titles',
    );
    expect(result).toMatchObject({ title: '은혜의 노래', artist: '새로운 팀', key: 'E' });
  });

  it('parses an optional artist from a score response', () => {
    expect(parseScoreText('{"title":"은혜의 노래","artist":"새로운 팀","order":[],"sections":[]}').artist).toBe(
      '새로운 팀',
    );
  });

  it('still reads plain OCR text that merely starts with a brace-free heading', () => {
    const parsed = parseScoreText(['은혜의 노래 (E)', 'I-V-C', 'V', '빛으로 인도하시네'].join('\n'));
    expect(parsed.title).toBe('은혜의 노래');
    expect(parsed.artist).toBeUndefined();
  });
});
