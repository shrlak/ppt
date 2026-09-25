import { describe, expect, it } from 'vitest';
import {
  fitToPages,
  isEnglishOnlySong,
  pageFontSize,
  missingEnglishCount,
  planPraiseDeck,
  planPraiseSong,
  slideKey,
} from '../../src/praise/planner';
import { distributeEnglish, linesFromText } from '../../src/praise/englishText';
import type { Song } from '../../src/lib/utils/types';
import type { PraiseSongExtras } from '../../src/praise/types';

function song(partial: Partial<Song> & Pick<Song, 'id' | 'title'>): Song {
  return { sections: [], order: [], linesPerSlide: 3, ...partial };
}

const goodness = song({
  id: 'goodness',
  title: '주님의 선하심',
  sections: [
    { label: 'V1', lines: ['사랑해요 주의 자비 변치 않네', '내 모든 삶 주의 손에 있네'] },
    { label: 'C', lines: ['내 평생 신실하신 주', '내 평생 좋으신 하나님', '나의 호흡 끊길 때까지', '난 노래해 주의 선하심을'] },
  ],
  order: ['I', 'V1', 'C', 'C'],
});

const englishFor = (extras: PraiseSongExtras['english']): PraiseSongExtras => ({ english: extras });

describe('planPraiseSong', () => {
  it('splits Korean like the Sunday deck and pairs each slide with its English', () => {
    const chorusFirst = ['내 평생 신실하신 주', '내 평생 좋으신 하나님'];
    const plan = planPraiseSong(
      goodness,
      englishFor({
        title: 'Goodness of God',
        slides: {
          [slideKey(chorusFirst)]: ['All my life You have been faithful', 'All my life You have been so good'],
        },
      }),
    );
    expect(plan.header).toBe('주님의 선하심 | Goodness of God');
    // V1 (2 lines) stays one slide; the 4-line chorus splits 2 + 2 at 3 per slide.
    expect(plan.slides.map((slide) => slide.lines.length)).toEqual([2, 2, 2]);
    expect(plan.slides[1].english).toEqual(['All my life You have been faithful', 'All my life You have been so good']);
    expect(plan.slides[0].english).toEqual([]);
  });

  it('keys English by the Korean text, so punctuation and spacing do not detach it', () => {
    expect(slideKey(['내 평생  신실하신 주!'])).toBe(slideKey(['내 평생 신실하신 주']));
  });

  it('prints one title when there is no English title or it repeats the Korean', () => {
    expect(planPraiseSong(goodness, englishFor({ title: '', slides: {} })).header).toBe('주님의 선하심');
    const who = song({ id: 'who', title: 'Who Else', sections: [{ label: 'V', lines: ['Who else is worthy'] }] });
    const plan = planPraiseSong(who, englishFor({ title: 'Who Else', slides: {} }));
    expect(plan.englishOnly).toBe(true);
    expect(plan.titleEn).toBe('');
    expect(plan.header).toBe('Who Else');
  });
});

describe('isEnglishOnlySong', () => {
  it('is true only when neither the title nor any line has Hangul', () => {
    expect(isEnglishOnlySong(song({ id: 'a', title: 'Praise', sections: [{ label: 'V', lines: ['Let everything'] }] }))).toBe(true);
    expect(isEnglishOnlySong(song({ id: 'b', title: 'Praise', sections: [{ label: 'V', lines: ['찬양해'] }] }))).toBe(false);
    expect(isEnglishOnlySong(goodness)).toBe(false);
  });
});

