import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  englishForSlide,
  englishFromSheet,
  entryFromSheet,
  entryFromSong,
  fillEnglishFromLibrary,
  findEnglishEntry,
  mergeEnglishLibraries,
  sanitizeEnglishEntries,
  sheetTitles,
  songFromEnglishEntry,
  type EnglishSongEntry,
} from '../../src/praise/englishLibrary';
import { planPraiseSong, slideKey } from '../../src/praise/planner';
import { songFromChordSheet, type ChordSheetSong } from '../../src/lib/utils/chordSheet';
import type { Song } from '../../src/lib/utils/types';

const seed = sanitizeEnglishEntries(
  JSON.parse(readFileSync(join(__dirname, '..', '..', 'public', 'praise-english.json'), 'utf8')),
);

const entry: EnglishSongEntry = {
  title: '주님의 선하심',
  englishTitle: 'Goodness of God',
  slides: [
    { ko: ['사랑해요 주의 자비 변치 않네', '내 모든 삶 주의 손에 있네'], en: ['I love You Lord oh Your mercy never fails me', 'All my days I’ve been held in Your hands'] },
    { ko: ['나 눈을 뜰 때부터 잠들때까지', '난 노래해 주의 선하심을'], en: ['From the moment that I wake up', 'until I lay my head', 'I will sing of the goodness of God'] },
  ],
};

describe('the bundled seed', () => {
  it('holds last year’s songs, bilingual where the deck was', () => {
    const titles = seed.map((song) => song.title);
    expect(titles).toEqual(expect.arrayContaining(['춤추는 세대', '주님의 선하심', 'Who Else', 'Praise']));
    const goodness = findEnglishEntry(seed, '주님의 선하심')!;
    expect(goodness.englishTitle).toBe('Goodness of God');
    expect(goodness.slides[0].en[0]).toBe('I love You Lord oh Your mercy never fails me');
    // Found by the English title too.
    expect(findEnglishEntry(seed, 'goodness of god')?.title).toBe('주님의 선하심');
  });
});

describe('englishForSlide', () => {
  it('returns a whole slide’s English for the same Korean lines', () => {
    expect(englishForSlide(['사랑해요 주의 자비 변치 않네', '내 모든 삶 주의 손에 있네'], entry)).toEqual(entry.slides[0].en);
  });

  it('joins consecutive saved slides when this year puts them on one slide', () => {
    const lines = [...entry.slides[0].ko, ...entry.slides[1].ko];
    expect(englishForSlide(lines, entry)).toEqual([...entry.slides[0].en, ...entry.slides[1].en]);
  });

  it('returns the matching share of a slide when this year splits it', () => {
    expect(englishForSlide(['사랑해요 주의 자비 변치 않네'], entry)).toEqual([entry.slides[0].en[0]]);
  });

  it('forgives one misread syllable, but not a different line', () => {
    expect(englishForSlide(['사랑해요 주의 자비 변치 안네', '내 모든 삶 주의 손에 있네'], entry)).toEqual(entry.slides[0].en);
    expect(englishForSlide(['전혀 다른 가사 한 줄', '또 다른 가사'], entry)).toBeNull();
  });
});

describe('fillEnglishFromLibrary', () => {
  const song: Song = {
    id: 's',
    title: '주님의 선하심',
    sections: [{ label: 'V', lines: [...entry.slides[0].ko, ...entry.slides[1].ko] }],
    order: ['V'],
    linesPerSlide: 2,
  };

  it('fills the English title and every slide it can, without touching typed English', () => {
    const typed = planPraiseSong(song, undefined).slides[1].key;
    const { english, filled, titleFilled } = fillEnglishFromLibrary(
      song,
      { title: '', slides: { [typed]: ['my own line'] } },
      [entry],
    );
    expect(titleFilled).toBe(true);
    expect(english.title).toBe('Goodness of God');
    expect(filled).toBe(1);
    const plan = planPraiseSong(song, { english });
    expect(plan.slides[0].english).toEqual(entry.slides[0].en);
    expect(plan.slides[1].english).toEqual(['my own line']);
  });
});

describe('entryFromSong / songFromEnglishEntry', () => {
  it('round-trips a song through the library, slide for slide', () => {
    const { song, english } = songFromEnglishEntry(entry, 'fixed-id');
    expect(song.id).toBe('fixed-id');
    const plan = planPraiseSong(song, { english });
    expect(plan.slides.map((slide) => slide.english)).toEqual(entry.slides.map((slide) => slide.en));
    expect(entryFromSong(song, english)).toEqual(entry);
  });

  it('keeps an English-only song’s lines as its English', () => {
    const praise = findEnglishEntry(seed, 'Praise')!;
    const { song, english } = songFromEnglishEntry(praise);
    const back = entryFromSong(song, english);
    expect(back.slides.every((slide) => slide.ko.length === 0)).toBe(true);
    expect(back.slides[0].en).toEqual(praise.slides[0].en);
  });
});

describe('mergeEnglishLibraries', () => {
  it('lets a saved song replace the seed’s copy of it', () => {
    const saved = { ...entry, englishTitle: 'Goodness Of God (edited)' };
    const merged = mergeEnglishLibraries(seed, [saved]);
    expect(findEnglishEntry(merged, '주님의 선하심')?.englishTitle).toBe('Goodness Of God (edited)');
    expect(merged.filter((item) => item.title === '주님의 선하심')).toHaveLength(1);
  });
});

