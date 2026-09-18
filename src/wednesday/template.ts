// Where each fixed 수요예배 design lives inside public/wednesday-template.pptx,
// and the placeholders the builder fills in.
//
// The asset is a real service deck reduced to its eleven distinct slides by
// scripts/prepare-wednesday-template.mjs, so these positions are the contract
// between that script and the builder: change one and change both.

/** 1-based positions in the template's presentation order. */
export const WEDNESDAY_SLIDES = {
  /** 표지 — the 16:9 cover, also exported on its own as the 썸네일. */
  cover: 1,
  /** 수요예배 인트로 — church name, 빌립보서 3:3, service date. */
  intro: 2,
  /** 경배와 찬양 구분 장. */
  worship: 3,
  /** 찬 양 + 곡 제목. Repeated once per song, ahead of that song's own slides. */
  songTitle: 4,
  /** 기 도 — after the praise set. */
  prayer: 5,
  /** 말 씀 구분 장 with the passage. */
  wordDivider: 6,
  /** 말 씀 본문 — cloned once per verse group. */
  wordBody: 7,
  /** 설교 구분 장. The sermon's own slides are inserted by hand after this one. */
  sermonDivider: 8,
  /** 기 도 — after the sermon. */
  sermonPrayer: 9,
  /** 합심기도. */
  unifiedPrayer: 10,
  /** 마지막 장 — 성령으로 봉사하는 교회. */
  closing: 11,
} as const;

/**
 * Carrier slide for 악보 사진 slides.
 *
 * buildImageDeck replaces a cloned slide's shapes with the image, so what the
 * carrier contributes is its layout, master and theme — here the plain one
 * whose master paints a solid background, the same one the church's own 악보
 * slides sit on.
 */
export const WEDNESDAY_IMAGE_CARRIER = WEDNESDAY_SLIDES.wordDivider;

/** Placeholder tokens carried by the template's text. */
export const WEDNESDAY_TOKENS = {
  dateKo: '{{DATE_KO}}',
  dateDot: '{{DATE_DOT}}',
  sermonTitle: '{{SERMON_TITLE}}',
  rangeKo: '{{RANGE_KO}}',
  preacher: '{{PREACHER}}',
  preacherTitle: '{{PREACHER_TITLE}}',
  preacherLine: '{{PREACHER_LINE}}',
  songTitle: '{{SONG_TITLE}}',
  body: '{{BODY}}',
} as const;
