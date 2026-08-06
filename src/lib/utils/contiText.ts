import type { ContiInfo, ContiSongEntry, LibraryEntry } from './types';
import { normalizeTitle } from '../storage/library';

/** `주님의 사랑 (E): 설명...` — title, musical key, description. */
const SONG_LINE = /^(.{1,40}?)\s*[(（]\s*([A-Ga-g][#♯bB♭]?m?)\s*[)）]\s*[:：]\s*(.*)$/;
const DATE_RE = /\b(\d{1,2})\s*[/.]\s*(\d{1,2})\s*[/.]\s*(\d{2,4})\b/;
/** `2026.08.09` — the year-first form the table-layout cover writes. */
const ISO_DATE_RE = /\b(\d{4})\s*[./-]\s*(\d{1,2})\s*[./-]\s*(\d{1,2})\b/;
const QUOTED_RE = /[“"]([^“”"]{2,60})[”"]/;
const NOTES_RE = /[세셰]션\s*노트/;

/**
 * Separator between a cover's field label and its value. Covers written as a
 * table draw a real `|` glyph between the two ("본문 | 전도서 12 장 1-8 절"),
 * while the prose layout uses a colon ("본문: 로마서 5장 1-11절"); a plain
 * space is also enough once the label itself has been matched.
 */
const LABEL_GAP = String.raw`\s*[:：|｜]?\s*`;

const SCRIPTURE_RE = new RegExp(String.raw`^본문${LABEL_GAP}(\S.*)$`);
const SERMON_TITLE_RE = new RegExp(
  String.raw`^(?:설교\s*제목|말씀\s*제목|설교|주제)${LABEL_GAP}(\S.*)$`,
);
const DATE_LABEL_RE = new RegExp(String.raw`^날짜${LABEL_GAP}(\S.*)$`);

/** A scripture value must name a chapter/verse — otherwise "본문" is a heading. */
const SCRIPTURE_VALUE_RE = /\d\s*[장편절:]/;

/** One musical key as a conti writes it: E, F#, Ab, F#m. */
const KEY = String.raw`[A-Ga-g](?:#|♯|b|♭|B)?m?`;
/** Keys are often a modulation chain — "F -> Gb", "F->Ab->G", "F → Gb". */
const KEY_ARROW = String.raw`\s*(?:->|=>|→|⇒|~)\s*`;

/**
 * Row of the `순서 | 찬양 | 키` table: an order number, the title, and the
 * key (or key chain) in the last column — "3 어려운 일 당할 때 F -> Ab -> G".
 * The title is lazy so the chain, not just its last key, lands in the key column.
 */
const SONG_TABLE_ROW = new RegExp(
  String.raw`^(\d{1,2})\s*[.)]?${LABEL_GAP}(\S.*?)\s+(${KEY}(?:${KEY_ARROW}${KEY})*)\s*$`,
);

/** `• 매일매일 (A Key)` — the per-song commentary heading under the table. */
const SONG_BULLET_RE = /^[•·∙▪▫◦*]\s*(\S.*?)\s*[(（]([^)）]{1,60})[)）]\s*$/;
/** `o 이 찬양은…` — the indented description under a bullet heading. */
const BULLET_BODY_RE = /^[o○◦-]\s+(\S.*)$/;

/** `2. 찬양 콘티 (Plan A)` — where the song table starts. */
const SONG_SECTION_RE = /^\d+\s*[.)]\s*.*찬양\s*콘티/;
/** Any other numbered section heading ("1. 말씀 묵상", "3. 본문") ends it. */
const SECTION_HEADING_RE = /^\d+\s*[.)]\s*\S/;
/** The table's own header row, which carries no song. */
const TABLE_HEADER_RE = /^순서[\s|｜]*찬양[\s|｜]*키$/;

function normalizeKey(raw: string): string {
  const key = raw[0].toUpperCase();
  const rest = raw.slice(1).replace('♯', '#').replace('♭', 'b').replace('B', 'b');
  return key + rest;
}

