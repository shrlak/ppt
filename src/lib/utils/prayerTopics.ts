// The week's 기도제목, as the 대청부 posts them, shared out over the 기도 준비
// slide that opens the 주일예배 deck ("지금은 기도로 예배를 준비하는 시간입니다.").
//
//   1. 회개와 마음의 정결
//   - 지난 한 주간 하나님보다 앞세웠던 생각과 욕심, 불순종을 돌아보고 …
//   - 우리의 죄를 용서하신 예수 그리스도의 은혜를 기억하며, …
//
//   2. 예배를 위한 기도
//   - …
//
// Each numbered line starts a topic and the `-` lines under it are its
// points. The slide takes up to three topics; four go two to a slide, and a
// slide whose topics would have to shrink below a readable size hands the
// overflow to another copy of the slide. Kept free of any .pptx handling so
// the 기도제목 step can show the same split the deck will get.
import { stripEmphasis } from './announcementBuilder';
import { textWidthEm } from '../pptx/textFit';

export interface PrayerTopic {
  /** The topic's title, without its number: "회개와 마음의 정결". */
  title: string;
  /** The `-` lines under it, in order. */
  points: string[];
}

/**
 * One block of a slide: a topic, or part of one when a topic is too long for
 * a slide by itself. `number` is the topic's place in the whole list (1-based),
 * so a topic on the second slide keeps its number.
 */
export interface PrayerTopicBlock {
  number: number;
  title: string;
  points: string[];
}

export interface PrayerTopicPage {
  blocks: PrayerTopicBlock[];
  /** Font size (1/100 pt) every line on this slide is drawn at. */
  sz: number;
}

/**
 * The text box the topics are written into, in points, less its insets: the
 * front deck's 기도제목 box (8.5" wide) run down to 0.4" above the slide's
 * bottom edge, which is how prayerTopicSlides.ts writes it.
 */
export interface PrayerTopicBox {
  widthPt: number;
  heightPt: number;
  /** How far a point's text sits in from the box's left edge. */
  pointIndentPt: number;
}

export const DEFAULT_TOPIC_BOX: PrayerTopicBox = {
  widthPt: 597.6,
  heightPt: 360,
  pointIndentPt: 36,
};

/** The front deck draws its 기도제목 at 20pt; nothing is drawn larger. */
export const TOPIC_BASE_SZ = 2000;
/** A slide that would need less than this hands topics on to another slide. */
export const TOPIC_SPLIT_SZ = 1600;
/** The least a single topic too long for any slide is shrunk to. */
export const TOPIC_MIN_SZ = 1200;
/** Topics on one slide at most, however short they are. */
export const MAX_TOPICS_PER_SLIDE = 3;

// Paragraph spacing as a share of the font size, so it shrinks with the text.
/** Space above a topic that follows another one on the slide. */
export const TOPIC_GAP_EM = 0.8;
/** Space between a topic's title and its first point. */
export const TITLE_AFTER_EM = 0.3;
/** Space after each point. */
export const POINT_AFTER_EM = 0.2;
/** Space after a topic with no points (the template's 48pt gap at 20pt). */
export const LONE_TITLE_AFTER_EM = 2.4;

// ---- reading the pasted text -----------------------------------------------

/**
 * "1." "1)" "(1)" "①" "1:" — a numbered topic line; the title follows. A
 * digit right after the mark ("1.5", "10:30") is a number, not a topic.
 */
const NUMBERED = /^\s*(?:\(\s*\d{1,2}\s*\)|\d{1,2}\s*[.)．:](?!\d)|[①-⑳])\s*(.*)$/;
/** "-", "•", "·", "*", "–", "●", "▪", "○" — a point under the topic above. */
const BULLETED = /^\s*[-–—•·∙●○▪■*+]+\s*(.*)$/;

function cleanLine(text: string): string {
  return stripEmphasis(text).replace(/\s+/g, ' ').trim();
}

/**
 * The topics in pasted 기도제목 text. Numbered lines start topics and the
 * bulleted (or plain) lines under one are its points; anything above the
 * first numbered line ("7/12 주일 기도제목") is a header and left out. Text
 * with no numbered lines at all is read one topic per line, each bulleted
 * line under a plain one becoming that topic's point.
 */
