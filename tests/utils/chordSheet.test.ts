import { describe, expect, it } from 'vitest';
import {
  collapseRepeats,
  createSpacingModel,
  isChordRow,
  joinShortKoreanLines,
  joinSplitWords,
  looksLikeChordSheetText,
  parseChordSheet,
  slidesOfPart,
  songFromChordSheet,
  type PositionedPage,
  type PositionedText,
} from '../../src/lib/utils/chordSheet';

// Synthetic pages laid out the way a CCLI SongSelect chord sheet is: header,
// two columns of sections, a chord row 13.5pt above each lyric row, and every
// syllable a chord lands on written as a piece of its own.

/** Width of a string at 10pt, roughly as the sheet's fonts set it. */
function widthOf(str: string, size = 10): number {
  const units = [...str].reduce((sum, char) => sum + (/[가-힣]/.test(char) ? 9.2 : char === ' ' ? 3.6 : 6), 0);
  return (units * size) / 10;
}

function piece(str: string, x: number, y: number, size = 10): PositionedText {
  return { str, x, y, width: widthOf(str, size), size };
}

function page(items: PositionedText[]): PositionedPage {
  return { width: 612, height: 792, items };
}

function header(title: string, key: string): PositionedText[] {
  return [
    piece(title, 26, 750, 16),
    piece('Matt Redman', 26, 730, 7),
    piece(`Key - ${key} | Time - 4/4`, 26, 714, 9),
  ];
}

function footer(): PositionedText[] {
  return [
    piece('CCLI Song # 6316460', 257, 195, 8),
    piece('© 2004 Thankyou Music Ltd', 249, 184, 8),
    piece('For use solely with the SongSelect® Terms of Use. All rights reserved. www.ccli.com', 135, 174, 8),
  ];
}

describe('chord sheet rows', () => {
  it('tells chord rows from lyrics', () => {
    expect(isChordRow('D Bm G 2 Dm/F')).toBe(true);
    expect(isChordRow('Ebmaj Cm /F F 7sus')).toBe(true);
    expect(isChordRow('| Bb | Gm7 | N.C. |')).toBe(true);
    expect(isChordRow('Fm (Eb(4))')).toBe(true);
    expect(isChordRow('Be still my soul')).toBe(false);
    expect(isChordRow('God of all')).toBe(false);
    expect(isChordRow('주 자비')).toBe(false);
  });

  it('joins English syllables split for a chord, not a dash that ends a line', () => {
    expect(joinSplitWords('I am an instrument of exal - tation')).toBe('I am an instrument of exaltation');
    expect(joinSplitWords('Who else is wor - thy')).toBe('Who else is worthy');
    expect(joinSplitWords('I scarce can take it in -')).toBe('I scarce can take it in -');
  });

  it('writes a block sung three or more times once, with how often', () => {
    expect(collapseRepeats(['좌정하사 다스리소서', '좌정하사 다스리소서', '좌정하사 다스리소서', '좌정하사 다스리소서'])).toEqual([
      '좌정하사 다스리소서 (x4)',
    ]);
    expect(collapseRepeats(['A line', 'B line', 'A line', 'B line', 'A line', 'B line', 'End'])).toEqual([
      'A line',
      'B line (x3)',
      'End',
    ]);
    // Twice stays as written.
    expect(collapseRepeats(['A line', 'B line', 'A line', 'B line'])).toEqual(['A line', 'B line', 'A line', 'B line']);
  });

  it('joins a Korean phrase too short for a line of its own', () => {
    expect(joinShortKoreanLines(['사랑해요', '신실하신 나의 주님', '나의 삶', '주님 안에 있네'])).toEqual([
      '사랑해요 신실하신 나의 주님',
      '나의 삶 주님 안에 있네',
    ]);
    expect(joinShortKoreanLines(['기뻐 춤추며', '찬양해'])).toEqual(['기뻐 춤추며 찬양해']);
  });
});

describe('Korean spacing model', () => {
  it('learns word breaks from trusted lyrics', () => {
    const model = createSpacingModel(['나의 구주 예수', '모든 것 다해 찬양해']);
    expect(model('나의 구', '주 예수')).toBe(false);
    expect(model('모든', '것 다해')).toBe(true);
  });

  it('falls back to particles and endings for a pair it never saw', () => {
    const model = createSpacingModel([]);
    expect(model('주님의 높', '고')).toBe(false);
    expect(model('영혼', '이')).toBe(false);
    expect(model('이제', '주를')).toBe(true);
  });
});

