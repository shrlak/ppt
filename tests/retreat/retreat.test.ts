import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { parseRetreatConti } from '../../src/retreat/conti';
import { buildRetreatDeck } from '../../src/retreat/deckBuilder';
import { planRetreatSession, suggestRetreatFileName, titleLines } from '../../src/retreat/planner';
import { resolveRetreatPassage, type BibleLoader } from '../../src/retreat/scripture';
import { libraryLyricsText, lyricSlides, resolveSong, sanitizeSongSeeds } from '../../src/retreat/songs';
import {
  attachPosters,
  decodeRetreatPosters,
  decodeRetreatSource,
  encodeRetreatPosters,
  encodeRetreatSource,
  isRetreatSource,
} from '../../src/retreat/source';
import { applyConti } from '../../src/retreat/state';
import { createBlock, defaultRetreat, type RetreatSession } from '../../src/retreat/types';
import { decodeDeckSource } from '../../src/lib/storage/deckSource';
import { findBrokenRelationships } from '../../src/lib/pptx/pptxPackage';
import { slideOrderOf } from '../../src/lib/pptx/pptxSlices';
import type { BookChapters } from '../../src/bible/types';

const root = join(__dirname, '..', '..');
const template = readFileSync(join(root, 'public', 'retreat-template.pptx'));
const seeds = sanitizeSongSeeds(JSON.parse(readFileSync(join(root, 'public', 'retreat-songs.json'), 'utf8')));
// This year's conti page 1, as the PDF's text layer reads it — plus one "X"
// the way a struck song is marked on the planning sheet.
const contiText = readFileSync(join(root, 'tests', 'fixtures', 'retreat-conti.txt'), 'utf8');

const loadBible: BibleLoader = async (translation) => {
  const file = translation === 'nkrv' ? 'ko_nkrv.json' : 'en_esv.json';
  const raw = JSON.parse(readFileSync(join(root, 'public', 'bible-text', file), 'utf8')) as { chapters: BookChapters }[];
  return new Map(raw.map((book, index) => [index + 1, book.chapters]));
};

