import { describe, expect, it } from 'vitest';
import {
  hasSlideNumberParts,
  lacksParts,
  organizeSavedEntry,
  partsFromLyrics,
  savedWordsInParts,
} from '../../src/lib/lyrics/savedLyrics';

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

const VERSE1 = ['첫째 절 첫 줄', '첫째 절 둘째 줄', '첫째 절 셋째 줄', '첫째 절 넷째 줄'];
const VERSE2 = ['둘째 절 첫 줄', '둘째 절 둘째 줄', '둘째 절 셋째 줄', '둘째 절 넷째 줄'];
const CHORUS = ['후렴 첫 줄', '후렴 둘째 줄', '후렴 셋째 줄', '후렴 넷째 줄'];
/** A whole song saved as one part, the chorus printed each time it is sung. */
const ONE_BLOCK = [{ label: 'V', lines: [...VERSE1, ...CHORUS, ...VERSE2, ...CHORUS] }];

describe('lacksParts', () => {
  it('is true for a song saved slide by slide, confirmed or not', () => {
    expect(lacksParts({ sections: SAVED, verification: 'verified' })).toBe(true);
    expect(lacksParts({ sections: SAVED, verification: 'draft' })).toBe(true);
  });

  it('is true for a draft holding the whole song in one block', () => {
    expect(lacksParts({ sections: ONE_BLOCK, verification: 'draft' })).toBe(true);
  });

  it('takes a confirmed one-part song, a short one, and one saved by its parts as they are', () => {
    expect(lacksParts({ sections: ONE_BLOCK, verification: 'verified' })).toBe(false);
    expect(lacksParts({ sections: ONE_BLOCK })).toBe(false);
    expect(lacksParts({ sections: [{ label: 'V', lines: VERSE1 }], verification: 'draft' })).toBe(false);
    expect(
      lacksParts({
        sections: [
          { label: 'V', lines: [...VERSE1, ...VERSE2] },
          { label: 'C', lines: CHORUS },
        ],
        verification: 'draft',
      }),
    ).toBe(false);
  });
});

describe('partsFromLyrics', () => {
  it('finds the chorus a block prints again, and sings it again in the order', () => {
    expect(partsFromLyrics(ONE_BLOCK)).toEqual({
      sections: [
        { label: 'V', lines: VERSE1 },
        { label: 'C', lines: CHORUS },
        { label: 'V2', lines: VERSE2 },
      ],
      order: ['I', 'V', 'C', 'V2', 'C'],
    });
  });

  it('follows the part headings saved with the lyrics', () => {
    const headed = [{ label: 'V', lines: ['1절', ...VERSE1, '후렴', ...CHORUS, '2절', ...VERSE2] }];
    const parts = partsFromLyrics(headed);
    expect(parts?.sections.map((section) => section.label)).toEqual(['V', 'C', 'V2']);
    expect(parts?.sections[1].lines).toEqual(CHORUS);
  });

  it('reads saved slides as stanzas, a slide printed twice being the chorus', () => {
    const slides = [
      { label: '1', lines: VERSE1 },
      { label: '2', lines: CHORUS },
      { label: '3', lines: VERSE2 },
      { label: '4', lines: CHORUS },
    ];
    expect(partsFromLyrics(slides)?.order).toEqual(['I', 'V', 'C', 'V2', 'C']);
  });

  it('guesses nothing when the lyrics show no parts', () => {
    expect(partsFromLyrics(SAVED)).toBeNull();
    expect(partsFromLyrics([{ label: 'V', lines: [...VERSE1, ...VERSE2, ...CHORUS] }])).toBeNull();
  });
});

describe('organizeSavedEntry', () => {
  it('organizes a song saved without parts that shows them', () => {
    const entry = { title: '가상의 노래', sections: ONE_BLOCK, order: ['I', 'V'], verification: 'draft' as const };
    const organized = organizeSavedEntry(entry);
    expect(organized.title).toBe('가상의 노래');
    expect(organized.sections.map((section) => section.label)).toEqual(['V', 'C', 'V2']);
    expect(organized.order).toEqual(['I', 'V', 'C', 'V2', 'C']);
  });

  it('leaves a song as saved when it has its parts or shows none', () => {
    const parted = { sections: [{ label: 'V', lines: VERSE1 }, { label: 'C', lines: CHORUS }], order: ['I', 'V', 'C'] };
    expect(organizeSavedEntry(parted)).toBe(parted);
    const slides = { sections: SAVED, order: ['1', '2', '3'], verification: 'verified' as const };
    expect(organizeSavedEntry(slides)).toBe(slides);
  });
});