/**
 * Normalize a written key column into a canonical chain: "F->Ab->G" and
 * "F key -> Gb key" both become "F -> Ab -> G" / "F -> Gb". Returns undefined
 * when the text is not a key (chain) at all, which is what keeps ordinary
 * prose out of the song table.
 */
export function normalizeKeyChain(raw: string): string | undefined {
  const cleaned = raw
    .replace(/\b(?:key|키)\b/gi, ' ')
    .replace(/[⇒→=]>?/g, '->')
    .replace(/~/g, '->')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return undefined;
  const keys = cleaned.split('->').map((part) => part.trim());
  if (keys.some((part) => !new RegExp(String.raw`^${KEY}$`).test(part))) return undefined;
  return keys.map(normalizeKey).join(' -> ');
}

/**
 * Read the two Bible-slide fields from any text-bearing non-score page. Unlike
 * parseCoverText this does not require a song list, so a standalone sermon
 * information page can still populate the next wizard step.
 */
export function parseSermonInfoText(text: string): Pick<ContiInfo, 'sermonTitle' | 'scripture'> {
  let sermonTitle: string | undefined;
  let scripture: string | undefined;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const scriptureMatch = line.match(SCRIPTURE_RE);
    // "3. 본문" heads the printed passage; only a real chapter/verse is the 본문 field.
    if (scriptureMatch && SCRIPTURE_VALUE_RE.test(scriptureMatch[1])) {
      scripture ??= scriptureMatch[1].trim();
      continue;
    }
    const titleMatch = line.match(SERMON_TITLE_RE);
    if (titleMatch) {
      sermonTitle ??= titleMatch[1].trim().replace(/^[“"]|[”"]$/g, '').trim();
    }
  }

  return { sermonTitle, scripture };
}

/**
 * Read the `순서 | 찬양 | 키` table a conti cover uses instead of prose song
 * lines, plus the `• 제목 (Key)` commentary bullets underneath it.
 *
 * Only the rows inside the 찬양 콘티 section are considered: the 말씀 묵상 and
 * 본문 sections are full of numbered prose ("8. 전도자가 이르되 …") that would
 * otherwise be mistaken for table rows. The bullets are matched back to the
 * table by title so a song keeps its order number while gaining a description,
 * and a song that only ever appears as a bullet is still picked up.
 */
function parseSongTable(lines: string[]): ContiSongEntry[] {
  const songs: ContiSongEntry[] = [];
  const byTitle = new Map<string, ContiSongEntry>();
  const remember = (song: ContiSongEntry) => {
    const existing = byTitle.get(normalizeTitle(song.title));
    if (existing) return existing;
    byTitle.set(normalizeTitle(song.title), song);
    songs.push(song);
    return song;
  };

  let inSection = false;
  let bullet: ContiSongEntry | null = null;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    if (SONG_SECTION_RE.test(line)) {
      inSection = true;
      bullet = null;
      continue;
    }
    if (!inSection) continue;
    if (TABLE_HEADER_RE.test(line)) continue;

    const bulletMatch = line.match(SONG_BULLET_RE);
    if (bulletMatch) {
      const key = normalizeKeyChain(bulletMatch[2]);
      if (key) {
        bullet = remember({ title: bulletMatch[1].trim(), key });
        bullet.key ??= key;
        continue;
      }
    }

    // Page furniture: an empty bullet marker or a lone decorative glyph.
    if (!/[0-9a-zA-Zㄱ-ㆎ가-힣]/.test(line) || /^[o○◦-]$/.test(line)) continue;

    // A description line continues the bullet it sits under.
    const bodyMatch = line.match(BULLET_BODY_RE);
    if (bullet && bodyMatch) {
      bullet.description = bullet.description ? `${bullet.description} ${bodyMatch[1]}` : bodyMatch[1];
      continue;
    }
    if (bullet && !SECTION_HEADING_RE.test(line) && !SONG_TABLE_ROW.test(line)) {
      // Wrapped continuation of the previous description line.
      if (bullet.description) bullet.description += ` ${line}`;
      continue;
    }

    const rowMatch = line.match(SONG_TABLE_ROW);
    if (rowMatch) {
      const key = normalizeKeyChain(rowMatch[3]);
      if (key) {
        remember({ title: rowMatch[2].trim(), key });
        continue;
      }
    }

    if (SECTION_HEADING_RE.test(line)) {
      // The next numbered section (3. 본문) closes the 찬양 콘티 block.
      inSection = false;
      bullet = null;
    }
  }

  return songs;
}