export function parsePrayerTopics(text: string): PrayerTopic[] {
  const lines = text.split(/\r?\n/).map((line) => stripEmphasis(line.trim()));
  const numbered = lines.some((line) => NUMBERED.test(line) && cleanLine(line.match(NUMBERED)![1]));
  const topics: PrayerTopic[] = [];
  let current: PrayerTopic | null = null;

  for (const line of lines) {
    if (!line || /^[-*_~=\s]+$/.test(line)) continue;
    const heading = line.match(NUMBERED);
    if (numbered) {
      if (heading && cleanLine(heading[1])) {
        current = { title: cleanLine(heading[1]), points: [] };
        topics.push(current);
      } else if (current) {
        const point = cleanLine(line.match(BULLETED)?.[1] ?? line);
        if (point) current.points.push(point);
      }
      continue;
    }
    const bullet = line.match(BULLETED);
    if (bullet && current) {
      const point = cleanLine(bullet[1]);
      if (point) current.points.push(point);
      continue;
    }
    const title = cleanLine(bullet ? bullet[1] : line);
    if (!title) continue;
    // Only a plain line takes the bulleted lines under it as points; a
    // bulleted line with no plain line above it is a topic of its own.
    const topic: PrayerTopic = { title, points: [] };
    topics.push(topic);
    current = bullet ? null : topic;
  }
  return topics;
}

// ---- measuring ---------------------------------------------------------------

/**
 * Lines `text` wraps to in a column `columnEm` wide, breaking between words
 * the way PowerPoint wraps Korean by 어절 — a word that would not fit on the
 * line goes to the next one whole, and only a word longer than the column is
 * broken inside.
 */
export function wrappedLineCount(text: string, columnEm: number): number {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return 1;
  const space = textWidthEm(' ');
  let lines = 1;
  let used = 0;
  for (const word of words) {
    const width = textWidthEm(word);
    const needed = used === 0 ? width : used + space + width;
    if (needed <= columnEm) {
      used = needed;
      continue;
    }
    if (used > 0) lines++;
    // A word wider than the whole column runs on over as many lines as it fills.
    lines += Math.max(0, Math.ceil(width / columnEm) - 1);
    used = width % columnEm || Math.min(width, columnEm);
  }
  return lines;
}

/** True when any block on the slides lists points, which sets the layout for all of them. */
export function hasPoints(blocks: readonly { points: string[] }[]): boolean {
  return blocks.some((block) => block.points.length > 0);
}

/**
 * Height (pt) `blocks` take at `sz`, laid out as prayerTopicSlides.ts writes
 * them: a bold "N. title" with its points bulleted under it when the list has
 * points, or one bulleted line per topic (the front deck's own 기도제목 1 /
 * 기도제목 2 look) when none does.
 */
export function blocksHeightPt(
  blocks: readonly PrayerTopicBlock[],
  sz: number,
  structured: boolean,
  box: PrayerTopicBox = DEFAULT_TOPIC_BOX,
): number {
  const fontPt = sz / 100;
  // ~1.2 × font size is the single-line box PowerPoint spaces at 100%.
  const lineHeight = fontPt * 1.2;
  const titleColumn = (structured ? box.widthPt : box.widthPt - box.pointIndentPt) / fontPt;
  const pointColumn = (box.widthPt - box.pointIndentPt) / fontPt;
  let height = 0;
  blocks.forEach((block, index) => {
    if (!structured) {
      height += wrappedLineCount(block.title, titleColumn) * lineHeight;
      if (index < blocks.length - 1) height += LONE_TITLE_AFTER_EM * fontPt;
      return;
    }
    if (index > 0) height += TOPIC_GAP_EM * fontPt;
    height += wrappedLineCount(`${block.number}. ${block.title}`, titleColumn) * lineHeight;
    if (block.points.length > 0) height += TITLE_AFTER_EM * fontPt;
    block.points.forEach((point, pointIndex) => {
      height += wrappedLineCount(point, pointColumn) * lineHeight;
      if (pointIndex < block.points.length - 1) height += POINT_AFTER_EM * fontPt;
    });
  });
  return height;
}

/**
 * The largest size (1/100 pt, steps of 100, at most TOPIC_BASE_SZ) at which
 * `blocks` fit the box; `floor` when even that is too big.
 */
export function blocksFontSize(
  blocks: readonly PrayerTopicBlock[],
  structured: boolean,
  floor: number = TOPIC_MIN_SZ,
  box: PrayerTopicBox = DEFAULT_TOPIC_BOX,
): number {
  for (let sz = TOPIC_BASE_SZ; sz > floor; sz -= 100) {
    if (blocksHeightPt(blocks, sz, structured, box) <= box.heightPt) return sz;
  }
  return floor;
}

function fitsAtSplitSize(blocks: readonly PrayerTopicBlock[], structured: boolean, box: PrayerTopicBox): boolean {
  return blocksHeightPt(blocks, TOPIC_SPLIT_SZ, structured, box) <= box.heightPt;
}

// ---- sharing the topics out over slides ---------------------------------------

/**
 * A topic as the blocks it takes: itself, or — when even a slide of its own
 * cannot hold it at the split size — runs of its points, each under the
 * topic's own title, as few as it takes and as even as they fit. A point is
 * never broken up.
 */
