import type { ContiInfo, ContiSongEntry, LibraryEntry } from './types';
import type { PositionedPage, PositionedText } from './chordSheet';
import { normalizeTitle } from '../storage/library';
import { DEFAULT_CONFESSION_SONG } from '../ai/aiSettings';
import { extractPartOrder } from './orderParser';
import { isPlaceholderTitle, isTitleSlip } from './contiAlignment';

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

const SCRIPTURE_RE = new RegExp(String.raw`^(?:본문|말씀)${LABEL_GAP}(\S.*)$`);
/** An explicitly labeled sermon title — the most reliable form. */
const SERMON_TITLE_RE = new RegExp(
  String.raw`^(?:설교\s*제목|말씀\s*제목|설교)${LABEL_GAP}(\S.*)$`,
);
/** `주제 | 청년의 때` — a theme row, used only when no explicit label exists. */
const SERMON_THEME_RE = new RegExp(String.raw`^(?:주제|제목)${LABEL_GAP}(\S.*)$`);
const DATE_LABEL_RE = new RegExp(String.raw`^(?:날짜|일자|예배\s*일)${LABEL_GAP}(\S.*)$`);

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
/**
 * `1 G` — a row whose 찬양 cell has no text at all. The title was written by
 * hand (pen on a tablet, or a scan pasted into the cell), so the PDF holds it
 * only as ink; the order number and the key are still typed.
 */
const UNTITLED_TABLE_ROW = new RegExp(
  String.raw`^(\d{1,2})\s*[.)]?${LABEL_GAP}(${KEY}(?:${KEY_ARROW}${KEY})*)\s*$`,
);
/** `1` — an order cell alone on its line: the row's cells sat on different baselines. */
const ORDER_CELL_RE = /^(\d{1,2})\s*[.)]?$/;
/** `1 주님의 은혜 넘치네` — order and title, with the key cell on the next line. */
const ORDER_AND_TITLE_RE = new RegExp(String.raw`^(\d{1,2})\s*[.)]?${LABEL_GAP}(\S.*)$`);
/** A title cell can wrap, but a table row is never more than a few lines tall. */
const MAX_TITLE_CELL_LINES = 3;

/** `• 매일매일 (A Key)` — the per-song commentary heading under the table. */
const SONG_BULLET_RE = /^[•·∙▪▫◦*]\s*(.*?)\s*[(（]([^)）]{1,60})[)）]\s*$/;
/** `o 이 찬양은…` — the indented description under a bullet heading. */
const BULLET_BODY_RE = /^[o○◦-]\s+(\S.*)$/;

/**
 * `2. 찬양 콘티 (Plan A)` — where the song table starts. The section number is
 * optional and the wording varies between contis (찬양 콘티, 찬양 순서,
 * 예배 순서), so match on the heading words rather than the exact phrase.
 */
const SONG_SECTION_RE = /^(?:\d+\s*[.)]\s*)?.{0,10}(?:찬양\s*콘티|찬양\s*순서|예배\s*순서|콘티)/;
/**
 * `(Plan A)`, `PLAN B`, `플랜 2` — which of several alternative song lists a
 * section is. A conti that writes a Plan B is offering a fallback set: the
 * service sings the first plan, and the second must not add its songs to it.
 */
const PLAN_RE = /(?:plan|플랜)\s*[-:.]?\s*([A-Za-z0-9]|[가-힣])(?![A-Za-z])/i;
/** Any other numbered section heading ("1. 말씀 묵상", "3. 본문") ends it. */
const SECTION_HEADING_RE = /^\d+\s*[.)]\s*\S/;
/**
 * The table's own header row, which carries no song. Column names differ
 * between contis (순서/번호, 찬양/곡/제목, 키/Key), and the row is by itself
 * proof that a song table follows — so it opens the section as well as being
 * skipped, for a conti that never writes a 찬양 콘티 heading at all.
 */
const TABLE_HEADER_RE =
  /^(?:순서|번호|No\.?)[\s|｜]*(?:찬양|곡|곡명|제목)[\s|｜]*(?:키|key)\s*$/i;

/**
 * The cover's title for a song the table could not name. It starts with
 * `새 찬양` like every other unnamed card, so the title read off the song's
 * 악보 replaces it (see isPlaceholderTitle), and the number keeps it in the
 * conti's slot until then.
 */
export function untitledSongTitle(order: number): string {
  return `새 찬양 (${order}번)`;
}