describe('parseChordSheet', () => {
  // 춤추는 세대: Korean then English in one section, chords over syllables,
  // the chorus in the right-hand column.
  const dancing = page([
    ...header('춤추는 세대 (주 자비 춤추게 하네)', 'D'),
    piece('VERSE', 26, 690),
    // "주 [D]자비 [Bm]춤추게 하네"
    piece('D', 39, 678),
    piece('주', 26, 664.5),
    piece('자비', 39, 664.5),
    piece('춤추게 하네', 61.3, 664.5),
    // "모[Bm]든 것 다해 찬양해": the chord pads 든 out before the space.
    piece('Bm', 35.2, 650, 10),
    piece('모', 26, 636.8),
    piece('든', 35.2, 636.8),
    piece('것 다해 찬양해', 61.5, 636.8),
    // "주님의 [Bbmaj7]높고": the chord pads 높 out inside the word.
    piece('Bbmaj7', 57.2, 621),
    piece('주님의', 26, 607.5),
    piece('높', 57.2, 607.5),
    piece('고', 100.9, 607.5),
    piece('Your mercy taught us how to dance', 26, 580),
    piece('To celebrate with all we have', 26, 567),
    piece('And we will dance (To Ch.)', 26, 554),
    piece('CHORUS', 313, 690),
    piece('우리는 춤추는 세대 되리', 313, 664.5),
    piece('주 크신 자비로 춤추리라', 313, 637),
    piece('And we’ll be a dancing generation', 313, 610),
    piece('Dancing because of Your great mercy, Lord', 313, 597),
    ...footer(),
  ]);

  it('reads a bilingual song from where its pieces sit', () => {
    const songs = parseChordSheet([dancing], { corpus: ['모든 것 다해', '높고 위대하신 주'] });
    expect(songs).toHaveLength(1);
    const [song] = songs!;
    expect(song.title).toBe('춤추는 세대');
    expect(song.altTitle).toBe('주 자비 춤추게 하네');
    expect(song.key).toBe('D');
    expect(song.pages).toEqual([1]);
    expect(song.parts.map((part) => part.label)).toEqual(['V', 'C']);
    expect(song.parts[0].ko).toEqual(['주 자비 춤추게 하네', '모든 것 다해 찬양해', '주님의 높고']);
    expect(song.parts[0].en).toEqual([
      'Your mercy taught us how to dance',
      'To celebrate with all we have',
      'And we will dance',
    ]);
    expect(song.parts[1].ko).toEqual(['우리는 춤추는 세대 되리', '주 크신 자비로 춤추리라']);
    expect(song.parts[1].en).toHaveLength(2);
  });

  it('runs a song on over a page without a header, and pairs a (KOREAN) section with its English', () => {
    const first = page([
      ...header('Goodness Of God', 'Ab'),
      piece('VERSE 1', 26, 690),
      piece('I love You Lord oh Your mercy never fails me', 26, 664),
      piece('From the moment that I wake up until I lay', 26, 651),
      piece('my head', 26, 638),
      piece('VERSE 1 (KOREAN)', 26, 600),
      piece('사랑해요', 26, 574),
      piece('신실하신 나의 주님', 26, 547),
    ]);
    const second = page([
      piece('TAG', 26, 750),
      piece('(1.) I will sing of the goodness of God', 26, 724),
      piece('(2.) I will sing of the goodness of God (To Tag)', 26, 711),
      piece('TAG (KOREAN)', 26, 680),
      piece('오 선하신 주를 노래하리', 26, 654),
      ...footer(),
    ]);
    const songs = parseChordSheet([first, second]);
    expect(songs).toHaveLength(1);
    const [song] = songs!;
    expect(song.pages).toEqual([1, 2]);
    expect(song.parts.map((part) => part.label)).toEqual(['V', 'T']);
    expect(song.parts[0].en).toEqual([
      'I love You Lord oh Your mercy never fails me',
      'From the moment that I wake up until I lay my head',
    ]);
    expect(song.parts[0].ko).toEqual(['사랑해요 신실하신 나의 주님']);
    // The two numbered endings sing the same words: kept once.
    expect(song.parts[1]).toMatchObject({ ko: ['오 선하신 주를 노래하리'], en: ['I will sing of the goodness of God'] });
  });

  it('starts a new song at every header and drops a part that only repeats another', () => {
    const praise = page([
      ...header('Praise', 'F'),
      piece('INTRO', 26, 690),
      piece('Let ev’rything that has breath', 26, 664),
      piece('Praise the Lord, praise the Lord', 26, 651),
      piece('Let ev’rything that has breath', 26, 638),
      piece('Praise the Lord, praise the Lord', 26, 625),
      piece('INSTRUMENTAL', 26, 600),
      piece('| Dm | Bb | F | C |', 26, 587),
      piece('ENDING', 313, 690),
      ...[0, 1, 2, 3].flatMap((index) => [
        piece('Let ev’rything that has breath', 313, 664 - index * 26),
        piece('Praise the Lord, praise the Lord', 313, 651 - index * 26),
      ]),
    ]);
    const songs = parseChordSheet([dancing, praise]);
    expect(songs!.map((song) => song.title)).toEqual(['춤추는 세대', 'Praise']);
    const parts = songs![1].parts;
    // The instrumental has no words, and the ending is the intro sung again.
    expect(parts.map((part) => part.heading)).toEqual(['INTRO']);
    expect(parts[0]).toMatchObject({ label: 'IN', ko: [] });
  });

  it('leaves an ordinary 콘티 alone', () => {
    expect(parseChordSheet([page([piece('2026.10.03 찬양 콘티', 26, 750), piece('1 주님의 사랑 E', 26, 700)])])).toBeNull();
    expect(looksLikeChordSheetText('1. 주님의 사랑 (E): 설명')).toBe(false);
    expect(looksLikeChordSheetText('Goodness Of God\nKey - Ab | Tempo - 63 | Time - 4/4\nCCLI Song # 7117726')).toBe(true);
  });
});