describe('matching lyrics that break lines differently', () => {
  const howGreat = findEnglishEntry(seed, '주 하나님 지으신 모든 세계')!;

  it('matches by text, not by line breaks or a syllable of spelling', () => {
    // The 찬양 라이브러리 prints two of last year's slides as two long lines,
    // and spells 그리어 as 그려.
    const english = englishForSlide(
      ['주 하나님 지으신 모든 세계 내 마음 속에 그려 볼 때', '하늘의 별 울려 퍼지는 뇌성 주님의 권능 우주에 찼네'],
      howGreat,
    );
    expect(english?.[0]).toBe('O Lord my God');
    expect(english?.at(-1)).toBe('The universe displayed');
  });

  it('gives a repeated chorus line its English twice', () => {
    const line = '주님의 높고 위대하심을 내 영혼이 찬양하네';
    const english = englishForSlide([line, line], howGreat);
    expect(english?.filter((text) => text === 'Then sings my soul,')).toHaveLength(2);
  });

  it('does not borrow English for lyrics the song never had', () => {
    expect(englishForSlide(['완전히 다른 곡의 가사 첫 줄', '그리고 전혀 상관없는 둘째 줄'], howGreat)).toBeNull();
  });
});

describe('a chord-sheet 콘티', () => {
  const sheet = (title: string, parts: ChordSheetSong['parts'], altTitle?: string): ChordSheetSong => ({
    title,
    ...(altTitle ? { altTitle } : {}),
    pages: [1],
    parts,
  });

  it('gives a song the sheet titles in English the Korean title it was sung under', () => {
    const goodness = sheet('Goodness Of God', [
      { label: 'V', heading: 'VERSE 1', ko: ['사랑해요 신실하신 나의 주님'], en: ['I love You Lord oh Your mercy never fails me'] },
    ]);
    expect(sheetTitles(goodness, seed)).toEqual({ title: '주님의 선하심', englishTitle: 'Goodness Of God' });
    // "Saviour" on the sheet, "Savior" last year.
    const beautiful = sheet('Beautiful Saviour', [
      { label: 'V', heading: 'VERSE', ko: ['예수 아름다우신'], en: ['Jesus beautiful Saviour'] },
    ]);
    expect(sheetTitles(beautiful, seed).title).toBe('예수 아름다우신');
    // A song only ever sung in English keeps its one title.
    const whoElse = sheet('Who Else', [{ label: 'C', heading: 'CHORUS', ko: [], en: ['Who else is worthy'] }]);
    expect(sheetTitles(whoElse, seed)).toEqual({ title: 'Who Else', englishTitle: '' });
  });

  it('borrows the English title for a Korean title printed longer than last year’s', () => {
    const mourning = sheet('나의 슬픔을 주가 기쁨으로', [
      { label: 'C', heading: 'CHORUS', ko: ['나의 슬픔을 주가 기쁨으로'], en: ['He’s turned my mourning into dancing again'] },
    ]);
    expect(sheetTitles(mourning, seed)).toEqual({ title: '나의 슬픔을 주가 기쁨으로', englishTitle: 'Mourning into Dancing' });
  });

  it('finds a song by its Korean lyrics when neither title matches', () => {
    const unnamed = sheet('Jesus We Enthrone You (Live)', [
      { label: 'V', heading: 'VERSE', ko: ['예수 우리 왕이여', '이곳에 오소서', '보좌로 주여 임하사', '찬양을 받아 주소서'], en: ['Jesus, we enthrone You'] },
    ]);
    expect(sheetTitles(unnamed, seed).title).toBe('예수 우리 왕이여');
  });

  it('keeps each slide’s English under the Korean it was printed with, however the song is re-split', () => {
    const howGreat = sheet('주 하나님 지으신 모든 세계', [
      {
        label: 'V',
        heading: 'VERSE 1',
        ko: ['주 하나님 지으신 모든 세계', '내 마음 속에 그리어 볼 때', '하늘의 별 울려 퍼지는 뇌성', '주님의 권능 우주에 찼네'],
        en: ['O Lord my God', 'When I in awesome wonder', 'I see the stars,', 'I hear the rolling thunder,'],
      },
    ]);
    const { song, slides } = songFromChordSheet(howGreat, { id: 'how-great', linesPerSlide: 3, bilingual: true });
    const english = englishFromSheet(slides, 'How Great Thou Art');
    expect(english.title).toBe('How Great Thou Art');
    expect(english.slides[slideKey(['주 하나님 지으신 모든 세계', '내 마음 속에 그리어 볼 때'])]).toEqual([
      'O Lord my God',
      'When I in awesome wonder',
    ]);
    expect(planPraiseSong(song, { english }).slides.every((slide) => slide.english.length === 2)).toBe(true);

    // All four lines on one slide: the sheet's entry still has English for it.
    const joined: Song = { ...song, sections: [{ label: 'V', lines: howGreat.parts[0].ko }], linesPerSlide: 4 };
    const refilled = fillEnglishFromLibrary(joined, { title: '', slides: {} }, [
      entryFromSheet(song.title, 'How Great Thou Art', slides),
    ]);
    expect(refilled.filled).toBe(1);
    expect(Object.values(refilled.english.slides)[0]).toHaveLength(4);
  });
});