/**
 * A title cell's text, or undefined when it holds nothing readable. A font
 * embedded without a Unicode map comes out of the PDF as private-use or
 * control characters — the handwriting fonts do this — and that is no title
 * to search the library or the web by.
 */
function readableTitle(raw: string): string | undefined {
  const cleaned = raw
    .replace(/[\p{Co}\p{Cc}\p{Cf}�]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
  return /\p{L}/u.test(cleaned) ? cleaned : undefined;
}

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

/** The order number untitledSongTitle wrote into a placeholder, if it is one. */
function untitledSongOrder(title: string): number | undefined {
  const match = /^새 찬양 \((\d{1,2})번\)$/.exec(title.trim());
  return match ? Number(match[1]) : undefined;
}

/** Pieces of one line of text, left to right, with a space where there is a gap. */
function joinPositioned(items: PositionedText[]): string {
  let text = '';
  let end: number | null = null;
  for (const item of [...items].sort((a, b) => a.x - b.x)) {
    if (end !== null && item.x - end > 0.3 * item.size && !/\s$/.test(text)) text += ' ';
    text += item.str;
    end = item.x + item.width;
  }
  return text;
}

/**
 * What the page prints in row `order`'s 찬양 cell: everything drawn between
 * that row's order number and its key, on the row's line.
 *
 * The order number and the key are typed in the table's own font, so they
 * share a baseline; that pair is what finds the row (a numbered 말씀 line has
 * a number but no key beside it). The title may sit higher or lower — a
 * larger or handwriting font has its own baseline — so it only has to be
 * centred on the row, within its own size of the number.
 */
function titleCellText(page: PositionedPage, order: number, key: string): string | undefined {
  const firstKey = key.split(' -> ')[0];
  const middle = (item: PositionedText) => item.y + item.size / 2;
  for (const number of page.items) {
    if (!new RegExp(String.raw`^${order}\s*[.)]?$`).test(number.str.trim())) continue;
    const numberEnd = number.x + number.width;
    const keyCell = page.items
      .filter(
        (item) =>
          item !== number &&
          item.x >= numberEnd &&
          Math.abs(item.y - number.y) <= Math.max(2, number.size * 0.25) &&
          normalizeKeyChain(item.str.trim().split(/\s*(?:->|=>|→|⇒|~)\s*|\s+/)[0]) === firstKey,
      )
      .sort((a, b) => a.x - b.x)[0];
    if (!keyCell) continue;
    const cell = page.items.filter(
      (item) =>
        item !== number &&
        item !== keyCell &&
        item.x >= numberEnd - 1 &&
        item.x + item.width <= keyCell.x + 1 &&
        Math.abs(middle(item) - middle(number)) <= Math.max(item.size, number.size) * 0.75,
    );
    const title = readableTitle(joinPositioned(cell));
    if (title) return title;
  }
  return undefined;
}

/**
 * Name the table rows the cover's text could not, from where text sits on
 * the page.
 *
 * A PDF lists its text in the order it was drawn, not the order it is read.
 * A title set in another font is often drawn last — a handwriting font
 * embedded as a Type 3 font is — so it comes out after the whole page rather
 * than between its row's number and key, and the row reads as untitled. Its
 * position still puts it in its row. A row with truly nothing written in it
 * (a title in ink) finds nothing here and keeps its placeholder, which the
 * title read off its 악보 replaces. Mutates info.songs.
 */
export function nameUntitledRowsFromLayout(info: ContiInfo, pages: PositionedPage[]): void {
  for (const song of info.songs) {
    const order = untitledSongOrder(song.title);
    if (order === undefined || !song.key) continue;
    for (const page of pages) {
      const title = titleCellText(page, order, song.key);
      if (title) {
        song.title = title;
        break;
      }
    }
  }
}

/**
 * Read the two Bible-slide fields from any text-bearing non-score page. Unlike
 * parseCoverText this does not require a song list, so a standalone sermon
 * information page can still populate the next wizard step.
 */
export function parseSermonInfoText(text: string): Pick<ContiInfo, 'sermonTitle' | 'scripture'> {
  let sermonTitle: string | undefined;
  let theme: string | undefined;
  let scripture: string | undefined;

  const clean = (value: string) => value.trim().replace(/^[“"]|[”"]$/g, '').trim();

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
      sermonTitle ??= clean(titleMatch[1]);
      continue;
    }
    const themeMatch = line.match(SERMON_THEME_RE);
    if (themeMatch) theme ??= clean(themeMatch[1]);
  }

  // An explicit 설교 제목 always beats a 주제 row, wherever each sits on the page.
  return { sermonTitle: sermonTitle ?? theme, scripture };
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
 *
 * A row whose title cell holds no readable text — written by hand, or in a
 * font the PDF cannot map back to letters — keeps its place in the order as
 * an untitledSongTitle placeholder with its key, so it is paired with its own
 * 악보 page and named from it. A cover bullet that names it fills it in.
 */
