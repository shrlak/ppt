// Assembles the 수요예배 deck.
//
// The order is fixed — it is the church's own service order, taken from the
// deck this template was derived from:
//
//   표지 · 인트로 · 경배와 찬양
//     곡마다: [찬양 제목] + [그 곡 PPT의 모든 슬라이드, 또는 악보 사진 한 장씩]
//   기도 · 말씀 · 말씀 본문 ×N · 설교 · 기도 · 합심기도 · 마지막
//
// 설교 slides are not generated: the deck stops at the 설교 구분 장 and the
// pastor's own file is dropped in after it by hand.
//
// Everything fixed comes out of public/wednesday-template.pptx in a single
// extractSlideSubset call. That matters for size as much as for speed: the
// template carries a 2 MB EMF cover background, and one call per segment would
// copy it once per call (mergePptxDecks namespaces the parts it copies, so it
// cannot dedupe them).
import JSZip from 'jszip';
import { assertPptxIntegrity } from '../lib/pptx/pptxPackage';
import { extractSlideSubset, slideOrderOf } from '../lib/pptx/pptxSlices';
import { mergePptxDecks } from '../lib/pptx/pptxMerge';
import { readSlideSize, rescaleDeckToSize, type SlideSize } from '../lib/pptx/slideGeometry';
import { buildImageDeck } from '../lib/pptx/imageDeckBuilder';
import { expandDeckSegment, type DeckOverviewItem } from '../lib/utils/deckOverview';
import type { Verse } from '../bible/types';
import { buildWednesdayVerseSlide, groupVerses } from './bibleSlides';
import { clearRemainingTokens, formatDateDot, formatDateKo, substituteTokens } from './fields';
import { WEDNESDAY_IMAGE_CARRIER, WEDNESDAY_SLIDES } from './template';
import { isAttached, songSlideCount, type WednesdayService, type WednesdaySong } from './types';

export interface WednesdayDeckInput {
  /** public/wednesday-template.pptx. */
  template: ArrayBuffer | Uint8Array;
  service: WednesdayService;
  songs: WednesdaySong[];
  /** 개역개정 본문, already resolved by the caller (bibleData.getVerseUnits). */
  verses: Verse[];
  /** The passage as the deck spells it, e.g. "시편 18편 1-12절". */
  rangeKo: string;
}

export interface WednesdayDeckResult {
  deck: Uint8Array;
  /** One row per real slide, for the download screen's slide list. */
  overview: DeckOverviewItem[];
  /** Things the operator should know, e.g. a song deck that had to be resized. */
  warnings: string[];
}

/** What each skeleton slide is, so the substitution pass knows what to fill. */
type SlotKind =
  | 'cover'
  | 'intro'
  | 'worship'
  | 'songTitle'
  | 'prayer'
  | 'wordDivider'
  | 'wordBody'
  | 'sermonDivider'
  | 'sermonPrayer'
  | 'unifiedPrayer'
  | 'closing';

interface Slot {
  kind: SlotKind;
  /** Template slide position this slot is cloned from. */
  source: number;
  /** Which song this 찬양 제목 slide belongs to. */
  songIndex?: number;
  /** Which verse group this 말씀 본문 slide carries. */
  groupIndex?: number;
}

/** The fixed order, expanded for this week's song and verse-group counts. */
export function planWednesdaySlots(songCount: number, verseGroupCount: number): Slot[] {
  const slots: Slot[] = [
    { kind: 'cover', source: WEDNESDAY_SLIDES.cover },
    { kind: 'intro', source: WEDNESDAY_SLIDES.intro },
    { kind: 'worship', source: WEDNESDAY_SLIDES.worship },
  ];
  for (let i = 0; i < songCount; i++) {
    slots.push({ kind: 'songTitle', source: WEDNESDAY_SLIDES.songTitle, songIndex: i });
  }
  slots.push({ kind: 'prayer', source: WEDNESDAY_SLIDES.prayer });
  slots.push({ kind: 'wordDivider', source: WEDNESDAY_SLIDES.wordDivider });
  for (let i = 0; i < verseGroupCount; i++) {
    slots.push({ kind: 'wordBody', source: WEDNESDAY_SLIDES.wordBody, groupIndex: i });
  }
  slots.push({ kind: 'sermonDivider', source: WEDNESDAY_SLIDES.sermonDivider });
  slots.push({ kind: 'sermonPrayer', source: WEDNESDAY_SLIDES.sermonPrayer });
  slots.push({ kind: 'unifiedPrayer', source: WEDNESDAY_SLIDES.unifiedPrayer });
  slots.push({ kind: 'closing', source: WEDNESDAY_SLIDES.closing });
  return slots;
}

