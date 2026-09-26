// Where each design lives inside public/praise-template.pptx, and the
// placeholders the builder fills in. The asset is last year's praise-night
// deck reduced to its four designs by scripts/prepare-praise-template.mjs,
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
  /** 기도 / Prayer. */
  prayer: 4,
} as const;

export const PRAISE_TOKENS = {
  coverDate: '{{COVER_DATE}}',
  titleKo: '{{TITLE_KO}}',
  titleEn: '{{TITLE_EN}}',
  header: '{{HEADER}}',
  line: '{{LINE}}',
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
