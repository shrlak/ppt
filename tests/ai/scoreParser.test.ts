import { describe, expect, it } from 'vitest';
import {
  cleanLyricLine,
  coerceParsedScore,
  coerceParsedScoreBatch,
  parseScoreText,
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

  it('falls back to a default scaffold with neither order nor labels', () => {
    const parsed = parseScoreText('그냥 제목 같은 줄\n가사 한 줄');
    expect(parsed.order).toEqual([]);
    expect(parsed.sections.map((s) => s.label)).toEqual(['V1', 'C']);
  });
});
