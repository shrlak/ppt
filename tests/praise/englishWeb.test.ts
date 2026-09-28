import { describe, expect, it } from 'vitest';
import {
  alignEnglishByLabels,
  alignEnglishOnly,
  englishFromWeb,
  englishStanzas,
  pairWebBlocks,
  sanitizeWebEnglishCandidates,
  webEnglishReference,
  type WebEnglishBlock,
  type WebEnglishCandidate,
} from '../../src/praise/englishWeb';
import { buildEnglishPrompt, keepReferenceLines } from '../../src/praise/englishAi';
import { planPraiseSong, slideKey } from '../../src/praise/planner';
import type { Song } from '../../src/lib/utils/types';

// Made-up lyrics in the shape of a translated worship song.
const V = ['주 사랑 안에 나 살아가리', '그 은혜 날마다 새롭네'];
const C = ['주를 찬양해 영원토록', '주의 이름 높이리'];
const B = ['나 무너져도 주 붙드시네', '그 사랑 끝이 없네'];
const EV = ['In Your love I will live my days', 'Your grace is new every morning'];
const EC = ['I will praise You forevermore', 'I lift Your name on high'];
const EB = ['When I fall You hold me fast', 'Your love will never end'];

const song: Song = {
  id: 'trial',
  title: '시험의 노래',
  sections: [
    { label: 'V', lines: V },
    { label: 'C', lines: C },
    { label: 'B', lines: B },
  ],
  order: ['I', 'V', 'C', 'V', 'B', 'C'],
  linesPerSlide: 3,
};

const ko = (lines: string[]): WebEnglishBlock => ({ lang: 'ko', lines });
const en = (lines: string[], label?: string): WebEnglishBlock => ({ lang: 'en', lines, ...(label ? { label } : {}) });

function candidate(blocks: WebEnglishBlock[], englishTitle = ''): WebEnglishCandidate {
  return { url: 'https://a.tistory.com/1', host: 'a.tistory.com', title: '시험의 노래 영어 가사', englishTitle, score: 1, blocks };
}

const empty = { title: '', slides: {} };

function englishUnder(result: { english: { slides: Record<string, string[]> } }): string[][] {
  return [V, C, B].map((lines) => result.english.slides[slideKey(lines)] ?? []);
}

describe('pairing a post’s stanzas', () => {
  const songLines = [...V, ...C, ...B];

  it('pairs Korean-then-English stanzas, ignoring the post’s own headings', () => {
    const pairs = pairWebBlocks(
      [ko(['시험의 노래 영어 가사']), en(['Song of Trial']), ko(V), en(EV), ko(C), en(EC), ko(V), en(EV), ko(B), en(EB), ko(['다른 글 보기'])],
      songLines,
    );
    expect(pairs).toContainEqual({ ko: V, en: EV });
    expect(pairs).toContainEqual({ ko: C, en: EC });
    expect(pairs).toContainEqual({ ko: B, en: EB });
    expect(pairs.some((pair) => pair.en.includes('Song of Trial'))).toBe(false);
  });

  it('pairs English-then-Korean stanzas the other way round', () => {
    const pairs = pairWebBlocks([en(EV), ko(V), en(EC), ko(C), en(EB), ko(B)], songLines);
    expect(pairs).toEqual([
      { ko: V, en: EV },
      { ko: C, en: EC },
      { ko: B, en: EB },
    ]);
  });

  it('pairs all-the-Korean-then-all-the-English stanza for stanza', () => {
    const pairs = pairWebBlocks([ko(V), ko(C), ko(B), en(EV), en(EC), en(EB)], songLines);
    expect(pairs).toEqual([
      { ko: V, en: EV },
      { ko: C, en: EC },
      { ko: B, en: EB },
    ]);
  });

  it('pairs the first stanza even when the post’s own Korean runs straight into it', () => {
    const pairs = pairWebBlocks(
      [ko(['시험의 노래']), ko(['오늘 함께 부를 찬양입니다']), ko(V), en(EV), ko(C), en(EC), ko(B), en(EB)],
      songLines,
    );
    expect(pairs).toEqual([
      { ko: V, en: EV },
      { ko: C, en: EC },
      { ko: B, en: EB },
    ]);
  });

  it('pairs the last stanza even when a stray English line follows its English', () => {
    const pairs = pairWebBlocks([ko(V), en(EV), ko(C), en(EC), ko(B), en(EB), en(['Translated by Some One'])], songLines);
    expect(pairs).toEqual([
      { ko: V, en: EV },
      { ko: C, en: EC },
      { ko: B, en: EB },
    ]);
  });

  it('pairs a post that gives each Korean line its English line', () => {
    const lineByLine = [V, C, B].flatMap((lines, part) =>
      lines.flatMap((line, at) => [ko([line]), en([[EV, EC, EB][part][at]])]),
    );
    const result = englishFromWeb(song, empty, [candidate([ko(['시험의 노래 가사']), ...lineByLine])]);
    expect(result.filled).toBe(3);
    expect(englishUnder(result)).toEqual([EV, EC, EB]);
  });

  it('pairs all the Korean then all the English past the post’s own Korean, and guesses nothing when counts differ', () => {
    expect(pairWebBlocks([ko(['시험의 노래 가사']), ko(V), ko(C), ko(B), en(EV), en(EC), en(EB)], songLines)).toEqual([
      { ko: V, en: EV },
      { ko: C, en: EC },
      { ko: B, en: EB },
    ]);
    // Which English goes with which Korean cannot be told, so none is guessed.
    expect(pairWebBlocks([ko(['시험의 노래 가사']), ko(V), ko(C), en(EV), en(EC), en(EB)], songLines)).toEqual([]);
  });

  it('pairs nothing when the Korean on the page is not this song', () => {
    expect(pairWebBlocks([ko(['전혀 다른 노래의 가사', '여기 적혀 있네']), en(EV)], songLines)).toEqual([]);
  });
});

