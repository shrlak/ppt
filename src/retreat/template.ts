// Where each design lives inside public/retreat-template.pptx and the
// placeholders the builder fills. The asset is the 2026 retreat's first-night
// deck reduced to its 13 designs by scripts/prepare-retreat-template.mjs, so
// these positions are the contract between that script and deckBuilder.ts.

/** 1-based slide positions in the template. */
export const RETREAT_SLIDES = {
  /** 설교 포스터 표지 — the poster picture on a matching background. */
  cover: 1,
  /** “2026 빛주사랑 겨울 수련회” + 부제. */
  title: 2,
  /** 순서 구분 (찬양 / 기도회 / 찬양집회) on the night-sky photo. */
  section: 3,
  /** 곡 제목. */
  songTitle: 4,
  /** 가사, with the song title in the corner. */
  lyrics: 5,
  /** 설교말씀 + 본문 범위, on the open-Bible photo. */
  passage: 6,
  /** 말씀 한 절: 개역개정 above, ESV below, 범위 in the corner. */
  verse: 7,
  /** 설교 + 설교 제목. */
  sermon: 8,
  /** 빈 화면 — for the sermon's own slides or a pause. */
  blank: 9,
  /** 기도. */
  prayer: 10,
  /** 축도. */
  benediction: 11,
  /** 광고 구분 (OT | 광고). */
  announcementDivider: 12,
  /** 광고 한 항목, with the retreat's name and theme in the footer. */
  announcement: 13,
} as const;

export const RETREAT_TOKENS = {
  titleLine1: '{{TITLE_LINE1}}',
  titleLine2: '{{TITLE_LINE2}}',
  subtitle: '{{SUBTITLE}}',
  section: '{{SECTION}}',
  songTitle: '{{SONG_TITLE}}',
  line: '{{LINE}}',
  passageKo: '{{PASSAGE_KO}}',
  passageEn: '{{PASSAGE_EN}}',
  verseNo: '{{VERSE_NO}}',
  verseKo: '{{VERSE_KO}}',
  verseEn: '{{VERSE_EN}}',
  sermonTitle: '{{SERMON_TITLE}}',
  label: '{{LABEL}}',
  announcementTitle: '{{ANN_TITLE}}',
  announcementLine: '{{ANN_LINE}}',
  footerTitle: '{{FOOTER_TITLE}}',
  footerTheme: '{{FOOTER_THEME}}',
} as const;
