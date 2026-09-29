// 수련회 PPT 생성기 — one deck per 집회, in the retreat's own design.
//
// Three steps: 수련회 정보·콘티 (the retreat's name, and the 찬양 콘티 — one
// PDF or several — whose table's columns fill each session's songs, and whose
// 악보 pages lend lyrics to the songs nobody has yet) →
// 집회 순서 (each session's order of service: poster, songs, 설교말씀, 설교,
// 기도회, 축도, 광고…) → 다운로드.
//
// The closing Sunday service is a Sunday deck, so it is made with the
// 주일예배 generator; this page lists its songs and links there.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Icon, { type IconName } from '../components/Icon';
import ToastHost from '../components/ToastHost';
import AppShell, { StepNav } from '../components/AppShell';
import AutoSaveIndicator from '../components/AutoSaveIndicator';
import PptLibraryPanel from '../components/PptLibraryPanel';
import SlideThumbnail from '../components/SlideThumbnail';
import { showToast } from '../lib/utils/toast';
import type { DeckOverviewItem } from '../lib/utils/deckOverview';
import type { LibraryEntry } from '../lib/utils/types';
import { loadConti, type ContiDocument } from '../lib/utils/contiPdf';
import {
  fetchBundledLibrary,
  findEntry,
  libraryContentKey,
  loadUserLibrary,
  mergeLibraries,
  normalizeTitle,
  queueLyricsUpsert,
  saveUserLibrary,
  upsertEntry,
} from '../lib/storage/library';
import type { AutoSaveStatus } from '../lib/storage/deckAutoSave';
import { useSaveSoon } from '../lib/storage/saveSoon';
import { getSavedDeck, saveDeckToLibrary, type SavedDeck, type SavedFile } from '../lib/storage/pptLibrary';
import { loadTranslation } from '../bible/bibleData';
import { renderPptxSlides, revokeRenderedSlides, type RenderedSlide } from '../lib/pptx/pptxRenderer';
import { isWednesdaySource } from '../wednesday/source';
import { isPraiseSource } from '../praise/source';
import RetreatBlockEditor from './RetreatBlockEditor';
import { parseRetreatContiPages } from './conti';
import { buildRetreatDeck } from './deckBuilder';
import { clearRetreatDraft, loadRetreatDraft, saveRetreatDraft } from './draft';
import { planRetreatSession, suggestRetreatFileName } from './planner';
import { readRetreatScores, SCORE_RENDER_WIDTH, type ScorePage } from './scoreReader';
import { applyScoreSongs, retreatScorePages, titlesWithoutLyrics } from './scores';
import { resolveRetreatPassage, type RetreatPassage } from './scripture';
import {
  fetchSongSeeds,
  libraryEntryForRetreatSong,
  resolveSong as resolveSongFrom,
  SONG_SOURCE_LABEL,
  type RetreatSongSeed,
} from './songs';
import {
  attachPosters,
  decodeRetreatFiles,
  decodeRetreatSource,
  encodeRetreatFiles,
  encodeRetreatSource,
  isRetreatSource,
} from './source';
import { applyConti } from './state';
import {
  BLOCK_LABELS,
  createBlock,
  defaultRetreat,
  newId,
  type PosterImage,
  type RetreatBlock,
  type RetreatBlockKind,
  type RetreatSession,
  type RetreatState,
} from './types';

const BASE = import.meta.env.BASE_URL || '/';
const PASSAGE_DEBOUNCE_MS = 500;
/** Which 라이브러리 entry each session's deck was last saved to, so re-saving updates it. */
const LIBRARY_IDS_KEY = 'retreat-library-ids';

const STEPS = [
  { id: 'info', label: '수련회 정보·콘티' },
  { id: 'sessions', label: '집회 순서' },
  { id: 'download', label: '다운로드' },
] as const;

const ADDABLE_BLOCKS: RetreatBlockKind[] = [
  'title',
  'songs',
  'scripture',
  'sermon',
  'blank',
  'prayer',
  'benediction',
  'announcements',
];

function slideIcon(kind: DeckOverviewItem['kind']): IconName {
  switch (kind) {
    case 'lyrics-title':
    case 'lyrics':
      return 'music';
    case 'prayer':
      return 'prayer';
    case 'bible':
      return 'bible';
    case 'sermon':
      return 'sermon';
    case 'announcement':
      return 'announcement';
    case 'divider':
      return 'divider';
    default:
      return 'slide';
  }
}