async function slideTexts(deck: Uint8Array): Promise<string[]> {
  const zip = await JSZip.loadAsync(deck);
  const texts: string[] = [];
  for (const name of await slideOrderOf(zip)) {
    const xml = await zip.file(`ppt/slides/${name}`)!.async('string');
    texts.push([...xml.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((match) => match[1]).filter(Boolean).join(' | '));
  }
  return texts;
}

describe('parseRetreatConti', () => {
  const slots = parseRetreatConti(contiText);

  it('reads every column with its header, joining wrapped titles and dropping markers', () => {
    expect(slots.map((slot) => slot.label)).toEqual([
      '금요일 오후 예배 (20m, 4곡)',
      '금요일 오후 기도회 (30m)',
      '토요일 오전 특강 (15m, 3곡)',
      '토요일 오후 예배 (15m, 3곡)',
      '토요일 오후 기도회 (30m)',
      '토요일 오후 찬양집회 (40m)',
      '주일 예배 (20m)',
    ]);
    expect(slots[0].songs).toEqual(['주 안에서 기뻐해', '내 안에 부어 주소서', '모두 찬양해', '하나님의 등불']);
    expect(slots[5].songs).toHaveLength(10);
    expect(slots[5].songs[5]).toBe('하나님께서 세상을 사랑하사');
    expect(slots[5].songs[9]).toBe('하나님의 사랑이');
    expect(slots[6].songs.at(-1)).toBe('Celebrate the Light');
  });

  it('knows which part of the retreat each column is, and leaves struck songs out', () => {
    expect(slots.map((slot) => slot.key)).toEqual([
      { day: '금', part: '예배' },
      { day: '금', part: '기도회' },
      { day: '토', part: '특강' },
      { day: '토', part: '예배' },
      { day: '토', part: '기도회' },
      { day: '토', part: '찬양집회' },
      { day: '주일', part: '예배' },
    ]);
    expect(slots[6].songs).not.toContain('주 이름 찬양');
  });
});

describe('applyConti', () => {
  it('puts each column into its session block, and 주일 into the closing list', () => {
    const resolve = (title: string) => resolveSong(title, seeds, []);
    const { state, unplaced } = applyConti(defaultRetreat(), parseRetreatConti(contiText), resolve);
    expect(unplaced).toEqual([]);
    const [friday, lecture, saturday] = state.sessions;
    const songsOf = (session: RetreatSession, label: string) =>
      session.blocks.flatMap((block) => (block.kind === 'songs' && block.label === label ? block.songs.map((s) => s.title) : []));
    expect(songsOf(friday, '찬양')).toEqual(['주 안에서 기뻐해', '내 안에 부어 주소서', '모두 찬양해', '하나님의 등불']);
    expect(songsOf(friday, '기도회')[1]).toBe('여호와께 돌아가자');
    expect(songsOf(lecture, '찬양')).toHaveLength(3);
    expect(songsOf(saturday, '찬양집회')).toHaveLength(10);
    expect(state.closingSongs).toContain('예수 열방의 소망');
  });
});

describe('song lyrics', () => {
  it('fills a song last year projected, split exactly as it was shown', () => {
    const song = resolveSong('주 안에서 기뻐해', seeds, []);
    expect(song.source).toBe('retreat');
    expect(lyricSlides(song.lyrics)[0]).toEqual(['주 안에서 기뻐해', '주 안에서 기뻐해', '주님 주신 기쁨으로 기뻐하라']);
  });

  it('matches a title regardless of spacing, and falls back to the 찬양 라이브러리', () => {
    expect(resolveSong('내 안에 부어 주소서', seeds, []).source).toBe('retreat');
    const library = [{ title: '새 노래', sections: [{ label: 'V', lines: ['하나', '둘', '셋', '넷', '다섯'] }], order: ['V'] }];
    const song = resolveSong('새 노래', seeds, library);
    expect(song.source).toBe('library');
    expect(lyricSlides(song.lyrics)).toEqual([['하나', '둘', '셋'], ['넷', '다섯']]);
    expect(libraryLyricsText(library[0])).toBe('하나\n둘\n셋\n\n넷\n다섯');
    expect(resolveSong('모르는 곡', seeds, []).lyrics).toBe('');
  });

  it('splits on blank lines, and evenly past four lines', () => {
    expect(lyricSlides('a\nb\n\nc\nd\ne\nf\ng\nh')).toEqual([['a', 'b'], ['c', 'd', 'e'], ['f', 'g', 'h']]);
  });
});

describe('planning and file names', () => {
  it('prints the retreat title in two runs, with its quotes', () => {
    expect(titleLines({ title: '2027 빛주사랑 겨울 수련회', subtitle: '', theme: '' })).toEqual(['“2027', ' 빛주사랑 겨울 수련회”']);
  });

  it('names each session’s file after its date and kind', () => {
    const [friday, lecture] = defaultRetreat().sessions;
    expect(suggestRetreatFileName({ ...friday, date: '2027-01-15' }, 0)).toBe('0115_Retreat_Evening.pptx');
    expect(suggestRetreatFileName({ ...lecture, date: '2027-01-16' }, 1)).toBe('0116_Retreat_Lecture.pptx');
  });

  it('skips an empty passage and leaves the cover out until a poster is given', () => {
    const plans = planRetreatSession(defaultRetreat().sessions[0]);
    expect(plans[0].kind).toBe('title');
    expect(plans.some((plan) => plan.kind === 'passage')).toBe(false);
    expect(plans.map((plan) => plan.kind)).toEqual(
      expect.arrayContaining(['section', 'sermon', 'blank', 'prayer', 'benediction', 'announcementDivider']),
    );
  });
});

describe('buildRetreatDeck', () => {
  it('builds a first-night deck in the retreat design, as a valid package', async () => {
    const base = defaultRetreat();
    const resolve = (title: string) => resolveSong(title, seeds, []);
    const { state } = applyConti(base, parseRetreatConti(contiText), resolve);
    const friday = structuredClone(state.sessions[0]);
    for (const block of friday.blocks) {
      if (block.kind === 'scripture') block.passage = '마14:22-24';
      if (block.kind === 'sermon') block.title = 'Go Beyond the Visible';
      if (block.kind === 'announcements') block.text = '1. 환영합니다\n아침식사 후 큐티 (pg. 10)\n숙소배정 (pg. 34)';
    }
    const scripture = friday.blocks.find((block) => block.kind === 'scripture')!;
    const passage = await resolveRetreatPassage('마14:22-24', loadBible);
    expect(passage?.passageKo).toBe('마태복음 14장 22-24절');
    expect(passage?.passageEn).toBe('Matthew 14:22-24');

    const { deck, overview } = await buildRetreatDeck({
      template,
      info: state.info,
      session: friday,
      passages: { [scripture.id]: passage },
    });
    const texts = await slideTexts(deck);
    expect(texts).toHaveLength(overview.length);
    expect(texts[0]).toBe('“2026 |  빛주사랑 겨울 수련회” | 피츠버그 한인 중앙교회 대학청년부');
    expect(texts[1]).toBe('찬양');
    expect(texts[2]).toBe('주 안에서 기뻐해');
    expect(texts[3]).toBe('주 안에서 기뻐해 | 주 안에서 기뻐해 | 주님 주신 기쁨으로 기뻐하라 | 주 안에서 기뻐해');
    expect(texts).toContain('설교말씀 | 마태복음 14장 22-24절');
    const verse = texts.find((text) => text.startsWith('22 | '))!;
    expect(verse).toContain('마태복음 14장 22-24절 | Matthew 14:22-24 | 22 Immediately he made the disciples');
    expect(texts).toContain('설교 | “Go Beyond the Visible”');
    expect(texts).toContain('기도회');
    expect(texts).toContain('OT | 광고');
    expect(texts.at(-1)).toBe(
      '1. &lt;환영합니다&gt; | 아침식사 후 큐티 (pg. 10) | 숙소배정 (pg. 34) | 2026 빛주사랑 겨울 수련회 | 불과 폭풍 속에서도, 주와 함께 걷는 길 (이사야 43:1-2)',
    );

    const zip = await JSZip.loadAsync(deck);
    expect(await findBrokenRelationships(zip)).toEqual([]);
    const allXml = await Promise.all(
      Object.keys(zip.files).filter((path) => /^ppt\/slides\/slide\d+\.xml$/.test(path)).map((path) => zip.file(path)!.async('string')),
    );
    expect(allXml.join('')).not.toContain('{{');
  });

  it('puts the session poster on the cover, centred on its own colour', async () => {
    const png = readFileSync(join(root, 'tests', 'fixtures', 'sheet-page.png'));
    const session: RetreatSession = {
      id: 's1',
      name: '금요일 저녁예배',
      date: '2027-01-15',
      poster: {
        name: 'poster.png',
        mimeType: 'image/png',
        data: png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength) as ArrayBuffer,
        width: 800,
        height: 1000,
        background: 'C4BEAB',
      },
      blocks: [createBlock('title')],
    };
    const { deck, overview } = await buildRetreatDeck({ template, info: defaultRetreat().info, session });
    expect(overview.map((row) => row.label)).toEqual(['표지', '수련회 제목']);
    const zip = await JSZip.loadAsync(deck);
    const [cover] = await slideOrderOf(zip);
    const xml = await zip.file(`ppt/slides/${cover}`)!.async('string');
    // 800×1000 on a 4:3 slide: full height, centred.
    expect(xml).toContain('<a:ext cx="5486400" cy="6858000"/>');
    expect(xml).toContain('<a:off x="1828800" y="0"/>');
    expect(await zip.file(`ppt/slides/_rels/${cover}.rels`)!.async('string')).toContain('media/retreat-poster.png');
    expect(await findBrokenRelationships(zip)).toEqual([]);
  });

  it('shrinks a verse too long for its box instead of letting it run over', async () => {
    const session: RetreatSession = { ...defaultRetreat().sessions[0], blocks: [{ ...createBlock('scripture'), passage: '에1:1' } as never] };
    const scripture = session.blocks[0];
    const passage = await resolveRetreatPassage('에1:1', loadBible);
    const { deck } = await buildRetreatDeck({
      template,
      info: defaultRetreat().info,
      session,
      passages: { [scripture.id]: passage },
    });
    const zip = await JSZip.loadAsync(deck);
    const names = await slideOrderOf(zip);
    const xml = await zip.file(`ppt/slides/${names[1]}`)!.async('string');
    const sizes = [...xml.matchAll(/<a:rPr[^>]*\bsz="(\d+)"/g)].map((match) => Number(match[1]));
    expect(Math.min(...sizes)).toBeLessThan(3050);
  });
});

