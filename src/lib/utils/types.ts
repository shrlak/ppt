// Shared data model for the praise lyrics slide generator.
// All modules (parser, planner, pptx builder, UI) code against these types.

/** One labeled part of a song: V1/V2 (verse), PC (pre-chorus), C (chorus), B (bridge), etc. */
export interface Section {
  /** Normalized label, e.g. "V1", "PC", "C", "C2", "B", "O" */
  label: string;
  /** Lyric lines as they should appear on slides (one array item = one slide line) */
  lines: string[];
}

/**
 * How much a recognized song can be trusted.
 *
 * 'draft'    — a model, the web, or both produced it; nobody has confirmed it.
 * 'verified' — the user saved it to the library without changing anything.
 * 'edited'   — the user corrected it and then saved it.
 *
 * Only the last two are ground truth: they are the only states that may skip
 * recognition on a later conti, seed prompt examples, or score a model.
 */
export type VerificationState = 'draft' | 'verified' | 'edited';

/** How a song is looked up: a title, plus the artist when the score printed one. */
export interface SongIdentity {
  title: string;
  artist?: string;
}

/** Where a song's current reading came from, kept so a later correction can be
 * diffed against the machine's own answer. */
export interface RecognitionProvenance {
  /** Stable hash of the rendered score page this reading came from. */
  pageHash?: string;
  /** What recognition produced before the user touched it. */
  baseline?: { title?: string; artist?: string; key?: string; sections: Section[]; order: string[] };
  source?: 'library' | 'models' | 'web' | 'manual';
  webSourceUrl?: string;
  /** Consensus confidence (0–1) of the reading that was applied. */
  confidence?: number;
  /** Version of the correction model that touched this reading, when one did. */
  correctionModelVersion?: string;
}

/** The scalar subset of provenance that is safe to persist with a library entry. */
export interface StoredProvenance {
  pageHash?: string;
  source?: 'library' | 'models' | 'web' | 'manual';
  webSourceUrl?: string;
  confidence?: number;
  correctionModelVersion?: string;
}

/** A song being edited for this week's slide deck. */
export interface Song {
  id: string;
  title: string;
  /** Artist/사역팀 as printed on the score. Absent unless the page showed one. */
  artist?: string;
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
  /** Trust level of the current reading; absent means an untouched scaffold. */
  verification?: VerificationState;
  /** Bumped every time the user saves this song to the library. */
  version?: number;
  provenance?: RecognitionProvenance;
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

/**
 * A saved song in the reusable library (bundled + localStorage + shared proxy).
 *
 * The provenance fields are optional on the interface so pre-feature entries
 * and hand-written fixtures still typecheck; `sanitizeLibraryEntry` fills them
 * in, and everything that decides whether an entry may be reused reads the
 * sanitized form.
 */
export interface LibraryEntry {
  title: string;
  /** Artist/사역팀, when the score or the user supplied one. */
  artist?: string;
  key?: string;
  sections: Section[];
  order: string[];
  verification?: VerificationState;
  version?: number;
  updatedAt?: string;
  provenance?: StoredProvenance;
}

/** A library entry that has been through `sanitizeLibraryEntry`. */
export type SanitizedLibraryEntry = LibraryEntry & {
  verification: VerificationState;
  version: number;
};

/** One planned output slide. */
export interface SlidePlan {
  /** "title" = big centered song-title slide; "lyrics" = lyric lines + corner label */
  kind: 'title' | 'lyrics';
  /** Song title (main text on title slides, corner label on lyrics slides) */
  title: string;
  /** Lyric lines; only for kind === "lyrics" */
  lines?: string[];
}