function downloadBytes(bytes: Uint8Array, fileName: string): void {
  const blob = new Blob([bytes as unknown as BlobPart], {
    type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

function readLibraryIds(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(LIBRARY_IDS_KEY) ?? '{}') as Record<string, string>;
  } catch {
    return {};
  }
}

function writeLibraryIds(ids: Record<string, string>): void {
  try {
    localStorage.setItem(LIBRARY_IDS_KEY, JSON.stringify(ids));
  } catch {
    // Only a convenience: without it a re-save adds a new entry.
  }
}

/** Width, height and the edge colour of an uploaded poster (the cover's background). */
async function readPoster(file: File): Promise<PosterImage> {
  const mimeType = file.type === 'image/png' ? 'image/png' : file.type === 'image/jpeg' ? 'image/jpeg' : null;
  if (!mimeType) throw new Error('포스터는 PNG나 JPG 이미지만 쓸 수 있습니다.');
  const data = await file.arrayBuffer();
  const bitmap = await createImageBitmap(new Blob([data], { type: mimeType }));
  try {
    let background = '000000';
    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    const context = canvas.getContext('2d');
    if (context) {
      context.drawImage(bitmap, 2, 2, 1, 1, 0, 0, 1, 1);
      const [r, g, b] = context.getImageData(0, 0, 1, 1).data;
      background = [r, g, b].map((value) => value.toString(16).padStart(2, '0')).join('').toUpperCase();
    }
    return { name: file.name, mimeType, data, width: bitmap.width, height: bitmap.height, background };
  } finally {
    bitmap.close();
  }
}

/** The uploaded poster, drawn from one object URL that is released with it. */
function PosterThumb({ poster, alt }: { poster: PosterImage; alt: string }) {
  const url = useMemo(() => URL.createObjectURL(new Blob([poster.data], { type: poster.mimeType })), [poster]);
  useEffect(() => () => URL.revokeObjectURL(url), [url]);
  return <img className="retreat-poster-thumb" alt={alt} src={url} />;
}

export default function RetreatApp() {
  const [step, setStep] = useState(0);
  const [state, setState] = useState<RetreatState>(defaultRetreat);
  const [activeSessionId, setActiveSessionId] = useState<string>(() => state.sessions[0]?.id ?? '');
  const [ready, setReady] = useState(false);
  const [seeds, setSeeds] = useState<RetreatSongSeed[]>([]);
  const [library, setLibrary] = useState<LibraryEntry[]>([]);
  /** The conti as uploaded — a retreat's can come as several PDFs. */
  const [contiFiles, setContiFiles] = useState<SavedFile[]>([]);
  const [contiSummary, setContiSummary] = useState<string[] | null>(null);
  const [readingConti, setReadingConti] = useState(false);
  /** What the 악보 reading is doing, while it runs. */
  const [scoreProgress, setScoreProgress] = useState<string | null>(null);
  const [passages, setPassages] = useState<Record<string, RetreatPassage | null | undefined>>({});
  const [passageErrors, setPassageErrors] = useState<Record<string, string>>({});
  const [busySession, setBusySession] = useState<string | null>(null);
  const [overviews, setOverviews] = useState<Record<string, DeckOverviewItem[]>>({});
  // Each session's PPT as last written to the 라이브러리.
  const [deckSaves, setDeckSaves] = useState<Record<string, AutoSaveStatus>>({});
  const [preview, setPreview] = useState<{ sessionId: string; slides: RenderedSlide[] } | null>(null);
  const previewRef = useRef<RenderedSlide[]>([]);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [fileNames, setFileNames] = useState<Record<string, string>>({});

  // ---- song sources: last year's retreat decks, then the 찬양 라이브러리 ----
  useEffect(() => {
    void fetchSongSeeds(BASE).then(setSeeds);
    void fetchBundledLibrary(BASE).then((bundled) => setLibrary(mergeLibraries(bundled, loadUserLibrary())));
  }, []);
  const resolveSong = useCallback(
    (title: string) => resolveSongFrom(title, seeds, library, state.scoreSongs),
    [seeds, library, state.scoreSongs],
  );
  const knownTitles = useMemo(
    () => [...new Set([...seeds.map((seed) => seed.title), ...library.map((entry) => entry.title)])],
    [seeds, library],
  );
  const songTitles = useMemo(
    () => [...new Set([...knownTitles, ...state.scoreSongs.map((song) => song.title)])].sort((a, b) => a.localeCompare(b, 'ko')),
    [knownTitles, state.scoreSongs],
  );

  // ---- restore: a 라이브러리 entry in the URL, else this machine's draft ----
  const restoreSaved = useCallback(async (deck: SavedDeck) => {
    const decoded = decodeRetreatSource(deck.source);
    if (!decoded) {
      showToast(`'${deck.name}'은(는) 수련회 입력 내용이 함께 저장되지 않았습니다.`, 'warn');
      return;
    }
    const { posters, contis } = await decodeRetreatFiles(deck.additionalFiles ?? null);
    const restored = attachPosters(decoded.state, posters);
    setState(restored);
    setActiveSessionId(decoded.sessionId ?? restored.sessions[0]?.id ?? '');
    if (decoded.sessionId) writeLibraryIds({ ...readLibraryIds(), [decoded.sessionId]: deck.id });
    setContiFiles(deck.contiPdf ? [deck.contiPdf, ...contis] : contis);
    setStep(1);
    showToast(`'${deck.name}'을(를) 불러왔습니다.`);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const deckId = new URLSearchParams(window.location.search).get('deck');
      if (deckId) {
        try {
          const deck = await getSavedDeck(deckId);
          if (!cancelled) await restoreSaved(deck);
        } catch (error) {
          showToast(error instanceof Error ? error.message : String(error), 'error');
        }
      } else {
        const draft = await loadRetreatDraft();
        if (!cancelled && draft && draft.sessions.length > 0) {
          setState(draft);
          setActiveSessionId(draft.sessions[0].id);
        }
      }
      if (!cancelled) setReady(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [restoreSaved]);

  // Every edit is kept the moment it is made — the whole retreat in this
  // machine's draft, and its lyrics in the 찬양 라이브러리 as well (typed or
  // corrected here, or read off this year's 악보 for a song the library does
  // not have yet), so the next retreat or Sunday finds them.
  const libraryRef = useRef(library);
  libraryRef.current = library;
  const libraryWrittenRef = useRef<Map<string, string>>(new Map());
  useSaveSoon(() => {
    if (!ready) return;
    void saveRetreatDraft(state);
    const entries: LibraryEntry[] = [];
    for (const session of state.sessions) {
      for (const block of session.blocks) {
        if (block.kind !== 'songs') continue;
        for (const song of block.songs) {
          const previous = findEntry(libraryRef.current, song.title);
          const entry = libraryEntryForRetreatSong(song, previous);
          if (!entry) continue;
          const content = libraryContentKey(entry);
          if (previous && libraryContentKey(previous) === content) continue;
          if (libraryWrittenRef.current.get(song.id) === content) continue;
          libraryWrittenRef.current.set(song.id, content);
          entries.push(entry);
        }
      }
    }
    if (entries.length === 0) return;
    let user = loadUserLibrary();
    for (const entry of entries) {
      user = upsertEntry(user, entry);
      queueLyricsUpsert(entry);
    }
    saveUserLibrary(user);
    setLibrary((current) => entries.reduce((next, entry) => upsertEntry(next, entry), current));
  }, [ready, state]);

  useEffect(() => () => revokeRenderedSlides(previewRef.current), []);

  // ---- 설교말씀: read each scripture block's range as it is typed ----
  const scriptureInputs = state.sessions.flatMap((session) =>
    session.blocks.flatMap((block) => (block.kind === 'scripture' ? [{ id: block.id, passage: block.passage.trim() }] : [])),
  );
  const scriptureKey = JSON.stringify(scriptureInputs);
  useEffect(() => {
    let cancelled = false;
    const timer = window.setTimeout(() => {
      for (const { id, passage } of scriptureInputs) {
        if (!passage) continue;
        setPassages((current) => (current[id] === undefined ? current : { ...current, [id]: undefined }));
        resolveRetreatPassage(passage, (translation) => loadTranslation(BASE, translation))
          .then((resolved) => {
            if (cancelled) return;
            setPassages((current) => ({ ...current, [id]: resolved }));
            setPassageErrors(({ [id]: _dropped, ...rest }) => rest);
          })
          .catch((error: unknown) => {
            if (cancelled) return;
            setPassages((current) => ({ ...current, [id]: null }));
            setPassageErrors((current) => ({ ...current, [id]: error instanceof Error ? error.message : String(error) }));
          });
      }
    }, PASSAGE_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
    // scriptureKey stands for scriptureInputs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scriptureKey]);

  // ---- state updates ----
  const updateSession = (sessionId: string, update: (session: RetreatSession) => RetreatSession) =>
    setState((current) => ({
      ...current,
      sessions: current.sessions.map((session) => (session.id === sessionId ? update(session) : session)),
    }));
  const updateBlock = (sessionId: string, block: RetreatBlock) =>
    updateSession(sessionId, (session) => ({
      ...session,
      blocks: session.blocks.map((candidate) => (candidate.id === block.id ? block : candidate)),
    }));

  /**
   * Add conti PDFs and read them all: the song table, from whichever page of
   * whichever file holds it, and then the 악보 pages. One 악보 PDF holds every
   * 집회's songs, so the table decides where a song goes and the 악보 only
   * lends lyrics to the songs still without them; with no table, the songs
   * read off the 악보 are listed for the 집회 순서 to take from. A conti with
   * neither is still kept with the decks.
   */
  async function addContiFiles(files: File[]) {
    setReadingConti(true);
    const docs: { name: string; doc: ContiDocument }[] = [];
    try {
      const added: SavedFile[] = [];
      const unreadable: string[] = [];
      for (const file of files) {
        const data = await file.arrayBuffer();
        try {
          docs.push({ name: file.name, doc: await loadConti(data.slice(0)) });
          added.push({ name: file.name, data });
        } catch {
          unreadable.push(file.name);
        }
      }
      if (unreadable.length > 0) showToast(`PDF로 읽지 못해 건너뛰었습니다: ${unreadable.join(', ')}`, 'error');
      if (added.length === 0) return;
      setContiFiles((current) => {
        const known = new Set(current.map((file) => `${file.name}/${file.data.byteLength}`));
        return [...current, ...added.filter((file) => !known.has(`${file.name}/${file.data.byteLength}`))];
      });

      let next = state;
      const slots = parseRetreatContiPages(docs.flatMap(({ doc }) => doc.parsed.pageTexts));
      if (slots.length > 0) {
        const result = applyConti(state, slots, resolveSong);
        next = result.state;
        setState(next);
        setContiSummary([
          ...result.placed.map((item) => `${item.label} → ${item.target} (${item.count}곡)`),
          ...result.unplaced.map((label) => `${label} → 넣을 곳이 없어 건너뜀`),
        ]);
        showToast(`콘티에서 ${slots.reduce((sum, slot) => sum + slot.songs.length, 0)}곡을 읽어 집회마다 넣었습니다.`);
      }
      const hasTable = slots.length > 0 || contiSummary !== null;

      const pages: ScorePage[] = docs.flatMap(({ name, doc }) =>
        retreatScorePages(doc.parsed.pageTexts).map((page) => ({
          label: `${name} p.${page}`,
          text: doc.parsed.pageTexts[page - 1] ?? '',
          render: () => doc.renderPage(page, SCORE_RENDER_WIDTH, 'png'),
        })),
      );
      const missing = titlesWithoutLyrics(next);
      if (pages.length === 0 || (hasTable && missing.length === 0)) {
        if (!hasTable) showToast('콘티를 올렸습니다. 곡 표도 악보도 찾지 못해 곡은 집회 순서에서 직접 넣어 주세요.');
        return;
      }

      const wanted = new Set(missing.map(normalizeTitle));
      const tableTitles = next.sessions.flatMap((session) =>
        session.blocks.flatMap((block) => (block.kind === 'songs' ? block.songs.map((song) => song.title) : [])),
      );
      setScoreProgress('악보 읽는 중…');
      const read = await readRetreatScores(pages, {
        tableTitles,
        knownTitles,
        needsLyrics: (title) => (hasTable ? wanted.has(normalizeTitle(title)) : !resolveSong(title).lyrics.trim()),
        readUntitled: !hasTable,
        onProgress: setScoreProgress,
      });
      const { filled } = applyScoreSongs(next, read.songs);
      setState((current) => applyScoreSongs(current, read.songs).state);

      if (hasTable) {
        const still = missing.filter((title) => !filled.includes(title));
        showToast(
          (filled.length > 0 ? `악보에서 ${filled.length}곡의 가사를 읽어 넣었습니다.` : '악보에서 더 읽은 가사가 없습니다.') +
            (still.length > 0 ? ` 가사가 없는 곡: ${still.join(', ')}` : ''),
          still.length > 0 ? 'warn' : 'notice',
        );
      } else if (read.songs.length > 0) {
        showToast(
          `곡 표가 없어 악보에서 ${read.songs.length}곡을 읽었습니다. 집회 순서의 찬양에 곡 이름을 넣으면 가사가 함께 들어갑니다.`,
        );
      } else {
        showToast('콘티를 올렸습니다. 악보에서 곡을 읽지 못해 곡은 집회 순서에서 직접 넣어 주세요.');
      }
      if (read.error) showToast(`악보를 끝까지 읽지 못했습니다: ${read.error}`, 'warn');
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), 'error');
    } finally {
      for (const { doc } of docs) doc.destroy();
      setScoreProgress(null);
      setReadingConti(false);
    }
  }

  // ---- building ----
  const templateRef = useRef<Promise<ArrayBuffer> | null>(null);
  const template = () => {
    templateRef.current ??= fetch(`${BASE}retreat-template.pptx`).then((response) => {
      if (!response.ok) throw new Error('수련회 템플릿을 불러오지 못했습니다.');
      return response.arrayBuffer();
    });
    return templateRef.current;
  };

  const fileNameFor = (session: RetreatSession, index: number) => fileNames[session.id] ?? suggestRetreatFileName(session, index);

  async function build(session: RetreatSession) {
    const result = await buildRetreatDeck({ template: await template(), info: state.info, session, passages });
    setOverviews((current) => ({ ...current, [session.id]: result.overview }));
    return result;
  }

  /**
   * Every PPT generated here — for a preview or a download — goes into the
   * 라이브러리 at once, kept like 찬양집회 decks (a retreat is once a year).
   * Each session keeps one entry, rewritten each time. A save that fails
   * only says so on its row: the preview or download itself still happens.
   */
  async function saveSessionDeck(session: RetreatSession, index: number, deck: Uint8Array, overview: DeckOverviewItem[]) {
    const name = fileNameFor(session, index).replace(/(\.pptx)?$/i, '.pptx');
    setDeckSaves((current) => ({ ...current, [session.id]: { state: 'saving' } }));
    try {
      const ids = readLibraryIds();
      const { deck: saved } = await saveDeckToLibrary(
        {
          name,
          pptx: { name, data: deck.slice().buffer as ArrayBuffer },
          contiPdf: contiFiles[0] ?? null,
          sermonPptx: null,
          source: encodeRetreatSource(state, session.id),
          additionalFiles: await encodeRetreatFiles(state, contiFiles.slice(1)),
          slideCount: overview.length,
          songTitles: session.blocks.flatMap((block) => (block.kind === 'songs' ? block.songs.map((song) => song.title) : [])),
          keep: true,
        },
        ids[session.id],
      );
      writeLibraryIds({ ...readLibraryIds(), [session.id]: saved.id });
      setDeckSaves((current) => ({
        ...current,
        [session.id]: { state: 'saved', at: new Date().toISOString(), syncPending: Boolean(saved.syncPending) },
      }));
    } catch (error) {
      setDeckSaves((current) => ({
        ...current,
        [session.id]: { state: 'error', message: error instanceof Error ? error.message : String(error) },
      }));
    }
  }

  async function downloadSession(session: RetreatSession, index: number) {
    const waiting = session.blocks.some((block) => block.kind === 'scripture' && block.passage.trim() && passages[block.id] === undefined);
    if (waiting) {
      showToast('본문을 아직 불러오는 중입니다. 잠시 뒤 다시 눌러 주세요.', 'warn');
      return;
    }
    setBusySession(session.id);
    try {
      const { deck, overview } = await build(session);
      const name = fileNameFor(session, index).replace(/(\.pptx)?$/i, '.pptx');
      downloadBytes(deck, name);
      await saveSessionDeck(session, index, deck, overview);
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'PPT를 만들지 못했습니다.', 'error');
    } finally {
      setBusySession(null);
    }
  }

  async function previewSession(session: RetreatSession, index: number) {
    setBusySession(session.id);
    try {
      const { deck, overview } = await build(session);
      void saveSessionDeck(session, index, deck, overview);
      const slides = await renderPptxSlides(deck);
      revokeRenderedSlides(previewRef.current);
      previewRef.current = slides;
      setPreview({ sessionId: session.id, slides });
    } catch (error) {
      showToast(error instanceof Error ? error.message : '미리보기를 만들지 못했습니다.', 'error');
    } finally {
      setBusySession(null);
    }
  }

  const openFromLibrary = (deck: SavedDeck) => {
    setLibraryOpen(false);
    if (isRetreatSource(deck.source)) {
      void restoreSaved(deck);
    } else if (isPraiseSource(deck.source)) {
      window.location.href = `${BASE}praise.html?deck=${encodeURIComponent(deck.id)}`;
    } else if (isWednesdaySource(deck.source)) {
      window.location.href = `${BASE}wednesday.html?deck=${encodeURIComponent(deck.id)}`;
    } else {
      window.location.href = `${BASE}index.html?service=sunday&deck=${encodeURIComponent(deck.id)}`;
    }
  };

  const startOver = async () => {
    if (!window.confirm('지금 입력을 모두 지우고 새 수련회를 시작할까요? 라이브러리에 저장된 PPT는 그대로 남습니다.')) return;
    await clearRetreatDraft(state.sessions.map((session) => session.id));
    writeLibraryIds({});
    const fresh = defaultRetreat();
    setState(fresh);
    setActiveSessionId(fresh.sessions[0].id);
    setContiFiles([]);
    setContiSummary(null);
    setOverviews({});
    setPreview(null);
    setStep(0);
  };

  const activeSession = state.sessions.find((session) => session.id === activeSessionId) ?? state.sessions[0];
  const [addKind, setAddKind] = useState<RetreatBlockKind>('songs');

  return (
    <AppShell
      service="retreat"
      steps={STEPS}
      activeStep={step}
      onStepSelect={setStep}
      testIdPrefix="retreat"
      tools={
        <button
          type="button"
          className="btn library-open"
          onClick={() => setLibraryOpen(true)}
        >
          <Icon name="library" />
          <span className="btn-label">라이브러리</span>
        </button>
      }
    >
      {libraryOpen && <PptLibraryPanel onClose={() => setLibraryOpen(false)} onEdit={openFromLibrary} />}

      <div className="app-body">
        <main id="main-content">
          {/* ---- 1. 수련회 정보·콘티 ---- */}
          <section className={`wizard-panel${step === 0 ? ' active' : ''}`} aria-hidden={step !== 0} data-testid="retreat-panel-info">
            <div className="wizard-page-header">
              <p className="wizard-kicker">1 / 3</p>
              <h2>수련회 정보·콘티</h2>
              <p>수련회 이름과 콘티를 넣으면 콘티의 칸마다 해당 집회의 찬양으로 들어갑니다.</p>
            </div>
            <section className="card wednesday-form">
              <label className="field">
                <span className="field-label">수련회 이름</span>
                <input
                  type="text"
                  value={state.info.title}
                  data-testid="retreat-title"
                  onChange={(event) => setState((current) => ({ ...current, info: { ...current.info, title: event.target.value } }))}
                />
                <span className="field-hint">제목 슬라이드와 광고 슬라이드 아래에 들어갑니다.</span>
              </label>
              <label className="field">
                <span className="field-label">부제</span>
                <input
                  type="text"
                  value={state.info.subtitle}
                  onChange={(event) => setState((current) => ({ ...current, info: { ...current.info, subtitle: event.target.value } }))}
                />
              </label>
              <label className="field">
                <span className="field-label">주제 (광고 슬라이드 아래)</span>
                <input
                  type="text"
                  value={state.info.theme}
                  onChange={(event) => setState((current) => ({ ...current, info: { ...current.info, theme: event.target.value } }))}
                />
              </label>
              <div className="field">
                <span className="field-label">찬양 콘티 (PDF)</span>
                <div className="retreat-row">
                  <label className="btn">
                    <Icon name="upload" />
                    {readingConti ? '읽는 중…' : contiFiles.length > 0 ? '콘티 더 올리기' : '콘티 올리기'}
                    <input
                      type="file"
                      accept="application/pdf,.pdf"
                      multiple
                      className="visually-hidden"
                      data-testid="retreat-conti-input"
                      disabled={readingConti}
                      onChange={(event) => {
                        const files = Array.from(event.target.files ?? []);
                        if (files.length > 0) void addContiFiles(files);
                        event.target.value = '';
                      }}
                    />
                  </label>
                </div>
                {contiFiles.length > 0 && (
                  <ul className="retreat-conti-files" data-testid="retreat-conti-files">
                    {contiFiles.map((file, index) => (
                      <li key={`${file.name}/${index}`}>
                        <Icon name="file" />
                        <span className="retreat-conti-name">{file.name}</span>
                        <button
                          type="button"
                          className="btn btn-icon"
                          aria-label={`${file.name} 빼기`}
                          onClick={() => setContiFiles((current) => current.filter((_, other) => other !== index))}
                        >
                          <Icon name="close" />
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                <span className="field-hint">
                  PDF 여러 개(곡 표, 악보)를 한 번에 올리거나 이어서 더 올릴 수 있습니다. 모든 장에서 표(금요일 오후 예배,
                  기도회, 토요일 오전 특강 …)를 찾아 칸마다 해당 집회에 넣고, 곡 앞에 X를 적은 곡은 뺍니다. 가사는 작년
                  수련회 PPT, 찬양 라이브러리에서 먼저 채우고, 없는 곡은 악보를 읽어 채웁니다. 곡 표가 없으면 악보에서 읽은
                  곡을 아래에 모아 두니, 집회 순서의 찬양에서 곡 이름으로 골라 넣으세요.
                </span>
                {scoreProgress && (
                  <p className="field-hint" role="status" data-testid="retreat-score-progress">
                    {scoreProgress}
                  </p>
                )}
                {contiSummary && (
                  <ul className="retreat-conti-summary" data-testid="retreat-conti-summary">
                    {contiSummary.map((line) => (
                      <li key={line}>{line}</li>
                    ))}
                  </ul>
                )}
                {state.scoreSongs.length > 0 && (
                  <div className="retreat-score-songs" data-testid="retreat-score-songs">
                    <span className="field-label">악보에서 읽은 곡 ({state.scoreSongs.length})</span>
                    <ol>
                      {state.scoreSongs.map((song) => {
                        const resolved = resolveSong(song.title);
                        return (
                          <li key={song.title}>
                            <span>{song.title}</span>
                            <span className={`retreat-song-source${resolved.lyrics.trim() ? '' : ' is-missing'}`}>
                              {resolved.lyrics.trim() ? SONG_SOURCE_LABEL[resolved.source ?? 'manual'] : '가사 없음'}
                            </span>
                          </li>
                        );
                      })}
                    </ol>
                  </div>
                )}
              </div>
            </section>

            <section className="card retreat-closing" data-testid="retreat-closing">
              <h3>주일 폐회예배</h3>
              <p>
                주일 폐회예배는 주일예배와 같은 디자인이라 <strong>주일예배 생성기</strong>에서 만듭니다.
                {state.closingSongs.length > 0 ? ' 콘티의 주일 찬양:' : ''}
              </p>
              {state.closingSongs.length > 0 && (
                <ol>
                  {state.closingSongs.map((title) => (
                    <li key={title}>{title}</li>
                  ))}
                </ol>
              )}
              <a className="btn" href={`${BASE}index.html?service=sunday`}>
                <Icon name="next" />
                주일예배 생성기 열기
              </a>
            </section>
            <StepNav steps={STEPS} index={0} onMove={setStep} testIdPrefix="retreat" />
          </section>

          {/* ---- 2. 집회 순서 ---- */}
          <section
            className={`wizard-panel${step === 1 ? ' active' : ''}`}
            aria-hidden={step !== 1}
            data-testid="retreat-panel-sessions"
          >
            <div className="wizard-page-header">
              <p className="wizard-kicker">2 / 3</p>
              <h2>집회 순서</h2>
              <p>집회마다 포스터와 예배 순서를 정하세요. 순서대로 슬라이드가 만들어집니다.</p>
            </div>

            <div className="retreat-session-tabs" role="tablist" aria-label="집회">
              {state.sessions.map((session) => (
                <button
                  key={session.id}
                  type="button"
                  role="tab"
                  aria-selected={session.id === activeSession?.id}
                  className={`btn${session.id === activeSession?.id ? ' btn-primary' : ''}`}
                  data-testid="retreat-session-tab"
                  onClick={() => setActiveSessionId(session.id)}
                >
                  {session.name || '(이름 없음)'}
                </button>
              ))}
              <button
                type="button"
                className="btn btn-ghost"
                data-testid="retreat-add-session"
                onClick={() => {
                  const session: RetreatSession = {
                    id: newId(),
                    name: `집회 ${state.sessions.length + 1}`,
                    date: '',
                    poster: null,
                    blocks: [createBlock('title'), createBlock('songs')],
                  };
                  setState((current) => ({ ...current, sessions: [...current.sessions, session] }));
                  setActiveSessionId(session.id);
                }}
              >
                <Icon name="plus" />
                집회 추가
              </button>
            </div>

            {activeSession && (
              <div className="retreat-session" data-testid="retreat-session">
                <section className="card retreat-session-head">
                  <div className="field-row">
                    <label className="field">
                      <span className="field-label">집회 이름</span>
                      <input
                        type="text"
                        value={activeSession.name}
                        data-testid="retreat-session-name"
                        onChange={(event) => updateSession(activeSession.id, (session) => ({ ...session, name: event.target.value }))}
                      />
                    </label>
                    <label className="field">
                      <span className="field-label">날짜</span>
                      <input
                        type="date"
                        value={activeSession.date}
                        data-testid="retreat-session-date"
                        onChange={(event) => updateSession(activeSession.id, (session) => ({ ...session, date: event.target.value }))}
                      />
                    </label>
                  </div>
                  <div className="field">
                    <span className="field-label">설교 포스터 (표지)</span>
                    <div className="retreat-row">
                      {activeSession.poster && <PosterThumb poster={activeSession.poster} alt={`${activeSession.name} 포스터`} />}
                      <label className="btn">
                        <Icon name="upload" />
                        {activeSession.poster ? '다른 포스터로 바꾸기' : '포스터 올리기'}
                        <input
                          type="file"
                          accept="image/png,image/jpeg"
                          className="visually-hidden"
                          data-testid="retreat-poster-input"
                          onChange={(event) => {
                            const file = event.target.files?.[0];
                            event.target.value = '';
                            if (!file) return;
                            const sessionId = activeSession.id;
                            readPoster(file)
                              .then((poster) => updateSession(sessionId, (session) => ({ ...session, poster })))
                              .catch((error: unknown) => showToast(error instanceof Error ? error.message : String(error), 'error'));
                          }}
                        />
                      </label>
                      {activeSession.poster && (
                        <button
                          type="button"
                          className="btn btn-ghost"
                          onClick={() => updateSession(activeSession.id, (session) => ({ ...session, poster: null }))}
                        >
                          포스터 빼기
                        </button>
                      )}
                    </div>
                    <span className="field-hint">
                      첫 장에 가운데 맞춰 들어가고, 남는 자리는 포스터 가장자리 색으로 채웁니다. 없으면 표지 없이 제목부터 시작합니다.
                    </span>
                  </div>
                </section>

                <ol className="retreat-blocks">
                  {activeSession.blocks.map((block, index) => (
                    <RetreatBlockEditor
                      key={block.id}
                      block={block}
                      index={index}
                      total={activeSession.blocks.length}
                      passage={passages[block.id]}
                      passageError={passageErrors[block.id]}
                      songTitles={songTitles}
                      resolveSong={resolveSong}
                      onChange={(next) => updateBlock(activeSession.id, next)}
                      onMove={(delta) =>
                        updateSession(activeSession.id, (session) => {
                          const blocks = [...session.blocks];
                          const target = index + delta;
                          [blocks[index], blocks[target]] = [blocks[target], blocks[index]];
                          return { ...session, blocks };
                        })
                      }
                      onRemove={() =>
                        updateSession(activeSession.id, (session) => ({
                          ...session,
                          blocks: session.blocks.filter((candidate) => candidate.id !== block.id),
                        }))
                      }
                    />
                  ))}
                </ol>

                <div className="retreat-row retreat-add-block">
                  <select
                    aria-label="추가할 순서"
                    value={addKind}
                    data-testid="retreat-add-block-kind"
                    onChange={(event) => setAddKind(event.target.value as RetreatBlockKind)}
                  >
                    {ADDABLE_BLOCKS.map((kind) => (
                      <option key={kind} value={kind}>
                        {BLOCK_LABELS[kind]}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    className="btn"
                    data-testid="retreat-add-block"
                    onClick={() =>
                      updateSession(activeSession.id, (session) => ({ ...session, blocks: [...session.blocks, createBlock(addKind)] }))
                    }
                  >
                    <Icon name="plus" />
                    순서 추가
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost btn-danger"
                    onClick={() => {
                      if (state.sessions.length <= 1) return;
                      if (!window.confirm(`'${activeSession.name}' 집회를 지울까요?`)) return;
                      const remaining = state.sessions.filter((session) => session.id !== activeSession.id);
                      setState((current) => ({ ...current, sessions: remaining }));
                      setActiveSessionId(remaining[0].id);
                    }}
                    disabled={state.sessions.length <= 1}
                  >
                    <Icon name="trash" />
                    이 집회 지우기
                  </button>
                </div>
              </div>
            )}
            <StepNav steps={STEPS} index={1} onMove={setStep} testIdPrefix="retreat" />
          </section>

          {/* ---- 3. 다운로드 ---- */}
          <section
            className={`wizard-panel${step === 2 ? ' active' : ''}`}
            aria-hidden={step !== 2}
            data-testid="retreat-panel-download"
          >
            <div className="wizard-page-header">
              <p className="wizard-kicker">3 / 3</p>
              <h2>다운로드</h2>
              <p>집회마다 PPT를 따로 내려받습니다. 미리보기나 다운로드로 만든 PPT는 그때마다 라이브러리에 자동 저장되고, 매주 자동 삭제되지 않습니다.</p>
            </div>
            <ul className="retreat-downloads">
              {state.sessions.map((session, index) => {
                const plans = planRetreatSession(session, passages);
                const songCount = session.blocks.reduce((sum, block) => sum + (block.kind === 'songs' ? block.songs.length : 0), 0);
                const missing = session.blocks.flatMap((block) =>
                  block.kind === 'songs' ? block.songs.filter((song) => !song.lyrics.trim()).map((song) => song.title) : [],
                );
                const overview = overviews[session.id];
                return (
                  <li key={session.id} className="card retreat-download" data-testid="retreat-download-row">
                    <header className="retreat-block-head">
                      <strong>{session.name || `집회 ${index + 1}`}</strong>
                      <span className="retreat-block-meta">
                        슬라이드 {plans.length}장 · 찬양 {songCount}곡{session.poster ? ' · 포스터' : ''}
                      </span>
                    </header>
                    {missing.length > 0 && (
                      <p className="banner banner-warn">
                        <Icon name="warning" />
                        <span className="banner-text">가사가 없는 곡: {missing.join(', ')} — 제목 슬라이드만 들어갑니다.</span>
                      </p>
                    )}
                    <label className="field">
                      <span className="field-label">파일명</span>
                      <input
                        type="text"
                        value={fileNameFor(session, index)}
                        data-testid="retreat-file-name"
                        onChange={(event) => setFileNames((current) => ({ ...current, [session.id]: event.target.value }))}
                      />
                    </label>
                    <div className="download-actions">
                      <button
                        type="button"
                        className="btn"
                        disabled={busySession !== null}
                        data-testid="retreat-preview"
                        onClick={() => void previewSession(session, index)}
                      >
                        <Icon name="slide" />
                        미리보기
                      </button>
                      <button
                        type="button"
                        className="btn btn-primary btn-download"
                        disabled={busySession !== null}
                        data-testid="retreat-download"
                        onClick={() => void downloadSession(session, index)}
                      >
                        <Icon name="download" />
                        {busySession === session.id ? '만드는 중…' : 'PPT 다운로드'}
                      </button>
                    </div>
                    {deckSaves[session.id] && (
                      <AutoSaveIndicator status={deckSaves[session.id]} testId="retreat-auto-save-status" />
                    )}
                    {preview?.sessionId === session.id ? (
                      <div className="praise-preview" data-testid="retreat-preview-grid">
                        <ol>
                          {preview.slides.map((slide, slideIndex) => (
                            <li key={slideIndex}>
                              <SlideThumbnail slide={slide} width={200} />
                              <span className="praise-preview-label">
                                {slideIndex + 1}. {overview?.[slideIndex]?.label ?? ''}
                              </span>
                            </li>
                          ))}
                        </ol>
                      </div>
                    ) : (
                      overview && (
                        <div className="wednesday-slide-list" data-testid="retreat-slide-list">
                          <ol>
                            {overview.map((item, slideIndex) => (
                              <li key={item.id}>
                                <span className="wednesday-slide-index">{slideIndex + 1}</span>
                                <Icon name={slideIcon(item.kind)} />
                                <span className="wednesday-slide-label">{item.label}</span>
                                {item.subtitle && <span className="wednesday-slide-subtitle">{item.subtitle}</span>}
                              </li>
                            ))}
                          </ol>
                        </div>
                      )
                    )}
                  </li>
                );
              })}
            </ul>
            <div className="download-actions">
              <button type="button" className="btn btn-ghost" data-testid="retreat-reset" onClick={() => void startOver()}>
                <Icon name="trash" />
                새 수련회 시작
              </button>
            </div>
            <StepNav steps={STEPS} index={2} onMove={setStep} testIdPrefix="retreat" />
          </section>
        </main>
      </div>
    <ToastHost />
    </AppShell>
  );
}