describe('sheet songs as slides', () => {
  it('keeps each slide’s English with the Korean it translates', () => {
    const slides = slidesOfPart({
      ko: ['주 하나님 지으신 모든 세계', '내 마음 속에 그리어 볼 때', '하늘의 별 울려 퍼지는 뇌성', '주님의 권능 우주에 찼네'],
      en: [
        'O Lord my God',
        'When I in awesome wonder',
        'Consider all the works',
        'Thy hands have made,',
        'I see the stars,',
        'I hear the rolling thunder,',
        'Thy pow’r throughout',
        'The universe displayed!',
      ],
    });
    expect(slides.map((slide) => [slide.ko.length, slide.en.length])).toEqual([
      [2, 4],
      [2, 4],
    ]);
    expect(slides[1].en[0]).toBe('I see the stars,');
  });

  it('cuts the Korean where it has said as much as the English, not by line count', () => {
    const slides = slidesOfPart({
      ko: ['사랑해요 신실하신 나의 주님', '나의 삶 주님 안에 있네', '눈을 뜨는 아침부터', '나 잠들기까지', '오 선하신 주를 노래하리'],
      en: [
        'I love You Lord oh Your mercy never fails me',
        'All my days I’ve been held in Your hands',
        'From the moment that I wake up until I lay my head',
        'I will sing of the goodness of God',
      ],
    });
    expect(slides.map((slide) => slide.ko[0])).toEqual(['사랑해요 신실하신 나의 주님', '눈을 뜨는 아침부터']);
    expect(slides[1].en[0]).toMatch(/^From the moment/);
  });

  it('makes a bilingual song whose slides break exactly where the English does', () => {
    const [sheet] = parseChordSheet([
      page([
        ...header('주 하나님 지으신 모든 세계', 'Bb'),
        piece('VERSE 1', 26, 690),
        piece('주 하나님 지으신 모든 세계', 26, 664),
        piece('내 마음 속에 그리어 볼 때', 26, 637),
        piece('하늘의 별 울려 퍼지는 뇌성', 26, 610),
        piece('주님의 권능 우주에 찼네', 26, 583),
        ...['O Lord my God', 'When I in awesome wonder', 'Consider all the works', 'Thy hands have made,'].map(
          (line, index) => piece(line, 26, 560 - index * 13),
        ),
        ...footer(),
      ]),
    ])!;
    const praise = songFromChordSheet(sheet, { id: 'how-great', linesPerSlide: 3, bilingual: true });
    expect(praise.song).toMatchObject({ title: '주 하나님 지으신 모든 세계', key: 'Bb', order: ['V'], pageIndex: 1 });
    expect(praise.song.sections[0].lines).toEqual([
      '주 하나님 지으신 모든 세계',
      '내 마음 속에 그리어 볼 때',
      '',
      '하늘의 별 울려 퍼지는 뇌성',
      '주님의 권능 우주에 찼네',
    ]);
    expect(praise.slides.map((slide) => slide.en.length)).toEqual([2, 2]);

    // The Sunday deck keeps only the Korean, split its usual way.
    const sunday = songFromChordSheet(sheet, { id: 'how-great', linesPerSlide: 4, bilingual: false });
    expect(sunday.song.sections[0].lines).toHaveLength(4);
    expect(sunday.song.linesPerSlide).toBe(4);
  });
});