function parseSongTable(lines: string[]): ContiSongEntry[] {
  const songs: ContiSongEntry[] = [];
  const byTitle = new Map<string, ContiSongEntry>();
  /** Rows the table could not name, in order, until a bullet names them. */
  const unnamed: ContiSongEntry[] = [];
  /** Songs the table itself lists — the service's order. */
  const tableRows: ContiSongEntry[] = [];
  /** Songs only a commentary bullet names; kept only when there is no table. */
  const bulletOnly = new Set<ContiSongEntry>();
  const remember = (song: ContiSongEntry) => {
    const existing = byTitle.get(normalizeTitle(song.title));
    if (existing) return existing;
    byTitle.set(normalizeTitle(song.title), song);
    songs.push(song);
    return song;
  };

  let inSection = false;
  let bullet: ContiSongEntry | null = null;
  /** The first plan the conti names (`A`); its list is the one sung. */
  let firstPlan: string | undefined;
  /** Inside another plan's section (Plan B): nothing there joins the list. */
  let otherPlan = false;
  /** Order number of the last row read, so a loose number must be the next one. */
  let lastOrder = 0;
  /**
   * A row whose cells came out on separate lines, still waiting for its key.
   * `bare` when the order number stood alone — only a table cell does that;
   * a number with words after it may be a note, and is a row only once its
   * key turns up.
   */
  let pending: { order: number; title: string[]; bare: boolean } | null = null;

  const addRow = (order: number, rawTitle: string, key?: string) => {
    lastOrder = order;
    const title = readableTitle(rawTitle);
    if (title) {
      const song = remember({ title, ...(key ? { key } : {}) });
      if (key) song.key ??= key;
      bulletOnly.delete(song);
      if (!tableRows.includes(song)) tableRows.push(song);
      return;
    }
    const song: ContiSongEntry = { title: untitledSongTitle(order), ...(key ? { key } : {}) };
    songs.push(song);
    unnamed.push(song);
    tableRows.push(song);
  };
  /**
   * The table row a commentary bullet describes: the row of that title, or
   * one whose title the bullet merely mistypes, in the same key.
   */
  const rowFor = (title: string, key: string): ContiSongEntry | undefined =>
    byTitle.get(normalizeTitle(title)) ??
    tableRows.find(
      (song) => (!song.key || song.key === key) && !unnamed.includes(song) && isTitleSlip(song.title, title),
    );
  const flushPending = () => {
    if (!pending) return;
    const { order, title, bare } = pending;
    pending = null;
    if (bare) addRow(order, title.join(' '));
  };
  /**
   * The table row a commentary bullet with no readable title of its own (or
   * one no row carries) describes: the first unnamed row, preferring one in
   * the same key.
   */
  const claimUnnamed = (key: string): ContiSongEntry | undefined => {
    const index = Math.max(
      0,
      unnamed.findIndex((song) => song.key === key),
    );
    return unnamed.splice(index, 1)[0];
  };
  /** Only the next number in sequence is a row; a stray page number is not. */
  const isNextRow = (order: number) => order === (pending?.order ?? lastOrder) + 1;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    // Either the section heading or the table's header row opens the table.
    if (SONG_SECTION_RE.test(line) || TABLE_HEADER_RE.test(line)) {
      flushPending();
      bullet = null;
      lastOrder = 0;
      const plan = line.match(PLAN_RE)?.[1]?.toUpperCase();
      if (plan) {
        firstPlan ??= plan;
        otherPlan = plan !== firstPlan;
      }
      // A header row inside Plan B names no plan; it is still Plan B's.
      inSection = !otherPlan;
      continue;
    }
    if (!inSection) continue;

    const bulletMatch = line.match(SONG_BULLET_RE);
    if (bulletMatch) {
      const key = normalizeKeyChain(bulletMatch[2]);
      if (key) {
        flushPending();
        const title = readableTitle(bulletMatch[1]);
        const known = title ? rowFor(title, key) : undefined;
        const row = known ?? claimUnnamed(key);
        if (row && title && !known) {
          // The bullet names the row the table could not.
          row.title = title;
          byTitle.set(normalizeTitle(title), row);
        }
        if (row) {
          bullet = row;
        } else if (title) {
          const before = songs.length;
          bullet = remember({ title, key });
          if (songs.length > before) bulletOnly.add(bullet);
        } else {
          bullet = null;
        }
        if (bullet) bullet.key ??= key;
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
      // Wrapped continuation of the previous description line — while that
      // line is mid-sentence, or when it is the song's 진행. Text after a
      // finished sentence is something else drawn on the page: a tablet adds
      // its reading of handwriting there, after everything typed.
      const unfinished = !!bullet.description && !/[.!?。]\s*$/.test(bullet.description);
      if (bullet.description && (unfinished || extractPartOrder(line))) bullet.description += ` ${line}`;
      continue;
    }

    const rowMatch = line.match(SONG_TABLE_ROW);
    if (rowMatch) {
      const key = normalizeKeyChain(rowMatch[3]);
      if (key) {
        flushPending();
        addRow(Number(rowMatch[1]), rowMatch[2], key);
        continue;
      }
    }

    // `1 G`: the title cell is ink, not text — the row still holds a song.
    const untitled = line.match(UNTITLED_TABLE_ROW);
    if (untitled && isNextRow(Number(untitled[1]))) {
      const key = normalizeKeyChain(untitled[2]);
      if (key) {
        flushPending();
        addRow(Number(untitled[1]), '', key);
        continue;
      }
    }

    // A row whose cells did not share a baseline (a title in a larger or
    // handwriting font) comes out a cell per line: `1` / `주님의 은혜` / `G`.
    const bareOrder = line.match(ORDER_CELL_RE);
    const orderCell = bareOrder ?? line.match(ORDER_AND_TITLE_RE);
    if (orderCell && isNextRow(Number(orderCell[1])) && !SECTION_HEADING_RE.test(line)) {
      flushPending();
      pending = { order: Number(orderCell[1]), title: orderCell[2] ? [orderCell[2]] : [], bare: !!bareOrder };
      continue;
    }
    if (pending) {
      const key = normalizeKeyChain(line);
      if (key) {
        const { order, title } = pending;
        pending = null;
        addRow(order, title.join(' '), key);
        continue;
      }
      if (!SECTION_HEADING_RE.test(line) && pending.title.length < MAX_TITLE_CELL_LINES) {
        pending.title.push(line);
        continue;
      }
      flushPending();
    }

    if (SECTION_HEADING_RE.test(line)) {
      // The next numbered section (3. 본문) closes the 찬양 콘티 block.
      inSection = false;
      bullet = null;
    }
  }
  flushPending();

  // The table is the order the service sings. A song that only a commentary
  // bullet names is not in it; without a table, the bullets are the list.
  return tableRows.length > 0 ? songs.filter((song) => !bulletOnly.has(song)) : songs;
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
  let lastSong: ContiSongEntry | undefined;

  for (const line of lines) {
    if (!line) continue;
    const scriptureMatch = line.match(SCRIPTURE_RE);
    if (scriptureMatch && SCRIPTURE_VALUE_RE.test(scriptureMatch[1])) {
      scripture ??= scriptureMatch[1].trim();
      continue;
    }
    const songMatch = line.match(SONG_LINE);
    if (songMatch && !songMatch[1].trim().startsWith('본문')) {
      lastSong = {
        title: songMatch[1].trim(),
        key: normalizeKey(songMatch[2]),
        description: songMatch[3].trim() || undefined,
      };
      songs.push(lastSong);
      continue;
    }
    // "진행: I-V1-C-B-C" on its own line belongs to the song just above it.
    const orderLine = lastSong ? extractPartOrder(line) : undefined;
    if (lastSong && orderLine) {
      lastSong.order ??= orderLine;
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

  // A 진행 순서 written with the song ("I-V1-C-V2-C-B-C") is how the conti
  // says which parts to sing; it goes with the song to the lyric editor.
  for (const song of songs) {
    const order = song.order ?? extractPartOrder(song.description);
    if (order) song.order = order;
  }

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

/**
 * Does this page read as a conti cover?
 *
 * Two independent signals, because covers are laid out differently from week
 * to week:
 *
 *  - a **song list plus service context** — what parseCoverText already
 *    requires, and the richest signal when the layout is one it can read;
 *  - a **sermon title and scripture together**. Those two are always written
 *    as a pair on the cover and nowhere else, so their co-location identifies
 *    the page even when the song list is laid out in a way the table parser
 *    cannot follow.
 *
 * The second signal matters most for a sparse cover — a date, the two sermon
 * fields, and a bare numbered song list with no key column. That page has too
 * little prose to look like an information page, so without this it would fall
 * through to musicPages and be recognized as an imaginary song.
 */
export function looksLikeCoverText(text: string): boolean {
  if (parseCoverText(text)) return true;
  const { sermonTitle, scripture } = parseSermonInfoText(text);
  return !!sermonTitle && !!scripture;
}

/**
 * How far into a conti the cover can START.
 *
 * The cover is normally page 1; a conti that opens with a decorative title
 * page puts it on page 2. Bounding where it may begin is what stops a later
 * page from being mistaken for one: a score page carrying a stray 본문 line,
 * or the printed-passage section, can otherwise look cover-shaped, and a
 * wrong cover takes the whole song list with it.
 *
 * How far the cover REACHES is not bounded — see findCoverPages.
 */
export const MAX_COVER_START_PAGE = 2;

/**
 * Does this page carry a mark that only a service write-up has?
 *
 * Used to follow a cover onto its later pages, where the page can be too
 * sparse to read as an information page on its own — the tail of the
 * commentary bullets, or a lone 본문 section. Every mark here is one a score
 * page cannot produce: a labeled service field whose value really is a
 * chapter/verse, the song table's own heading, or a `• 제목 (F -> G)`
 * commentary bullet whose parenthesis holds a musical key.
 *
 * The value checks are what keep it off a score: a lyric line beginning
 * "말씀 …" matches the 본문 label pattern, and only requiring a chapter/verse
 * after it tells the two apart.
 */
function hasCoverMark(text: string): boolean {
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const scripture = line.match(SCRIPTURE_RE);
    if (scripture && SCRIPTURE_VALUE_RE.test(scripture[1])) return true;
    if (SERMON_TITLE_RE.test(line) || SERMON_THEME_RE.test(line) || DATE_LABEL_RE.test(line)) return true;
    if (TABLE_HEADER_RE.test(line) || SONG_SECTION_RE.test(line)) return true;
    const bullet = line.match(SONG_BULLET_RE);
    if (bullet && normalizeKeyChain(bullet[2])) return true;
  }
  return false;
}

/**
 * Does this page continue the cover that started before it?
 *
 * Anything typed belongs to the cover: a second cover-shaped page, a page of
 * write-up prose, or a sparse page that only carries a cover mark. A page
 * that shows none of those is where the sheet music starts — which is where
 * the cover ends. The session-notes page is never part of it: it repeats the
 * song list, and parseCoverText refuses any text containing it.
 */
export function continuesCover(text: string): boolean {
  if (NOTES_RE.test(text)) return false;
  return looksLikeCoverText(text) || looksLikeInfoPage(text) || hasCoverMark(text);
}

/**
 * Every page of the cover: the run of leading pages up to the sheet music.
 *
 * The cover is one document however many pages it takes. A conti's write-up
 * commonly runs past the first page — the last songs' commentary, the printed
 * 본문 — and each of those pages is read as part of the cover rather than as a
 * score. That is what keeps the commentary attached to its song, gives the
 * sermon title and 본문 a chance to be read wherever in the write-up they were
 * typed, and stops a write-up page from being recognized as an imaginary song.
 *
 * Only where the cover BEGINS is bounded (MAX_COVER_START_PAGE); it then
 * reaches forward until a page reads as neither cover nor write-up, which is
 * the first page of sheet music.
 */
export function findCoverPages(pageTexts: string[]): number[] {
  const start = pageTexts.findIndex(
    (text, index) => index < MAX_COVER_START_PAGE && looksLikeCoverText(text),
  );
  if (start === -1) return [];
  const pages = [start + 1];
  for (let page = start + 2; page <= pageTexts.length; page++) {
    if (!continuesCover(pageTexts[page - 1])) break;
    pages.push(page);
  }
  return pages;
}

/** Classify PDF pages (1-based): cover, session-notes, and sheet-music pages. */
export function classifyPages(pageTexts: string[]): {
  /** Every page the cover spans, in order; empty when there is no cover. */
  coverPages: number[];
  /** First cover page, or null. Kept for callers that only need the one. */
  coverIndex: number | null;
  notesIndex: number | null;
  /** Typed information pages beyond the cover that carry no score. */
  infoPages: number[];
  musicPages: number[];
} {
  const coverPages = findCoverPages(pageTexts);
  const cover = new Set(coverPages);

  let notesIndex: number | null = null;
  for (let page = 1; page <= pageTexts.length; page++) {
    if (cover.has(page)) continue;
    if (NOTES_RE.test(pageTexts[page - 1])) {
      notesIndex = page;
      break;
    }
  }

  const infoPages: number[] = [];
  const musicPages: number[] = [];
  for (let page = 1; page <= pageTexts.length; page++) {
    if (cover.has(page) || page === notesIndex) continue;
    if (looksLikeInfoPage(pageTexts[page - 1])) infoPages.push(page);
    else musicPages.push(page);
  }
  return { coverPages, coverIndex: coverPages[0] ?? null, notesIndex, infoPages, musicPages };
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
    // A row the cover could not name has nothing to look for yet.
    if (isPlaceholderTitle(song.title)) continue;
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

// The 공동체 고백송 — its lyric slides live in the fixed back-slides deck, so
// it never needs generated lyric slides. Which song that is comes from
// 관리자 설정 (DEFAULT_CONFESSION_SONG is the one the bundled back deck
// prints). Matched by normalized title so spacing/case/punctuation
// differences on the cover page don't matter.

/** How a conti cover page usually labels the slot itself, not the song. */
const CONFESSION_LABEL = '공동체고백';

/** True when a conti entry is the 공동체 고백송 supplied by the back slides. */
export function isConfessionSong(title: string, confessionTitle?: string): boolean {
  const normalized = normalizeTitle(title);
  const wanted = normalizeTitle(confessionTitle ?? DEFAULT_CONFESSION_SONG);
  if (wanted.length >= 2 && normalized === wanted) return true;
  // Some contis print the slot rather than the song ("공동체 고백송"), which
  // names the same thing wherever the back slides supply the lyrics.
  return normalized.includes(CONFESSION_LABEL);
}

/**
 * Split a conti's song list into the three roles the deck gives them.
 *
 * The 공동체 고백송 is supplied by the fixed back-slides deck, so it is split
 * off from the entries that need generated lyric slides. The song listed
 * right AFTER it is the 설교 후 찬양 — sung after the sermon, so its slides
 * belong after the post-sermon 기도 slide rather than in the opening praise
 * set. Every other song — including the 입례 song, wherever it appears in the
 * order — stays in the lyrics list, in its printed order.
 */
export function splitLyricsAndConfessionSongs(
  songs: ContiSongEntry[],
  confessionTitle?: string,
): {
  lyricsSongs: ContiSongEntry[];
  confessionSong?: ContiSongEntry;
  postSermonSong?: ContiSongEntry;
} {
  const confessionIndex = songs.findIndex((song) => isConfessionSong(song.title, confessionTitle));
  const confessionSong = confessionIndex === -1 ? undefined : songs[confessionIndex];
  const postSermonSong =
    confessionIndex === -1 ? undefined : songs[confessionIndex + 1];
  return {
    lyricsSongs: songs.filter((song) => song !== confessionSong),
    confessionSong,
    postSermonSong,
  };
}

/**
 * The date a conti's file name carries, for a conti that prints none — a
 * chord-sheet PDF has no cover. "2026-10-03 찬양집회.pdf", "20261003.pdf",
 * "10_03_Praise.pdf" and "9.27 EM KM.pdf" all name one; a month-and-day name
 * is taken in `today`'s year. Written the way a cover writes it
 * ("2026.10.03"), or undefined when the name holds no date.
 */
export function dateFromFileName(name: string, today = new Date()): string | undefined {
  const stem = name.replace(/\.[a-z0-9]+$/i, '');
  const full = /(?:^|\D)(20\d{2})[._-]?(\d{1,2})[._-]?(\d{1,2})(?!\d)/.exec(stem);
  const short = /^(\d{1,2})[._-](\d{1,2})(?!\d)/.exec(stem.trim());
  const [year, month, day] = full
    ? [Number(full[1]), Number(full[2]), Number(full[3])]
    : short
      ? [today.getFullYear(), Number(short[1]), Number(short[2])]
      : [0, 0, 0];
  const date = new Date(year, month - 1, day);
  if (!year || date.getMonth() !== month - 1 || date.getDate() !== day) return undefined;
  return `${year}.${String(month).padStart(2, '0')}.${String(day).padStart(2, '0')}`;
}