/**
 * Parse the typed cover page of a 찬양 콘티: date, sermon title, scripture (본문)
 * and the song list with keys. Returns null when the text doesn't look like a cover.
 */
export function parseCoverText(text: string): ContiInfo | null {
  // The session-notes page repeats the song list; never treat it as a cover.
  if (NOTES_RE.test(text)) return null;
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  const songs: ContiSongEntry[] = [];
  let date: string | undefined;
  const labeledInfo = parseSermonInfoText(text);
  let sermonTitle = labeledInfo.sermonTitle;
  let scripture = labeledInfo.scripture;

  for (const line of lines) {
    if (!line) continue;
    const scriptureMatch = line.match(SCRIPTURE_RE);
    if (scriptureMatch && SCRIPTURE_VALUE_RE.test(scriptureMatch[1])) {
      scripture ??= scriptureMatch[1].trim();
      continue;
    }
    const songMatch = line.match(SONG_LINE);
    if (songMatch && !songMatch[1].trim().startsWith('본문')) {
      songs.push({
        title: songMatch[1].trim(),
        key: normalizeKey(songMatch[2]),
        description: songMatch[3].trim() || undefined,
      });
      continue;
    }
    if (!date) {
      // A labeled 날짜 row wins over any date-shaped text elsewhere on the page.
      const labeled = line.match(DATE_LABEL_RE);
      const dateText = labeled ? labeled[1] : line;
      const isoMatch = dateText.match(ISO_DATE_RE);
      const dateMatch = dateText.match(DATE_RE);
      if (isoMatch) date = `${isoMatch[1]}.${isoMatch[2]}.${isoMatch[3]}`;
      else if (dateMatch) date = `${dateMatch[1]}/${dateMatch[2]}/${dateMatch[3]}`;
    }
    if (!sermonTitle) {
      const quoted = line.match(QUOTED_RE);
      if (quoted) sermonTitle = quoted[1].trim();
    }
  }

  // Covers that lay the conti out as a 순서/찬양/키 table carry no
  // "제목 (Key): 설명" lines at all — read the table instead.
  if (songs.length === 0) songs.push(...parseSongTable(lines));

  // A real cover has service context beyond the bare song list.
  if (songs.length === 0 || (!date && !sermonTitle && !scripture)) return null;
  return { date, sermonTitle, scripture, songs };
}

/** How many Hangul words a page needs before it can count as typed prose. */
const INFO_PAGE_MIN_WORDS = 30;
/** Structural marks only a typed information page carries. */
const INFO_PAGE_MARKERS = [SECTION_HEADING_RE, /^[•·∙▪▫◦]\s*\S/, SCRIPTURE_RE, SERMON_TITLE_RE, DATE_LABEL_RE];

/**
 * True when a page is typed service information rather than a scanned score.
 *
 * A conti's write-up often runs past the cover onto a second page (the last
 * song's commentary plus the printed 본문). That page has no staves, so the
 * vision pass would classify it `non_score` and drop whichever song it was
 * matched to — the song would vanish from 찬양 편집 instead of getting its
 * real score page. Scanned scores have no usable text layer at all (zero
 * Hangul on this conti), so requiring both a lot of Korean prose *and* a
 * structural mark keeps a genuine lyric text layer from being excluded.
 */
export function looksLikeInfoPage(text: string): boolean {
  const words = text.match(/[가-힣]{2,}/g)?.length ?? 0;
  if (words < INFO_PAGE_MIN_WORDS) return false;
  return text
    .split(/\r?\n/)
    .some((rawLine) => INFO_PAGE_MARKERS.some((marker) => marker.test(rawLine.trim())));
}