describe('planPraiseDeck', () => {
  it('orders cover, songs, files placed after a song, then that song’s 기도, then files at the end', () => {
    const other = song({ id: 'other', title: '예수 우리 왕이여', sections: [{ label: 'V', lines: ['예수 우리 왕이여'] }] });
    const plans = planPraiseDeck(
      [goodness, other],
      { goodness: { english: { title: '', slides: {} }, prayerAfter: true } },
      [
        { fileId: 'sermon', placement: { afterSongId: 'goodness' } },
        { fileId: 'intro', placement: 'start' },
        { fileId: 'closing', placement: 'end' },
        { fileId: 'orphan', placement: { afterSongId: 'removed-song' } },
      ],
    );
    expect(plans.map((plan) => (plan.kind === 'additional' ? `file:${plan.fileId}` : plan.kind))).toEqual([
      'cover',
      'file:intro',
      'title',
      'lyrics',
      'lyrics',
      'lyrics',
      'file:sermon',
      'prayer',
      'title',
      'lyrics',
      'file:closing',
      'file:orphan',
    ]);
  });
});

describe('missingEnglishCount', () => {
  it('counts Korean slides without English, and never counts an English-only song', () => {
    expect(missingEnglishCount(goodness, undefined)).toBe(3);
    const praise = song({ id: 'p', title: 'Praise', sections: [{ label: 'C', lines: ['Praise the Lord, oh my soul'] }] });
    expect(missingEnglishCount(praise, undefined)).toBe(0);
  });
});

describe('distributeEnglish', () => {
  const slides = planPraiseSong(goodness, undefined).slides;

  it('puts paragraph N under slide N when the paste has one paragraph per slide', () => {
    const result = distributeEnglish('A1\nA2\n\nB1\nB2\n\nC1\nC2', slides);
    expect(slides.map((slide) => result[slide.key])).toEqual([
      ['A1', 'A2'],
      ['B1', 'B2'],
      ['C1', 'C2'],
    ]);
  });

  it('shares lines out in order, by each slide’s size, when the paragraphs do not line up', () => {
    const result = distributeEnglish('1\n2\n3\n4\n5\n6', slides);
    expect(slides.flatMap((slide) => result[slide.key])).toEqual(['1', '2', '3', '4', '5', '6']);
    expect(slides.map((slide) => result[slide.key].length)).toEqual([2, 2, 2]);
  });

  it('reads textarea lines without blanks', () => {
    expect(linesFromText('  a \n\n b\r\n')).toEqual(['a', 'b']);
  });
});

describe('fitting a slide to the page', () => {
  const longKorean = '주 하나님 지으신 모든 세계 내 마음 속에 그려 볼 때';
  const english = ['O Lord my God', 'When I in awesome wonder', 'Consider all the works', 'Thy hands have made'];

  it('keeps a slide that fits as one page, at the template size', () => {
    const plan = planPraiseSong(goodness, undefined);
    expect(plan.slides.every((slide) => slide.pages.length === 1)).toBe(true);
    expect(pageFontSize(plan.slides[0].pages[0])).toBe(3400);
  });

  it('splits a slide that would shrink past readable, Korean and English together', () => {
    const pages = fitToPages({
      lines: [longKorean, '하늘의 별 울려 퍼지는 뇌성 주님의 권능 우주에 찼네'],
      english: [...english, 'I see the stars,', 'I hear the rolling thunder,', 'Thy pow’r throughout', 'The universe displayed'],
    });
    expect(pages).toHaveLength(2);
    expect(pages[0]).toEqual({ lines: [longKorean], english });
    expect(pages.every((page) => pageFontSize(page) >= 2800)).toBe(true);
  });

  it('puts every page of a split slide into the deck in order', () => {
    const song: Song = {
      id: 'great',
      title: '주 하나님 지으신 모든 세계',
      sections: [{ label: 'V', lines: [longKorean, '하늘의 별 울려 퍼지는 뇌성 주님의 권능 우주에 찼네'] }],
      order: ['V'],
      linesPerSlide: 3,
    };
    const key = slideKey(song.sections[0].lines);
    const plans = planPraiseDeck([song], { great: englishFor({ title: 'How Great Thou Art', slides: { [key]: [...english, ...english] } }) });
    expect(plans.filter((plan) => plan.kind === 'lyrics')).toHaveLength(2);
  });
});
