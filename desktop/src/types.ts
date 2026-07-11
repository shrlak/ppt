// Core data model for the Worship Setlist + Lyrics Slide Generator.
// These types mirror the SQLite schema that Phase 2 introduces
// (tables: songs, song_sections, setlists, setlist_items, slide_themes).

/** Musical keys supported for transposition (sharps preferred for display). */
export const KEYS = [
  'C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B',
  'Cm', 'C#m', 'Dm', 'Ebm', 'Em', 'Fm', 'F#m', 'Gm', 'Abm', 'Am', 'Bbm', 'Bm',
] as const;
export type MusicalKey = (typeof KEYS)[number];

export const SECTION_TYPES = [
  'Verse 1',
  'Verse 2',
  'Verse 3',
  'Verse 4',
  'Pre-Chorus',
  'Chorus',
  'Bridge',
  'Ending',
] as const;
export type SectionType = (typeof SECTION_TYPES)[number];

export const SONG_TAGS = [
  'praise',
  'prayer',
  'offering',
  'fast',
  'slow',
  'invitation',
  'communion',
] as const;
export type SongTag = (typeof SONG_TAGS)[number];

/** One lyric/chord section of a song. Chords may appear inline as [G]lyric. */
export interface SongSection {
  id: string;
  songId: string;
  type: SectionType;
  /** Lyrics with optional inline bracket chords, line breaks preserved. */
  content: string;
  /** Order of this section within the song as entered. */
  position: number;
}

export interface Song {
  id: string;
  title: string;
  /** Artist or source (album, hymnal, ministry). */
  artist: string;
  originalKey: MusicalKey;
  bpm: number | null;
  ccli: string | null;
  tags: SongTag[];
  /** Free-form notes for the worship leader. */
  notes: string;
  sections: SongSection[];
  createdAt: string;
  updatedAt: string;
}

export const SERVICE_SECTIONS = [
  'Opening Prayer',
  'Praise',
  'Offering',
  'Sermon',
  'Response Song',
  'Closing',
] as const;
export type ServiceSection = (typeof SERVICE_SECTIONS)[number];

/** An item in a setlist: either a song (with performance key) or a service marker. */
export interface SetlistItem {
  id: string;
  setlistId: string;
  position: number;
  kind: 'song' | 'service';
  /** Set when kind === 'song'. */
  songId?: string;
  /** Key the song will be performed in (may differ from the original key). */
  performanceKey?: MusicalKey;
  /** Set when kind === 'service'. */
  serviceSection?: ServiceSection;
  /** Transition note leading into the NEXT item. */
  transitionNote: string;
}

export interface Setlist {
  id: string;
  /** Service date in YYYY-MM-DD. */
  date: string;
  title: string;
  items: SetlistItem[];
  createdAt: string;
  updatedAt: string;
}

export type AspectRatio = '16:9' | '4:3';
export type TextAlign = 'left' | 'center' | 'right';
export type TitlePosition = 'top-left' | 'top-center' | 'center';

/** A reusable slide look, applied when exporting PPTX. */
export interface SlideTheme {
  id: string;
  name: string;
  backgroundColor: string;
  textColor: string;
  fontFamily: string;
  /** Lyric font size in points. */
  fontSize: number;
  titlePosition: TitlePosition;
  lyricsAlign: TextAlign;
  /** Optional background image as a local file path or data URL. */
  backgroundImage: string | null;
  aspectRatio: AspectRatio;
  /** Max lyric lines per slide before splitting. */
  maxLinesPerSlide: number;
}

export const DEFAULT_THEME: SlideTheme = {
  id: 'default',
  name: 'Default (White)',
  backgroundColor: '#FFFFFF',
  textColor: '#111111',
  fontFamily: 'Arial',
  fontSize: 40,
  titlePosition: 'top-left',
  lyricsAlign: 'center',
  backgroundImage: null,
  aspectRatio: '16:9',
  maxLinesPerSlide: 4,
};