function blocksOfTopic(topic: PrayerTopic, number: number, structured: boolean, box: PrayerTopicBox): PrayerTopicBlock[] {
  const block = (points: string[]): PrayerTopicBlock => ({ number, title: topic.title, points });
  if (topic.points.length <= 1 || fitsAtSplitSize([block(topic.points)], structured, box)) {
    return [block(topic.points)];
  }
  // Fill each run in turn to learn how many runs it takes…
  const filled: string[][] = [];
  let run: string[] = [];
  for (const point of topic.points) {
    if (run.length > 0 && !fitsAtSplitSize([block([...run, point])], structured, box)) {
      filled.push(run);
      run = [];
    }
    run.push(point);
  }
  if (run.length > 0) filled.push(run);
  // …then share the points out evenly over that many, fuller at the front,
  // unless an even share leaves a run too long.
  const even: string[][] = [];
  let at = 0;
  for (let i = 0; i < filled.length; i++) {
    const length = Math.ceil((topic.points.length - at) / (filled.length - i));
    even.push(topic.points.slice(at, at + length));
    at += length;
  }
  const runs = even.every((points) => fitsAtSplitSize([block(points)], structured, box)) ? even : filled;
  return runs.map(block);
}

/**
 * Every way to cut `count` blocks, in order, into `pages` runs of 1…`max`
 * blocks — the ones with the fuller first slide first.
 */
function* cuts(count: number, pages: number, max: number): Generator<number[]> {
  if (pages === 1) {
    if (count >= 1 && count <= max) yield [count];
    return;
  }
  for (let first = Math.min(max, count - (pages - 1)); first >= 1; first--) {
    for (const rest of cuts(count - first, pages - 1, max)) yield [first, ...rest];
  }
}

/** How lopsided a cut is: the spread between its fullest and emptiest slide. */
function spread(sizes: number[]): number {
  return Math.max(...sizes) - Math.min(...sizes);
}

/**
 * The fewest slides the blocks go onto with at most MAX_TOPICS_PER_SLIDE
 * each, every slide still readable (TOPIC_SPLIT_SZ or larger); of the cuts
 * that do it, the one whose smallest text is largest, then the most even,
 * then the one fuller at the front. A list too long to try every cut falls
 * back to filling each slide in turn.
 */
function shareOut(blocks: PrayerTopicBlock[], structured: boolean, box: PrayerTopicBox): PrayerTopicBlock[][] {
  const fits = (run: PrayerTopicBlock[]) => fitsAtSplitSize(run, structured, box);
  if (blocks.length > 18) {
    const pages: PrayerTopicBlock[][] = [];
    let page: PrayerTopicBlock[] = [];
    for (const block of blocks) {
      if (page.length > 0 && (page.length >= MAX_TOPICS_PER_SLIDE || !fits([...page, block]))) {
        pages.push(page);
        page = [];
      }
      page.push(block);
    }
    if (page.length > 0) pages.push(page);
    return pages;
  }

  const sizeMemo = new Map<string, number>();
  const runSize = (start: number, length: number) => {
    const key = `${start}:${length}`;
    let sz = sizeMemo.get(key);
    if (sz === undefined) {
      const run = blocks.slice(start, start + length);
      sz = fits(run) ? blocksFontSize(run, structured, TOPIC_SPLIT_SZ, box) : 0;
      sizeMemo.set(key, sz);
    }
    return sz;
  };

  for (let pages = Math.ceil(blocks.length / MAX_TOPICS_PER_SLIDE); pages <= blocks.length; pages++) {
    let best: { sizes: number[]; smallest: number } | null = null;
    for (const sizes of cuts(blocks.length, pages, MAX_TOPICS_PER_SLIDE)) {
      let start = 0;
      let smallest = Infinity;
      for (const length of sizes) {
        smallest = Math.min(smallest, runSize(start, length));
        start += length;
      }
      if (smallest === 0) continue;
      // A tie keeps the earlier cut, the one fuller at the front.
      if (
        !best ||
        smallest > best.smallest ||
        (smallest === best.smallest && spread(sizes) < spread(best.sizes))
      ) {
        best = { sizes, smallest };
      }
    }
    if (best) {
      let start = 0;
      return best.sizes.map((length) => {
        const run = blocks.slice(start, start + length);
        start += length;
        return run;
      });
    }
  }
  // Only a block that is too long for a slide of its own gets here; each
  // block then has a slide to itself.
  return blocks.map((block) => [block]);
}

/**
 * The 기도 준비 slides `topics` need, each with its blocks and the size its
 * text is drawn at. None for no topics: the front deck then keeps its own
 * slide exactly as it is.
 */
export function planPrayerTopicPages(
  topics: PrayerTopic[],
  box: PrayerTopicBox = DEFAULT_TOPIC_BOX,
): PrayerTopicPage[] {
  if (topics.length === 0) return [];
  const structured = hasPoints(topics);
  const blocks = topics.flatMap((topic, index) => blocksOfTopic(topic, index + 1, structured, box));
  return shareOut(blocks, structured, box).map((page) => ({
    blocks: page,
    sz: blocksFontSize(page, structured, TOPIC_MIN_SZ, box),
  }));
}
