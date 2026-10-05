// Where each design lives inside public/praise-template.pptx, and the
// placeholders the builder fills in. The asset is last year's praise-night
// deck reduced to its six designs by scripts/prepare-praise-template.mjs,
// so these positions are the contract between that script and deckBuilder.ts:
// change one and change both.

/** 1-based slide positions in the template. */
export const PRAISE_SLIDES = {
  /** 표지 — the EM & KM Praise Night photo, with a {{COVER_DATE}} box over its printed date. */
  cover: 1,
  /** 곡 제목 — Korean title over English title, centred. */
  songTitle: 2,
  /** 가사 — "한글 | English" corner label, Korean lines, blank, English lines. */
  lyrics: 3,
  /** 기도 / Prayer — and every other prayer title (통성기도, 축도…): Korean over English. */
  prayer: 4,
  /** 기도제목 — a heading over the topics, one bulleted paragraph each. */
  prayerTopics: 5,
  /** 말씀 — the passage in the corner, then one verse in 개역개정 over the same verse in English. */
  scripture: 6,
} as const;

export const PRAISE_TOKENS = {
  coverDate: '{{COVER_DATE}}',
  titleKo: '{{TITLE_KO}}',
  titleEn: '{{TITLE_EN}}',
  header: '{{HEADER}}',
  line: '{{LINE}}',
  prayerKo: '{{PRAYER_KO}}',
  prayerEn: '{{PRAYER_EN}}',
  prayerHeading: '{{PRAYER_HEADING}}',
  prayerTopic: '{{PRAYER_TOPIC}}',
  passageKo: '{{PASSAGE_KO}}',
  passageEn: '{{PASSAGE_EN}}',
  verseRefKo: '{{VERSE_REF_KO}}',
  verseKo: '{{VERSE_KO}}',
  verseRefEn: '{{VERSE_REF_EN}}',
  verseEn: '{{VERSE_EN}}',
} as const;

/** Shapes the script laid over the cover photo's printed date. */
export const PRAISE_COVER_SHAPES = {
  dateMask: 'PraiseCoverDateMask',
  date: 'PraiseCoverDate',
} as const;

/** The 4:3 slide every design is drawn on, in EMU. */
export const PRAISE_SLIDE_SIZE = { cx: 9144000, cy: 6858000 } as const;

/**
 * Where the lyrics go: the whole width, and a band whose middle is the
 * slide's middle, with the text anchored to that middle — so every lyric
 * slide, two lines or ten, Korean-only or bilingual, sits in the centre of
 * the screen. (Last year's box started a quarter of the way down and hung
 * the text from its top, so a short slide sat high and a long one low.) The
 * band keeps clear of the corner title above it (which ends at y 616325).
 */
export const PRAISE_LYRICS_BODY = {
  x: 0,
  y: 685800,
  cx: PRAISE_SLIDE_SIZE.cx,
  cy: PRAISE_SLIDE_SIZE.cy - 2 * 685800,
} as const;

/**
 * The lyrics slide's body box, as fitBodyFontSize reads it: its extent,
 * insets and line spacing. Used to decide — before anything is built —
 * whether a slide's Korean and English fit on one page.
 */
export const PRAISE_LYRICS_BODY_BOX =
  `<a:ext cx="${PRAISE_LYRICS_BODY.cx}" cy="${PRAISE_LYRICS_BODY.cy}"/>` +
  '<a:bodyPr bIns="91425" lIns="91425" rIns="91425" tIns="91425"/>' +
  '<a:lnSpc><a:spcPct val="115000"/></a:lnSpc>';

/**
 * The song-title slide's box, widened from last year's (1524750–7619250) to
 * the slide less half an inch a side, centred where it was: more room for a
 * title before it has to shrink to stay on one line.
 */
export const PRAISE_TITLE_BOX = { x: 457200, cx: PRAISE_SLIDE_SIZE.cx - 2 * 457200 } as const;
/** The title slide's own size (54pt); a title shrinks from here only to stay on one line. */
export const PRAISE_TITLE_BASE_SZ = 5400;
export const PRAISE_TITLE_MIN_SZ = 1800;

/**
 * The corner label on every lyric slide ("한글 | English"), running from
 * where last year's started to the same margin on the right, so a long pair
 * of titles has the whole top of the slide before it shrinks.
 */
export const PRAISE_HEADER_BOX = { x: 235500, cx: PRAISE_SLIDE_SIZE.cx - 2 * 235500 } as const;
export const PRAISE_HEADER_BASE_SZ = 2010;
export const PRAISE_HEADER_MIN_SZ = 900;