function preacherLine(service: WednesdayService): string {
  return [service.preacher.trim(), service.preacherTitle.trim()].filter(Boolean).join(' ');
}

/** Build the fixed slides: one template copy, then fill each slot's text. */
async function buildSkeleton(
  input: WednesdayDeckInput,
  slots: Slot[],
  verseGroups: Verse[][],
  compression: 'STORE' | 'DEFLATE',
): Promise<Uint8Array> {
  const skeleton = await extractSlideSubset(
    input.template,
    slots.map((slot) => slot.source),
    'STORE',
  );

  const zip = await JSZip.loadAsync(skeleton);
  const names = await slideOrderOf(zip);
  if (names.length !== slots.length) {
    throw new Error(`수요예배 골격 슬라이드 수가 맞지 않습니다 (${names.length}/${slots.length}).`);
  }

  const { service } = input;
  const common = {
    DATE_KO: formatDateKo(service.date),
    DATE_DOT: formatDateDot(service.date),
    SERMON_TITLE: service.sermonTitle.trim(),
    RANGE_KO: input.rangeKo,
    PREACHER: service.preacher.trim(),
    PREACHER_TITLE: service.preacherTitle.trim(),
    PREACHER_LINE: preacherLine(service),
  };

  for (const [index, slot] of slots.entries()) {
    const path = `ppt/slides/${names[index]}`;
    const xml = await zip.file(path)!.async('string');

    let filled: string;
    if (slot.kind === 'wordBody') {
      filled = buildWednesdayVerseSlide(xml, verseGroups[slot.groupIndex!], input.rangeKo);
    } else if (slot.kind === 'songTitle') {
      filled = substituteTokens(xml, {
        SONG_TITLE: input.songs[slot.songIndex!].title.trim(),
      });
    } else {
      filled = substituteTokens(xml, common);
    }

    zip.file(path, clearRemainingTokens(filled));
  }

  return zip.generateAsync({ type: 'uint8array', compression });
}

/** Overview rows for the fixed slides, in slot order. */
function skeletonOverview(slots: Slot[], input: WednesdayDeckInput, verseGroups: Verse[][]): DeckOverviewItem[] {
  return slots.map((slot, index) => {
    const id = `wednesday-${slot.kind}-${index}`;
    switch (slot.kind) {
      case 'cover':
        return { id, kind: 'front' as const, label: '표지', subtitle: input.service.sermonTitle || undefined };
      case 'intro':
        return { id, kind: 'front' as const, label: '수요예배', subtitle: formatDateDot(input.service.date) || undefined };
      case 'worship':
        return { id, kind: 'divider' as const, label: '경배와 찬양' };
      case 'songTitle':
        return {
          id,
          kind: 'lyrics-title' as const,
          label: input.songs[slot.songIndex!].title || '(제목 없음)',
          subtitle: '찬양',
          songId: input.songs[slot.songIndex!].id,
        };
      case 'prayer':
      case 'sermonPrayer':
        return { id, kind: 'prayer' as const, label: '기도' };
      case 'wordDivider':
        return { id, kind: 'divider' as const, label: '말씀', subtitle: input.rangeKo || undefined };
      case 'wordBody': {
        const group = verseGroups[slot.groupIndex!];
        return {
          id,
          kind: 'bible' as const,
          label: input.rangeKo || '말씀',
          subtitle: group.map((verse) => verse.verse).join(', ') + '절',
        };
      }
      case 'sermonDivider':
        return {
          id,
          kind: 'sermon' as const,
          label: '설교',
          subtitle: '설교 슬라이드는 이 뒤에 직접 넣으세요',
        };
      case 'unifiedPrayer':
        return { id, kind: 'prayer' as const, label: '합심기도' };
      case 'closing':
      default:
        return { id, kind: 'back' as const, label: '성령으로 봉사하는 교회' };
    }
  });
}

