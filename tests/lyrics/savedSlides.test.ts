import { describe, expect, it } from 'vitest';
import { hasSlideNumberParts, savedWordsInParts } from '../../src/lib/lyrics/savedSlides';

// Placeholder text. The 악보 readings carry the kind of single-syllable slips
// OCR makes; the saved slides are what a past deck projected.
const SAVED = [
  { label: '1', lines: ['사랑의 주님 나를 부르시네', '그 음성 따라 나아가리'] },
  { label: '2', lines: ['주님의 사랑 끝이 없어라', '영원히 나 노래하리'] },
  { label: '3', lines: ['주님의 사랑 넓고 깊어라', '날마다 나 찬양하리'] },
];

describe('hasSlideNumberParts', () => {
  it('is true for a song saved slide by slide', () => {
    expect(hasSlideNumberParts(SAVED)).toBe(true);
    expect(hasSlideNumberParts([{ label: ' 12 ' }])).toBe(true);
  });

  it('is false for a song saved by its parts, or with no parts', () => {
    expect(hasSlideNumberParts([{ label: 'V' }, { label: 'C' }])).toBe(false);
    expect(hasSlideNumberParts([{ label: '1' }, { label: 'C' }])).toBe(false);
    expect(hasSlideNumberParts([{ label: 'V1' }])).toBe(false);
    expect(hasSlideNumberParts([])).toBe(false);
  });
});

describe('savedWordsInParts', () => {
  it('gives each part the saved words that read like it, across slide edges', () => {
    const { sections, matched } = savedWordsInParts(
      [
        { label: 'V', lines: ['사랑의 주님 나를 부르시녜', '그 음성 따라 나아가리'] },
        // The 악보 breaks the chorus differently from the saved slides.
        { label: 'C', lines: ['주님의 사랑 끝이 없어라 영원히 나 노래하리', '주님의 사랑 넓고 깊어라 날마다 나 찬앙하리'] },
      ],
      SAVED,
    );
    expect(matched).toBe(2);
    expect(sections).toEqual([
      { label: 'V', lines: SAVED[0].lines },
      { label: 'C', lines: [...SAVED[1].lines, ...SAVED[2].lines] },
    ]);
  });

  it('leaves a part the deck never projected as the 악보 read it', () => {
    const bridge = { label: 'B', lines: ['잔잔한 강물처럼', '흘러가는 노래로'] };
    const { sections, matched } = savedWordsInParts(
      [{ label: 'V', lines: ['사랑의 주님 나를 부르시녜', '그 음성 따라 나아가리'] }, bridge],
      SAVED,
    );
    expect(matched).toBe(1);
    expect(sections[0].lines).toEqual(SAVED[0].lines);
    expect(sections[1]).toEqual(bridge);
  });

  it('never gives two parts the same saved lines', () => {
    // Two verses that read alike: each takes its own slide.
    const { sections, matched } = savedWordsInParts(
      [
        { label: 'V', lines: ['주님의 사랑 끝이 없어라', '영원히 나 노래하리'] },
        { label: 'V2', lines: ['주님의 사랑 넓고 깊어라', '날마다 나 찬양하리'] },
      ],
      SAVED,
    );
    expect(matched).toBe(2);
    expect(sections.map((section) => section.lines)).toEqual([SAVED[1].lines, SAVED[2].lines]);
  });

  it('matches nothing when the 악보 read another song', () => {
    const other = [{ label: 'V', lines: ['가나다라 마바사 아자차', '카타파하 그 이름 높이'] }];
    expect(savedWordsInParts(other, SAVED)).toEqual({ sections: other, matched: 0 });
  });
});