/** The template's own lyric size (34pt), in 1/100 pt. */
export const PRAISE_LYRICS_BASE_SZ = 3400;
/**
 * Below this a bilingual slide stops shrinking and is split into two slides
 * instead, so the words stay readable from the back of the room.
 */
export const PRAISE_LYRICS_SPLIT_SZ = 2800;
/** The smallest a slide that cannot be split any further is drawn at. */
export const PRAISE_LYRICS_MIN_SZ = 2000;

// ---- 기도 slides -----------------------------------------------------------

/**
 * The 기도 slide's title box, widened from last year's (which ended at
 * x 6701325) to the slide less half an inch on the right, so a longer title
 * ("중보기도 / Intercessory Prayer") stays at full size before it shrinks.
 * It keeps last year's left edge, top and height.
 */
export const PRAISE_PRAYER_TITLE_BOX = { x: 1082025, cx: PRAISE_SLIDE_SIZE.cx - 1082025 - 457200 } as const;
/** Last year's 기도 / Prayer size (54pt); a title shrinks from here only to stay on one line. */
export const PRAISE_PRAYER_TITLE_BASE_SZ = 5400;
export const PRAISE_PRAYER_TITLE_MIN_SZ = 2400;

/**
 * The 기도제목 body: last year's box, run down to half an inch above the
 * bottom of the slide (last year's grew past its own bottom as it filled),
 * with the text hung from its top under the heading.
 */
export const PRAISE_TOPICS_BODY = {
  x: 526350,
  y: 1858950,
  cx: 8091300,
  cy: PRAISE_SLIDE_SIZE.cy - 1858950 - 457200,
} as const;
/** Each topic's hanging indent: the bullet sits in it, the wrapped lines start after it. */
const PRAISE_TOPICS_INDENT = 457200;
/**
 * The 기도제목 body as fitBodyFontSize reads it — the text column is the box
 * less the bullet's indent — to decide how large the topics can be drawn and
 * when they need a second slide.
 */
export const PRAISE_TOPICS_BODY_BOX =
  `<a:ext cx="${PRAISE_TOPICS_BODY.cx - PRAISE_TOPICS_INDENT}" cy="${PRAISE_TOPICS_BODY.cy}"/>` +
  '<a:bodyPr bIns="91425" lIns="91425" rIns="91425" tIns="91425"/>' +
  '<a:lnSpc><a:spcPct val="115000"/></a:lnSpc>';
/** Last year's topic size (26pt). */
export const PRAISE_TOPICS_BASE_SZ = 2600;
/** Topics that would need less than this go on to another 기도제목 slide. */
export const PRAISE_TOPICS_SPLIT_SZ = 2000;
/** The smallest a single topic too long for one slide is drawn at. */
export const PRAISE_TOPICS_MIN_SZ = 1600;

// ---- 말씀 slides -----------------------------------------------------------

/** The passage in the top corner ("사도행전 1장 3-5, 8절" over "Acts 1:3-5, 8"), across the slide. */
export const PRAISE_PASSAGE_BOX = { x: 334000, cx: PRAISE_SLIDE_SIZE.cx - 2 * 334000 } as const;
export const PRAISE_PASSAGE_BASE_SZ = 2100;
export const PRAISE_PASSAGE_MIN_SZ = 1200;

/** The Korean verse (개역개정): its reference, then its text, down to where the English starts. */
export const PRAISE_VERSE_KO_BOX = { x: 334000, y: 1582125, cx: PRAISE_SLIDE_SIZE.cx - 2 * 334000, cy: 2494471 } as const;
/** The English verse (NASB), from last year's top down to a third of an inch above the bottom. */
export const PRAISE_VERSE_EN_BOX = {
  x: 334000,
  y: 4176596,
  cx: PRAISE_SLIDE_SIZE.cx - 2 * 334000,
  cy: PRAISE_SLIDE_SIZE.cy - 4176596 - 304800,
} as const;
/** What a verse's reference line (30pt) and the space around the verse take of its box, in EMU. */
export const PRAISE_VERSE_REF_EMU = Math.round((30 * 1.2 * 1.15 + 9 + 9) * 12700);
/** Last year's verse size (24pt), and how far a long verse may shrink to stay in its half. */
export const PRAISE_VERSE_BASE_SZ = 2400;
export const PRAISE_VERSE_MIN_SZ = 1400;

/** A verse half as fitBodyFontSize reads it: the box less the reference line above the text. */
export function verseTextBox(box: { cx: number; cy: number }): string {
  return (
    `<a:ext cx="${box.cx}" cy="${box.cy - PRAISE_VERSE_REF_EMU}"/>` +
    '<a:bodyPr bIns="45700" lIns="91425" rIns="91425" tIns="45700"/>' +
    '<a:lnSpc><a:spcPct val="115000"/></a:lnSpc>'
  );
}