/** A song's rows: one per slide its own deck contributes. */
function songOverview(song: WednesdaySong, slideCount: number): DeckOverviewItem[] {
  return expandDeckSegment({
    kind: 'lyrics',
    count: slideCount,
    labelAt: () => song.title || '(제목 없음)',
    subtitleAt: (index, count) => `${index + 1}/${count}`,
  }).map((item, index) => ({ ...item, id: `wednesday-song-${song.id}-${index}`, songId: song.id }));
}

/**
 * Build the whole deck. Songs with no file attached still get their 찬양 제목
 * slide, so a set list can be assembled before every file is in hand.
 */
export async function buildWednesdayDeck(input: WednesdayDeckInput): Promise<WednesdayDeckResult> {
  const verseGroups = groupVerses(input.verses, input.service.versesPerSlide);
  const slots = planWednesdaySlots(input.songs.length, verseGroups.length);
  const warnings: string[] = [];

  const attached = input.songs.map((song) => (isAttached(song) ? song : null));
  const songMerges = attached.filter((song) => song !== null).length;

  // The last zip written is the one that reaches disk, so it is the only one
  // worth deflating; everything before it is repacked again anyway.
  let deck = await buildSkeleton(input, slots, verseGroups, songMerges === 0 ? 'DEFLATE' : 'STORE');
  const templateSize = await readSlideSize(deck);

  // Songs back to front: inserting the later ones first leaves the earlier
  // insertion points where the skeleton put them.
  const songSlideCounts = new Map<string, number>();
  let remainingMerges = songMerges;
  for (let index = input.songs.length - 1; index >= 0; index--) {
    const song = attached[index];
    if (!song) continue;

    const songDeck = await songSlides(song, input.template, templateSize, warnings);
    remainingMerges -= 1;
    // A 찬양 제목 slide sits at 3 + index; its song's slides follow it.
    deck = await mergePptxDecks(deck, songDeck, {
      insertAt: 4 + index,
      compression: remainingMerges === 0 ? 'DEFLATE' : 'STORE',
    });
    songSlideCounts.set(song.id, songSlideCount(song));
  }

  await assertPptxIntegrity(deck);

  // Overview rows follow the same interleaving as the slides themselves.
  const overview: DeckOverviewItem[] = [];
  const skeletonRows = skeletonOverview(slots, input, verseGroups);
  for (const [index, slot] of slots.entries()) {
    overview.push(skeletonRows[index]);
    if (slot.kind !== 'songTitle') continue;
    const song = input.songs[slot.songIndex!];
    const count = songSlideCounts.get(song.id);
    if (count) overview.push(...songOverview(song, count));
  }

  return { deck, overview, warnings };
}

/**
 * The slides one song contributes: its own 찬양 PPT, or one slide per 악보
 * 사진 built on the service template so the pages sit on the deck's own
 * background at the deck's own size.
 */
async function songSlides(
  song: WednesdaySong,
  template: ArrayBuffer | Uint8Array,
  templateSize: SlideSize,
  warnings: string[],
): Promise<Uint8Array> {
  if (!song.deck) {
    return buildImageDeck(
      template,
      (song.images ?? []).map((image) => ({
        data: new Uint8Array(image.data.slice(0)),
        mimeType: image.mimeType,
        width: image.width,
        height: image.height,
      })),
      { slideNumber: WEDNESDAY_IMAGE_CARRIER, canvas: templateSize, compression: 'STORE' },
    );
  }

  const { data, rescaled, from } = await rescaleDeckToSize(song.deck, templateSize, 'STORE');
  if (rescaled) {
    warnings.push(
      `"${song.title || '제목 없음'}" 곡 PPT는 슬라이드 크기가 달라(${from.cx}×${from.cy}) 이 예배 PPT 크기에 맞게 자동으로 맞췄습니다. 위치를 한 번 확인해 주세요.`,
    );
  }
  return data;
}