describe('retreat snapshot', () => {
  it('round-trips the retreat and its posters, and is never read as a Sunday snapshot', async () => {
    const state = defaultRetreat();
    const png = readFileSync(join(root, 'tests', 'fixtures', 'sheet-page.png'));
    state.sessions[0].poster = {
      name: 'p.png',
      mimeType: 'image/png',
      data: png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength) as ArrayBuffer,
      width: 10,
      height: 20,
      background: 'ABCDEF',
    };
    state.closingSongs = ['입례'];
    const file = encodeRetreatSource(state, state.sessions[0].id);
    expect(isRetreatSource(file)).toBe(true);
    expect(decodeDeckSource(file)).toBeNull();

    const decoded = decodeRetreatSource(file)!;
    expect(decoded.sessionId).toBe(state.sessions[0].id);
    const posters = await decodeRetreatPosters(await encodeRetreatPosters(state));
    const restored = attachPosters(decoded.state, posters);
    expect(restored.sessions.map((session) => session.name)).toEqual(state.sessions.map((session) => session.name));
    expect(restored.sessions[0].poster?.data.byteLength).toBe(png.byteLength);
    expect(restored.sessions[0].poster?.background).toBe('ABCDEF');
    expect(restored.sessions[0].blocks.map((block) => block.kind)).toEqual(state.sessions[0].blocks.map((block) => block.kind));
    expect(restored.closingSongs).toEqual(['입례']);
  });
});
