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

/**
 * The lyrics slide's body box, as fitBodyFontSize reads it: its extent,
 * insets and line spacing, copied from the template's 가사 slide. Used to
 * decide — before anything is built — whether a slide's Korean and English
 * fit on one page.
 */
export const PRAISE_LYRICS_BODY_BOX =
  '<a:ext cx="9144000" cy="5075700"/>' +
  '<a:bodyPr bIns="91425" lIns="91425" rIns="91425" tIns="91425"/>' +
  '<a:lnSpc><a:spcPct val="115000"/></a:lnSpc>';

/** The template's own lyric size (34pt), in 1/100 pt. */
export const PRAISE_LYRICS_BASE_SZ = 3400;
/**
 * Below this a bilingual slide stops shrinking and is split into two slides
 * instead, so the words stay readable from the back of the room.
 */
export const PRAISE_LYRICS_SPLIT_SZ = 2800;
/** The smallest a slide that cannot be split any further is drawn at. */
export const PRAISE_LYRICS_MIN_SZ = 2000;