describe('English from the web under this conti’s Korean', () => {
  it('fills every Korean slide from a bilingual post, and the English title', () => {
    const result = englishFromWeb(song, empty, [
      candidate([ko(V), en(EV), ko(C), en(EC), ko(V), en(EV), ko(B), en(EB), ko(C), en(EC)], 'Song of Trial'),
    ]);
    expect(result.filled).toBe(3);
    expect(englishUnder(result)).toEqual([EV, EC, EB]);
    expect(result.english.title).toBe('Song of Trial');
    expect(result.source).toEqual({ url: 'https://a.tistory.com/1', host: 'a.tistory.com' });
  });

  it('matches the Korean however the conti breaks its lines', () => {
    const regrouped: Song = { ...song, linesPerSlide: 1 };
    const result = englishFromWeb(regrouped, empty, [candidate([ko(V), en(EV), ko(C), en(EC), ko(B), en(EB)])]);
    const slides = planPraiseSong(regrouped, { english: result.english }).slides;
    expect(slides.map((slide) => slide.english)).toEqual([[EV[0]], [EV[1]], [EC[0]], [EC[1]], [EB[0]], [EB[1]]]);
  });

  it('never replaces English the song already has', () => {
    const typed = { title: 'My Title', slides: { [slideKey(V)]: ['typed by hand'] } };
    const result = englishFromWeb(song, typed, [candidate([ko(V), en(EV), ko(C), en(EC), ko(B), en(EB)], 'Other')]);
    expect(englishUnder(result)).toEqual([['typed by hand'], EC, EB]);
    expect(result.english.title).toBe('My Title');
    expect(result.filled).toBe(2);
  });

  it('lays an English-only post over the song part by part when it has one stanza per part', () => {
    const blocks = [en(['Song of Trial Lyrics']), en(EV), en(EC), en(EV), en(EB), en(EC)];
    expect(englishStanzas(blocks)).toEqual([EV, EC, EB]);
    const result = englishFromWeb(song, empty, [candidate(blocks)]);
    expect(englishUnder(result)).toEqual([EV, EC, EB]);
  });

  it('lays a lyrics site’s English under the conti’s parts of the same name', () => {
    // Genius prints the English original once through, chorus and all, headed by part.
    const blocks = [
      en(EV, 'Verse 1'),
      en(EC, 'Chorus'),
      en(['A second verse we do not sing', 'Another line of it here'], 'Verse 2'),
      en(EC, 'Chorus'),
      en(EB, 'Bridge'),
      en([...EC, 'I lift Your name'], 'Chorus'),
    ];
    const aligned = alignEnglishByLabels(song, blocks)!;
    expect([V, C, B].map((lines) => aligned[slideKey(lines)])).toEqual([EV, EC, EB]);
    const result = englishFromWeb(song, empty, [{ ...candidate(blocks, 'Song of Trial'), url: 'https://genius.com/x-lyrics', host: 'genius.com' }]);
    expect(result.filled).toBe(3);
    expect(englishUnder(result)).toEqual([EV, EC, EB]);
    expect(result.source).toEqual({ url: 'https://genius.com/x-lyrics', host: 'genius.com' });
    expect(result.pasteText).toBeUndefined();
  });

  it('matches numbered parts and Korean headings by name too', () => {
    const numbered: Song = { ...song, sections: [{ label: 'V', lines: V }, { label: 'V2', lines: B }, { label: 'C', lines: C }], order: ['V', 'C', 'V2', 'C'] };
    const aligned = alignEnglishByLabels(numbered, [en(EB, 'Verse 2'), en(EV, '1절'), en(EC, '후렴')])!;
    expect([V, B, C].map((lines) => aligned[slideKey(lines)])).toEqual([EV, EB, EC]);
  });

  it('lays nothing by headings unless two parts agree, or a stanza is far off its part’s length', () => {
    expect(alignEnglishByLabels(song, [en(EV, 'Verse 1'), en(['Only this'], 'Outro')])).toBeNull();
    expect(alignEnglishByLabels(song, [en(EV), en(EC)])).toBeNull();
    const tooLong = Array.from({ length: 7 }, (_, index) => `A line that runs on ${index}`);
    const aligned = alignEnglishByLabels(song, [en(EV, 'Verse 1'), en(tooLong, 'Chorus'), en(EB, 'Bridge')])!;
    expect([V, C, B].map((lines) => aligned[slideKey(lines)])).toEqual([EV, undefined, EB]);
  });

  it('shares a part’s stanza across the slides that part is split into', () => {
    const long: Song = { ...song, sections: [{ label: 'V', lines: [...V, ...C] }], order: ['V'], linesPerSlide: 2 };
    const aligned = alignEnglishOnly(long, [[...EV, ...EC]])!;
    expect(aligned[slideKey(V)]).toEqual(EV);
    expect(aligned[slideKey(C)]).toEqual(EC);
  });

  it('guesses nothing when an English-only post does not fit, and offers it to paste instead', () => {
    const result = englishFromWeb(song, empty, [candidate([en(EV), en([...EC, ...EB, 'One more line here'])])]);
    expect(result.filled).toBe(0);
    expect(englishUnder(result)).toEqual([[], [], []]);
    expect(result.pasteText).toBe([EV.join('\n'), [...EC, ...EB, 'One more line here'].join('\n')].join('\n\n'));
    expect(result.source?.url).toBe('https://a.tistory.com/1');
  });

  it('takes the post that fills the most slides', () => {
    const partial = { ...candidate([ko(V), en(EV)]), url: 'https://b.tistory.com/2', host: 'b.tistory.com' };
    const full = candidate([ko(V), en(EV), ko(C), en(EC), ko(B), en(EB)]);
    expect(englishFromWeb(song, empty, [partial, full]).source?.host).toBe('a.tistory.com');
  });

  it('reads only well-formed candidates off the wire', () => {
    const clean = sanitizeWebEnglishCandidates([
      { url: 'https://a.tistory.com/1', host: 'a.tistory.com', title: 't', englishTitle: 'E', score: 1, blocks: [{ lang: 'en', lines: ['x y', 3] }, { lang: 'fr', lines: ['z'] }] },
      { url: 'javascript:alert(1)', blocks: [{ lang: 'en', lines: ['x'] }] },
      null,
    ]);
    expect(clean).toEqual([
      { url: 'https://a.tistory.com/1', host: 'a.tistory.com', title: 't', englishTitle: 'E', score: 1, blocks: [{ lang: 'en', lines: ['x y'] }] },
    ]);
  });
});

describe('the AI, given the English found on the web', () => {
  it('is told to use only those lines', () => {
    const prompt = buildEnglishPrompt('시험의 노래', [V, C], [...EV, ...EC]);
    expect(prompt).toContain('Use ONLY these lines');
    expect(prompt).toContain(EV[0]);
  });

  it('keeps only lines that are in the English it was given', () => {
    const reference = webEnglishReference([candidate([ko(V), en(EV), en(EC)])]);
    expect(reference).toEqual([...EV, ...EC]);
    const kept = keepReferenceLines({ englishTitle: '', slides: [[EV[0], 'A line it made up'], [EC[1].toUpperCase()]] }, reference);
    expect(kept.slides).toEqual([[EV[0]], [EC[1].toUpperCase()]]);
    expect(() => keepReferenceLines({ englishTitle: '', slides: [['made up']] }, reference)).toThrow();
  });
});
