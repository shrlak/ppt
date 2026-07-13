// Shared data model for the praise lyrics slide generator.
// All modules (parser, planner, pptx builder, UI) code against these types.

/** One labeled part of a song: V1/V2 (verse), PC (pre-chorus), C (chorus), B (bridge), etc. */
export interface Section {
  /** Normalized label, e.g. "V1", "PC", "C", "C2", "B", "O" */
  label: string;
  /** Lyric lines as they should appear on slides (one array item = one slide line) */
  lines: string[];
}

/** A song being edited for this week's slide deck. */
export interface Song {
  id: string;
  title: string;
  /** Musical key from the conti cover page, e.g. "E", "F" */
  key?: string;
  /** Description text from the conti cover page */
  description?: string;
  sections: Section[];
  /**
   * Playback order of section labels. "I" (interlude/intro/간주) renders the
   * song title slide again. Example: ["I","V1","V2","PC","C","I","C","C"]
   */
  order: string[];
  /** Max lyric lines per generated slide (template default: 4) */
  linesPerSlide: number;
  /** 1-based page number of this song's score in the uploaded conti PDF */
  pageIndex?: number;
}

/** A song entry parsed off the conti cover page (title + key + description). */
export interface ContiSongEntry {
  title: string;
  key?: string;
  description?: string;
  /** 1-based PDF page this song's score was matched to (if found) */
  pageIndex?: number;
}

/** Worship-service info parsed from the conti cover page. */
export interface ContiInfo {
  /** Service date as written, e.g. "7/11/26" */
  date?: string;
  /** Sermon title, e.g. 하나님과 화평을 누리자 */
  sermonTitle?: string;
  /** Scripture reference (본문), e.g. 로마서 5장 1-11절 */
  scripture?: string;
  songs: ContiSongEntry[];
}

/** Result of parsing an uploaded conti PDF. */
export interface ParsedConti {
  info: ContiInfo;
  numPages: number;
  /** Extracted text per page (index 0 = page 1); empty string if no text layer */
  pageTexts: string[];
  /** 1-based indices of pages classified as sheet-music pages */
  musicPages: number[];
}

/** A saved song in the reusable library (bundled + localStorage). */
export interface LibraryEntry {
  title: string;
  key?: string;
  sections: Section[];
  order: string[];
}

/** One planned output slide. */
export interface SlidePlan {
  /** "title" = big centered song-title slide; "lyrics" = lyric lines + corner label */
  kind: 'title' | 'lyrics';
  /** Song title (main text on title slides, corner label on lyrics slides) */
  title: string;
  /** Lyric lines; only for kind === "lyrics" */
  lines?: string[];
}