/** Classify PDF pages (1-based): cover, session-notes, and sheet-music pages. */
export function classifyPages(pageTexts: string[]): {
  coverIndex: number | null;
  notesIndex: number | null;
  /** Typed information pages (cover continuations) that carry no score. */
  infoPages: number[];
  musicPages: number[];
} {
  let coverIndex: number | null = null;
  let notesIndex: number | null = null;

  for (let i = 0; i < pageTexts.length; i++) {
    const page = i + 1;
    if (coverIndex === null && parseCoverText(pageTexts[i])) {
      coverIndex = page;
    } else if (notesIndex === null && NOTES_RE.test(pageTexts[i])) {
      notesIndex = page;
    }
  }

  const infoPages: number[] = [];
  const musicPages: number[] = [];
  for (let page = 1; page <= pageTexts.length; page++) {
    if (page === coverIndex || page === notesIndex) continue;
    if (looksLikeInfoPage(pageTexts[page - 1])) infoPages.push(page);
    else musicPages.push(page);
  }
  return { coverIndex, notesIndex, infoPages, musicPages };
}

/**
 * Assign each cover-page song a sheet-music page: first by finding the song title
 * in a page's (OCR) text, then sequentially for whatever is left. Mutates info.songs.
 */
export function matchSongsToPages(
  info: ContiInfo,
  pageTexts: string[],
  musicPages: number[],
): void {
  const taken = new Set<number>();

  for (const song of info.songs) {
    const want = normalizeTitle(song.title);
    if (!want) continue;
    const hit = musicPages.find(
      (p) => !taken.has(p) && normalizeTitle(pageTexts[p - 1] ?? '').includes(want),
    );
    if (hit) {
      song.pageIndex = hit;
      taken.add(hit);
    }
  }

  const free = musicPages.filter((p) => !taken.has(p));
  let next = 0;
  for (const song of info.songs) {
    if (song.pageIndex == null && next < free.length) {
      song.pageIndex = free[next++];
    }
  }
}

/**
 * Build an ordered song list straight from the sheet-music pages, for a conti
 * whose typed cover page is missing (or wasn't recognized). Each music page
 * becomes one song, in page order: matched to a library entry when its title
 * appears in the page's (OCR) text, otherwise a page-numbered stub the user
 * can fill in while looking at the score. The 공동체 고백송 may be among the
 * matched entries — callers should split it off exactly like the cover path.
 */
export function deriveSongsFromMusicPages(
  pageTexts: string[],
  musicPages: number[],
  library: LibraryEntry[],
): ContiSongEntry[] {
  return musicPages.map((page) => {
    const pageText = normalizeTitle(pageTexts[page - 1] ?? '');
    const hit = library.find((e) => {
      const t = normalizeTitle(e.title);
      return t.length >= 2 && pageText.includes(t);
    });
    return hit
      ? { title: hit.title, key: hit.key, pageIndex: page }
      : { title: `새 찬양 (p.${page})`, pageIndex: page };
  });
}

// The KCCP 공동체 고백송 — its lyric slides live in the fixed back-slides deck,
// so it never needs generated lyric slides. Matched by normalized title so
// spacing/case/punctuation differences on the cover page don't matter.
const CONFESSION_SONG_TITLE = normalizeTitle('Celebrate the Light');

/** True when a conti entry is the 공동체 고백송 supplied by the back slides. */
export function isConfessionSong(title: string): boolean {
  return normalizeTitle(title) === CONFESSION_SONG_TITLE;
}

/**
 * The 공동체 고백송 (Celebrate the Light) is supplied by the fixed back-slides
 * deck, so it is split off from the entries that need generated lyric slides.
 * Every other song — including the 입례 song, wherever it appears in the
 * order — stays in the lyrics list.
 */
export function splitLyricsAndConfessionSongs(songs: ContiSongEntry[]): {
  lyricsSongs: ContiSongEntry[];
  confessionSong?: ContiSongEntry;
} {
  const confessionSong = songs.find((song) => isConfessionSong(song.title));
  return {
    lyricsSongs: songs.filter((song) => song !== confessionSong),
    confessionSong,
  };
}
