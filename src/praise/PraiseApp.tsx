// 찬양집회 PPT 생성기 — the praise-night deck, bilingual from end to end.
//
// Four steps: 찬양 (the same 콘티 upload and 악보 recognition as the Sunday
// page) → 영어 가사 (English under every Korean slide) → 추가 자료 (a sermon
// PPT, 말씀 slides… placed anywhere between songs) → 다운로드.
//
// Every deck made here is saved to the shared PPT 라이브러리 with `keep`, so
// the weekly Sunday purge never removes it: a 찬양집회 deck goes only when
// someone deletes it by hand.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Icon, { type IconName } from '../components/Icon';
import ToastHost from '../components/ToastHost';
import AutoSaveIndicator from '../components/AutoSaveIndicator';
import LyricsGenerator from '../components/LyricsGenerator';
import AdditionalFilesSection from '../components/AdditionalFilesSection';
import PptLibraryPanel from '../components/PptLibraryPanel';
import SlideThumbnail from '../components/SlideThumbnail';
import { showToast } from '../lib/utils/toast';
import type { LibraryEntry, Song } from '../lib/utils/types';
import { normalizeTitle } from '../lib/storage/library';
import type { DeckOverviewItem } from '../lib/utils/deckOverview';
import type { AdditionalFile } from '../lib/additionalFiles/types';
import { convertAdditionalFile } from '../lib/additionalFiles/convert';
import { renderPptxSlides, revokeRenderedSlides, type RenderedSlide } from '../lib/pptx/pptxRenderer';
import { getSavedDeck, saveDeckToLibrary, type SavedDeck } from '../lib/storage/pptLibrary';
import { isWednesdaySource } from '../wednesday/source';
import {
  AUTO_SAVE_BUSY_POLL_MS,
  AUTO_SAVE_DEBOUNCE_MS,
  AUTO_SAVE_RETRY_MS,
  type AutoSaveStatus,
} from '../lib/storage/deckAutoSave';
import PraiseEnglishStep from './PraiseEnglishStep';
import { buildPraiseDeck, formatCoverDate, isoDateFromConti, suggestPraiseFileName } from './deckBuilder';
import {
  entryFromSong,
  fetchSeedEnglish,
  fillEnglishFromLibrary,
  loadSavedEnglish,
  mergeEnglishLibraries,
  saveEnglishEntry,
  songFromEnglishEntry,
  synchronizeEnglishLibrary,
  type EnglishSongEntry,
} from './englishLibrary';
import { missingEnglishCount, planPraiseDeck, type AdditionalPlacement, type PlacedAdditional } from './planner';
import {
  decodePraiseSource,
  encodePraiseFiles,
  encodePraiseSource,
  isPraiseSource,
  praiseFingerprint,
  restorePraiseState,
  type PraiseState,
} from './source';
import { extrasFor, type PraiseCoverImage, type PraiseSongExtras } from './types';

const BASE = import.meta.env.BASE_URL || '/';
/** The deck this browser was last working on, reopened on the next visit. */
const LAST_DECK_KEY = 'praise-last-deck-id';
/** How long a song's lyrics must stay unchanged before they are saved. */
const LYRICS_SAVE_DEBOUNCE_MS = 2500;

function englishLineCount(entry: EnglishSongEntry): number {
  return entry.slides.reduce((sum, slide) => sum + slide.en.length, 0);
}

function sameEntry(a: EnglishSongEntry, b: EnglishSongEntry): boolean {
  return a.englishTitle === b.englishTitle && JSON.stringify(a.slides) === JSON.stringify(b.slides);
}

const STEPS = [
  { id: 'songs', label: '찬양' },
  { id: 'english', label: '영어 가사' },
  { id: 'additional', label: '추가 자료' },
  { id: 'download', label: '다운로드' },
] as const;

function slideIcon(kind: DeckOverviewItem['kind']): IconName {
  switch (kind) {
    case 'lyrics-title':
    case 'lyrics':
      return 'music';
    case 'prayer':
      return 'prayer';
    case 'additional':
      return 'file';
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
  anchor.download = fileName.endsWith('.pptx') ? fileName : `${fileName}.pptx`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

async function fetchAsset(name: string, label: string): Promise<ArrayBuffer> {
  const response = await fetch(`${BASE}${name}`);
  if (!response.ok) throw new Error(`${label}을(를) 불러오지 못했습니다.`);
  return response.arrayBuffer();
}

function readLastDeck(): string | null {
  try {
    return localStorage.getItem(LAST_DECK_KEY);
  } catch {
    return null;
  }
}

function writeLastDeck(id: string | null): void {
  try {
    if (id) localStorage.setItem(LAST_DECK_KEY, id);
    else localStorage.removeItem(LAST_DECK_KEY);
  } catch {
    // Only a convenience: the deck itself is in the 라이브러리.
  }
}

function placementValue(placement: AdditionalPlacement): string {
  return typeof placement === 'object' ? `song:${placement.afterSongId}` : placement;
}

function placementFromValue(value: string): AdditionalPlacement {
  if (value.startsWith('song:')) return { afterSongId: value.slice('song:'.length) };
  return value === 'start' ? 'start' : 'end';
}

export default function PraiseApp() {
  const [step, setStep] = useState(0);
  const [songs, setSongs] = useState<Song[]>([]);
  const [extras, setExtras] = useState<Record<string, PraiseSongExtras>>({});
  const [date, setDate] = useState('');
  const [contiFile, setContiFile] = useState<{ name: string; data: ArrayBuffer } | null>(null);
  const [additionalFiles, setAdditionalFiles] = useState<AdditionalFile[]>([]);
  const [placements, setPlacements] = useState<PlacedAdditional[]>([]);
  const [coverImage, setCoverImage] = useState<PraiseCoverImage | null>(null);
  const [fileNameOverride, setFileNameOverride] = useState<string | null>(null);
  const [englishLibrary, setEnglishLibrary] = useState<EnglishSongEntry[]>([]);
  const seedRef = useRef<EnglishSongEntry[]>([]);

  const [restore, setRestore] = useState<{ version: number; songs: Song[] | null; conti: { name: string; data: ArrayBuffer } | null }>(
    { version: 0, songs: null, conti: null },
  );
  const [replaceSong, setReplaceSong] = useState<{ version: number; song: Song } | null>(null);

  const [libraryOpen, setLibraryOpen] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [overview, setOverview] = useState<DeckOverviewItem[] | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [preview, setPreview] = useState<RenderedSlide[] | null>(null);
  const previewRef = useRef<RenderedSlide[]>([]);
  const [ready, setReady] = useState(false);

  const [autoSaveStatus, setAutoSaveStatus] = useState<AutoSaveStatus>({ state: 'idle' });
  const [autoSaveRetry, setAutoSaveRetry] = useState(0);
  const savedFingerprintRef = useRef<string | null>(null);
  const autoSaveTargetRef = useRef<string | null>(null);
  const autoSaveFailedRef = useRef<string | null>(null);
  const adoptFingerprintRef = useRef(false);
  const savingRef = useRef(false);
  const retryTimer = useRef<number | undefined>(undefined);

  const fileName = fileNameOverride ?? suggestPraiseFileName(date);
  const savedName = fileName.endsWith('.pptx') ? fileName : `${fileName}.pptx`;
  const state: PraiseState = {
    date,
    songs,
    extras,
    additionalFiles,
    placements,
    coverImage,
    fileNameOverride: fileNameOverride ?? undefined,
  };

  // ---- 영어 가사 library: last year's deck, plus every song saved since ----
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const seed = await fetchSeedEnglish(BASE);
      seedRef.current = seed;
      if (cancelled) return;
      setEnglishLibrary(mergeEnglishLibraries(seed, loadSavedEnglish()));
      const synced = await synchronizeEnglishLibrary();
      if (!cancelled) setEnglishLibrary(mergeEnglishLibraries(seed, synced.entries));
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // English the library already knows goes in by itself — only into empty
  // slides, never over anything typed, pasted or asked of the AI.
  useEffect(() => {
    if (englishLibrary.length === 0 || songs.length === 0) return;
    setExtras((previous) => {
      let changed = false;
      const next = { ...previous };
      for (const song of songs) {
        const current = extrasFor(previous, song.id);
        const { english, filled, titleFilled } = fillEnglishFromLibrary(song, current.english, englishLibrary);
        if (filled === 0 && !titleFilled) continue;
        next[song.id] = { ...current, english, englishSource: current.englishSource ?? 'memory' };
        changed = true;
      }
      return changed ? next : previous;
    });
  }, [songs, englishLibrary]);

  // The bilingual songs, offered to the 찬양 step ahead of the 찬양 라이브러리:
  // a conti naming one loads its Korean split exactly as its English was.
  const preferredSongs = useMemo<LibraryEntry[]>(
    () =>
      englishLibrary
        .filter((entry) => entry.slides.some((slide) => slide.en.length > 0))
        .map((entry) => {
          const { song } = songFromEnglishEntry(entry, 'preferred');
          return { title: entry.title, sections: song.sections, order: song.order, verification: 'verified' };
        }),
    [englishLibrary],
  );

  // Every song on a 찬양집회 conti is kept in both languages as soon as its
  // lyrics settle — no button to press. The Korean also reaches the 찬양
  // 라이브러리 through the 찬양 step's own draft save, and that is all the
  // Sunday page ever reads: other services load the Korean only.
  const englishLibraryRef = useRef(englishLibrary);
  englishLibraryRef.current = englishLibrary;
  useEffect(() => {
    if (!ready || songs.length === 0) return;
    const timer = window.setTimeout(() => {
      void (async () => {
        let saved: EnglishSongEntry[] | null = null;
        for (const song of songs) {
          const title = song.title.trim();
          if (!title || /^새 찬양/.test(title)) continue;
          const current = extrasFor(extras, song.id);
          const entry = entryFromSong(song, current.english);
          if (entry.slides.length === 0) continue;
          const existing = englishLibraryRef.current.find(
            (candidate) => normalizeTitle(candidate.title) === normalizeTitle(title),
          );
          if (existing && sameEntry(existing, entry)) continue;
          // A partial reading (lyrics that only partly lined up) must not wipe
          // out a saved copy with more English; a complete one, or anything
          // typed, replaces it.
          const complete = missingEnglishCount(song, current) === 0;
          if (
            existing &&
            !complete &&
            current.englishSource !== 'manual' &&
            englishLineCount(entry) < englishLineCount(existing)
          ) {
            continue;
          }
          saved = await saveEnglishEntry(entry);
        }
        if (saved) setEnglishLibrary(mergeEnglishLibraries(seedRef.current, saved));
      })().catch(() => undefined);
    }, LYRICS_SAVE_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [ready, songs, extras]);

  const updateExtras = useCallback(
    (songId: string, update: (current: PraiseSongExtras) => PraiseSongExtras) =>
      setExtras((previous) => ({ ...previous, [songId]: update(extrasFor(previous, songId)) })),
    [],
  );

  const loadSongFromLibrary = useCallback((song: Song, entry: EnglishSongEntry) => {
    const restored = songFromEnglishEntry(entry, song.id);
    setReplaceSong((previous) => ({ version: (previous?.version ?? 0) + 1, song: { ...restored.song, pageIndex: song.pageIndex } }));
    setExtras((previous) => ({
      ...previous,
      [song.id]: { ...extrasFor(previous, song.id), english: restored.english, englishSource: 'memory' },
    }));
    showToast(`'${entry.title}'을(를) 저장된 한글·영어 가사로 불러왔습니다.`);
  }, []);

  const rememberEnglish = useCallback(async (targets: Song[]) => {
    let entries: EnglishSongEntry[] | null = null;
    for (const song of targets) {
      if (!song.title.trim()) continue;
      const entry = entryFromSong(song, extrasFor(extras, song.id).english);
      if (entry.slides.length === 0) continue;
      entries = await saveEnglishEntry(entry);
    }
    if (entries) setEnglishLibrary(mergeEnglishLibraries(seedRef.current, entries));
    if (targets.length === 1) showToast(`'${targets[0].title}' 영어 가사를 저장했습니다. 다음 찬양집회에서 자동으로 채워집니다.`);
  }, [extras]);

  // ---- build ----
  const build = useCallback(async () => {
    const [template, imageTemplate] = await Promise.all([
      fetchAsset('praise-template.pptx', '찬양집회 템플릿'),
      additionalFiles.some((file) => file.kind !== 'pptx')
        ? fetchAsset('template.pptx', '추가 자료용 템플릿')
        : Promise.resolve(null),
    ]);
    return buildPraiseDeck({
      template,
      songs,
      extras,
      date,
      coverImage,
      additionalFiles,
      placements,
      convertAdditional: (file) => convertAdditionalFile(file, imageTemplate ?? new Uint8Array()),
    });
  }, [additionalFiles, coverImage, date, extras, placements, songs]);

  // ---- 라이브러리: restore an entry, then keep it current ----
  const restoreSavedDeck = useCallback(async (deck: SavedDeck, quiet = false) => {
    const source = decodePraiseSource(deck.source);
    if (!source) {
      if (!quiet) showToast(`'${deck.name}'은(는) 찬양집회 입력 내용이 함께 저장되지 않았습니다.`, 'warn');
      return;
    }
    const restored = await restorePraiseState(source, deck.additionalFiles ?? null);
    setDate(restored.date);
    setExtras(restored.extras);
    setAdditionalFiles(restored.additionalFiles);
    setPlacements(restored.placements);
    setCoverImage(restored.coverImage);
    setFileNameOverride(restored.fileNameOverride ?? deck.name);
    setContiFile(deck.contiPdf);
    setSongs(restored.songs);
    setRestore((previous) => ({ version: previous.version + 1, songs: restored.songs, conti: null }));
    setOverview(null);
    autoSaveTargetRef.current = deck.id;
    savedFingerprintRef.current = null;
    adoptFingerprintRef.current = true;
    writeLastDeck(deck.id);
    if (!quiet) showToast(`'${deck.name}'을(를) 불러왔습니다. 수정하면 같은 항목이 자동으로 갱신됩니다.`);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const requested = new URLSearchParams(window.location.search).get('deck');
      const id = requested ?? readLastDeck();
      if (id) {
        try {
          const deck = await getSavedDeck(id);
          if (!cancelled && isPraiseSource(deck.source)) await restoreSavedDeck(deck, !requested);
        } catch {
          // A remembered deck someone deleted since: start empty.
          if (!requested) writeLastDeck(null);
        }
      }
      if (!cancelled) setReady(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [restoreSavedDeck]);

  const openFromLibrary = useCallback(
    (deck: SavedDeck) => {
      setLibraryOpen(false);
      if (isPraiseSource(deck.source)) {
        void restoreSavedDeck(deck);
        setStep(0);
        return;
      }
      if (isWednesdaySource(deck.source)) {
        window.location.href = `${BASE}wednesday.html?deck=${encodeURIComponent(deck.id)}`;
        return;
      }
      window.location.href = `${BASE}index.html?service=sunday&deck=${encodeURIComponent(deck.id)}`;
    },
    [restoreSavedDeck],
  );

  const saveToLibrary = useCallback(
    async (fingerprint: string) => {
      savingRef.current = true;
      setAutoSaveStatus({ state: 'saving' });
      try {
        const built = await build();
        const { deck: saved } = await saveDeckToLibrary(
          {
            name: savedName,
            pptx: { name: savedName, data: built.deck.slice().buffer as ArrayBuffer },
            contiPdf: contiFile,
            sermonPptx: null,
            source: encodePraiseSource(state),
            additionalFiles: await encodePraiseFiles(state),
            slideCount: built.overview.length,
            songTitles: songs.map((song) => song.title.trim()).filter(Boolean),
            // 찬양집회 decks are kept until someone deletes them by hand.
            keep: true,
          },
          autoSaveTargetRef.current ?? undefined,
        );
        savedFingerprintRef.current = fingerprint;
        autoSaveTargetRef.current = saved.id;
        autoSaveFailedRef.current = null;
        writeLastDeck(saved.id);
        setAutoSaveStatus({ state: 'saved', at: new Date().toISOString(), syncPending: Boolean(saved.syncPending) });
      } catch (error) {
        setAutoSaveStatus({ state: 'error', message: error instanceof Error ? error.message : String(error) });
        if (autoSaveFailedRef.current !== fingerprint) {
          autoSaveFailedRef.current = fingerprint;
          window.clearTimeout(retryTimer.current);
          retryTimer.current = window.setTimeout(() => setAutoSaveRetry((count) => count + 1), AUTO_SAVE_RETRY_MS);
        }
      } finally {
        savingRef.current = false;
      }
    },
    // `state` is rebuilt from these every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [build, contiFile, savedName, songs, date, extras, additionalFiles, placements, coverImage, fileNameOverride],
  );

  const fingerprint = praiseFingerprint({ ...state, name: savedName });
  useEffect(() => {
    if (!ready) return;
    if (songs.length === 0 && additionalFiles.length === 0) return;
    if (adoptFingerprintRef.current) {
      adoptFingerprintRef.current = false;
      savedFingerprintRef.current = fingerprint;
      return;
    }
    if (savedFingerprintRef.current === fingerprint) return;
    setAutoSaveStatus((status) => (status.state === 'saving' ? status : { state: 'pending' }));
    const timer = window.setTimeout(() => {
      if (savingRef.current) {
        window.setTimeout(() => setAutoSaveRetry((count) => count + 1), AUTO_SAVE_BUSY_POLL_MS);
        return;
      }
      void saveToLibrary(fingerprint);
    }, AUTO_SAVE_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, fingerprint, autoSaveRetry]);

  useEffect(() => () => window.clearTimeout(retryTimer.current), []);
  useEffect(() => () => revokeRenderedSlides(previewRef.current), []);

  // ---- 찬양 step callbacks ----
  const handleSongsChange = useCallback((next: Song[]) => {
    setSongs(next);
    setOverview(null);
  }, []);
  const handleDateDetected = useCallback((detected: string | undefined) => {
    const iso = isoDateFromConti(detected);
    if (iso) setDate((current) => current || iso);
  }, []);
  const showSongsStep = useCallback(() => setStep(0), []);

  // ---- downloads ----
  const downloadDeck = async () => {
    if (songs.length === 0 && additionalFiles.length === 0) {
      showToast('찬양이나 추가 자료를 먼저 넣어 주세요.', 'error');
      return;
    }
    setGenerating(true);
    try {
      const result = await build();
      setOverview(result.overview);
      setWarnings(result.warnings);
      downloadBytes(result.deck, fileName);
      for (const warning of result.warnings) showToast(warning, 'warn');
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'PPT를 만들지 못했습니다.', 'error');
    } finally {
      setGenerating(false);
    }
  };

  const renderPreview = async () => {
    setGenerating(true);
    try {
      const result = await build();
      setOverview(result.overview);
      setWarnings(result.warnings);
      const slides = await renderPptxSlides(result.deck);
      revokeRenderedSlides(previewRef.current);
      previewRef.current = slides;
      setPreview(slides);
    } catch (error) {
      showToast(error instanceof Error ? error.message : '미리보기를 만들지 못했습니다.', 'error');
    } finally {
      setGenerating(false);
    }
  };

  const startOver = () => {
    if (!window.confirm('지금 입력을 모두 비우고 새 찬양집회를 시작할까요? 저장된 PPT는 라이브러리에 그대로 남습니다.')) return;
    writeLastDeck(null);
    autoSaveTargetRef.current = null;
    savedFingerprintRef.current = null;
    setDate('');
    setExtras({});
    setAdditionalFiles([]);
    setPlacements([]);
    setCoverImage(null);
    setFileNameOverride(null);
    setContiFile(null);
    setOverview(null);
    setSongs([]);
    setRestore((previous) => ({ version: previous.version + 1, songs: [], conti: null }));
    setAutoSaveStatus({ state: 'idle' });
    setStep(0);
  };

  async function pickCover(file: File | undefined) {
    if (!file) return;
    const mimeType = file.type === 'image/png' ? 'image/png' : file.type === 'image/jpeg' ? 'image/jpeg' : null;
    if (!mimeType) {
      showToast('표지는 PNG나 JPG 이미지만 쓸 수 있습니다.', 'error');
      return;
    }
    setCoverImage({ name: file.name, mimeType, data: await file.arrayBuffer() });
  }

  const plans = planPraiseDeck(
    songs,
    extras,
    placements.filter((item) => additionalFiles.some((file) => file.id === item.fileId)),
  );
  const additionalSlides = additionalFiles.reduce((sum, file) => sum + file.slideCount, 0);
  const slideCount = plans.filter((plan) => plan.kind !== 'additional').length + additionalSlides;
  const missingEnglish = songs.reduce((sum, song) => sum + missingEnglishCount(song, extrasFor(extras, song.id)), 0);
  const prayerCount = plans.filter((plan) => plan.kind === 'prayer').length;

  const placementFor = (fileId: string): AdditionalPlacement =>
    placements.find((item) => item.fileId === fileId)?.placement ?? 'end';
  const setPlacement = (fileId: string, placement: AdditionalPlacement) =>
    setPlacements((current) => [...current.filter((item) => item.fileId !== fileId), { fileId, placement }]);

  const stepNav = (index: number) => (
    <nav className="wizard-nav" aria-label="단계 이동">
      {index > 0 ? (
        <button type="button" className="btn" onClick={() => setStep(index - 1)}>
          <Icon name="back" />
          이전
        </button>
      ) : (
        <span />
      )}
      {index < STEPS.length - 1 && (
        <button
          type="button"
          className="btn btn-primary"
          data-testid={`praise-next-${STEPS[index].id}`}
          onClick={() => setStep(index + 1)}
        >
          다음: {STEPS[index + 1].label}
          <Icon name="next" />
        </button>
      )}
    </nav>
  );

  return (
    <>
      <a className="skip-link" href="#main-content">
        본문으로 건너뛰기
      </a>
      <header className="header">
        <div className="header-inner">
          <div className="header-brand">
            <img className="header-logo" src={`${BASE}logo.png`} alt="KCCP 빛주사랑 대학청년부 Media Team 로고" />
            <div className="header-text">
              <h1>찬양집회 PPT Generator</h1>
              <p>콘티를 올리면 한글·영어 제목과 가사가 함께 들어간 찬양집회 PPT를 만들어 드립니다.</p>
            </div>
          </div>
          <nav className="header-actions" aria-label="도구">
            <a className="btn" href={`${BASE}index.html`} data-testid="praise-to-home">
              <Icon name="steps" />
              <span className="btn-label">예배 선택</span>
            </a>
            <button
              type="button"
              className="btn library-open"
              data-testid="praise-library-open"
              onClick={() => setLibraryOpen(true)}
            >
              <Icon name="library" />
              <span className="btn-label">라이브러리</span>
            </button>
          </nav>
        </div>
      </header>

      {libraryOpen && <PptLibraryPanel onClose={() => setLibraryOpen(false)} onEdit={openFromLibrary} />}

      <div className="app">
        <ol
          className="wizard-progress"
          aria-label="찬양집회 PPT 생성 단계"
          style={{ '--active-index': step } as React.CSSProperties}
        >
          {STEPS.map((item, index) => (
            <li
              key={item.id}
              className={`wizard-step${index === step ? ' current' : ''}${index < step ? ' complete' : ''}`}
            >
              <button
                type="button"
                className="wizard-step-button"
                data-testid={`praise-tab-${item.id}`}
                aria-current={index === step ? 'step' : undefined}
                onClick={() => setStep(index)}
              >
                <span className="wizard-step-dot">{index < step ? <Icon name="check" /> : index + 1}</span>
                <span className="wizard-step-label">{item.label}</span>
              </button>
            </li>
          ))}
        </ol>

        <div className="app-body">
          <main id="main-content">
            <section
              className={`wizard-panel${step === 0 ? ' active' : ''}`}
              aria-hidden={step !== 0}
              data-testid="praise-panel-songs"
            >
              <div className="wizard-page-header">
                <p className="wizard-kicker">1 / 4</p>
                <h2>찬양</h2>
                <p>찬양집회 콘티를 올리고 각 곡의 한글 가사와 순서를 확인하세요. 주일예배와 같은 방법으로 읽습니다.</p>
              </div>
              <LyricsGenerator
                service="praise"
                onSongsChange={handleSongsChange}
                onDateDetected={handleDateDetected}
                onContiFileLoaded={setContiFile}
                restoreVersion={restore.version}
                restoreSongs={restore.songs}
                restoreConti={restore.conti}
                replaceSong={replaceSong}
                preferredSongs={preferredSongs}
                onContiDropAnywhere={showSongsStep}
              />
              {stepNav(0)}
            </section>

            <section
              className={`wizard-panel${step === 1 ? ' active' : ''}`}
              aria-hidden={step !== 1}
              data-testid="praise-panel-english"
            >
              <div className="wizard-page-header">
                <p className="wizard-kicker">2 / 4</p>
                <h2>영어 가사</h2>
                <p>
                  한글 슬라이드마다 아래에 들어갈 영어 가사입니다. 작년 찬양집회에서 부른 곡과 저장한 곡은 자동으로
                  채워지고, 여기서 넣은 영어는 한글 가사와 함께 자동으로 저장됩니다.
                </p>
              </div>
              {songs.length > 0 && (
                <p className={`banner ${missingEnglish > 0 ? 'banner-warn' : 'banner-notice'}`} data-testid="praise-english-summary">
                  <Icon name={missingEnglish > 0 ? 'warning' : 'check'} />
                  <span className="banner-text">
                    {missingEnglish > 0
                      ? `영어 가사가 없는 한글 슬라이드가 ${missingEnglish}장 있습니다. 비워 두면 한글만 나옵니다.`
                      : '모든 한글 슬라이드에 영어 가사가 있습니다.'}
                  </span>
                </p>
              )}
              <PraiseEnglishStep
                songs={songs}
                extras={extras}
                library={englishLibrary}
                onExtrasChange={updateExtras}
                onLoadFromLibrary={loadSongFromLibrary}
                onSaveToLibrary={(song) => rememberEnglish([song])}
              />
              {stepNav(1)}
            </section>

            <section
              className={`wizard-panel${step === 2 ? ' active' : ''}`}
              aria-hidden={step !== 2}
              data-testid="praise-panel-additional"
            >
              <div className="wizard-page-header">
                <p className="wizard-kicker">3 / 4</p>
                <h2>추가 자료</h2>
                <p>설교 PPT, 말씀·기도제목 슬라이드 등을 올리고 어느 곡 뒤에 넣을지 고르세요. 없으면 건너뛰어도 됩니다.</p>
              </div>
              <AdditionalFilesSection value={additionalFiles} onChange={setAdditionalFiles} />
              {additionalFiles.length > 0 && (
                <section className="card praise-placements" data-testid="praise-placements">
                  <h3>넣을 위치</h3>
                  <ul>
                    {additionalFiles.map((file) => (
                      <li key={file.id}>
                        <span className="praise-placement-name">{file.name}</span>
                        <select
                          aria-label={`${file.name} 넣을 위치`}
                          value={placementValue(placementFor(file.id))}
                          data-testid="praise-placement-select"
                          onChange={(event) => setPlacement(file.id, placementFromValue(event.target.value))}
                        >
                          <option value="start">표지 바로 뒤</option>
                          {songs.map((song, index) => (
                            <option key={song.id} value={`song:${song.id}`}>
                              {index + 1}. {song.title || '(제목 없음)'} 뒤
                            </option>
                          ))}
                          <option value="end">맨 뒤</option>
                        </select>
                      </li>
                    ))}
                  </ul>
                  <p className="field-hint">
                    곡 뒤에 넣은 자료는 그 곡의 기도 슬라이드보다 앞에 들어갑니다 (예: 찬양 → 설교 → 기도).
                  </p>
                </section>
              )}
              {stepNav(2)}
            </section>

            <section
              className={`wizard-panel${step === 3 ? ' active' : ''}`}
              aria-hidden={step !== 3}
              data-testid="praise-panel-download"
            >
              <div className="wizard-page-header">
                <p className="wizard-kicker">4 / 4</p>
                <h2>표지 및 다운로드</h2>
                <p>찬양집회 PPT는 라이브러리에 자동 저장되고, 매주 자동 삭제에서 빠져 직접 지울 때까지 남습니다.</p>
              </div>

              <section className="card download-card">
                <div className="praise-cover-row">
                  <label className="field">
                    <span className="field-label">찬양집회 날짜</span>
                    <input
                      type="date"
                      value={date}
                      data-testid="praise-date"
                      onChange={(event) => setDate(event.target.value)}
                    />
                    <span className="field-hint">
                      {coverImage
                        ? '새 표지 이미지를 쓰므로 날짜는 표지에 따로 쓰지 않습니다.'
                        : `표지에 ${formatCoverDate(date) || 'MM/DD/YYYY'} 로 들어갑니다.`}
                    </span>
                  </label>
                  <div className="field">
                    <span className="field-label">표지 이미지</span>
                    <div className="praise-cover-actions">
                      <label className="btn">
                        <Icon name="upload" />
                        {coverImage ? '다른 이미지로 바꾸기' : '새 표지 이미지 올리기'}
                        <input
                          type="file"
                          accept="image/png,image/jpeg"
                          className="visually-hidden"
                          data-testid="praise-cover-input"
                          onChange={(event) => {
                            void pickCover(event.target.files?.[0]);
                            event.target.value = '';
                          }}
                        />
                      </label>
                      {coverImage && (
                        <button type="button" className="btn btn-ghost" onClick={() => setCoverImage(null)}>
                          작년 표지로 되돌리기
                        </button>
                      )}
                    </div>
                    <span className="field-hint">
                      {coverImage
                        ? `${coverImage.name}을(를) 표지로 씁니다.`
                        : '비워 두면 작년 EM&KM Praise Night 표지에 올해 날짜를 넣어 씁니다.'}
                    </span>
                  </div>
                </div>

                <label className="field">
                  <span className="field-label">파일명</span>
                  <input
                    type="text"
                    value={fileName}
                    data-testid="praise-file-name"
                    onChange={(event) => setFileNameOverride(event.target.value)}
                  />
                </label>

                <dl className="wednesday-summary" data-testid="praise-summary">
                  <div>
                    <dt>찬양</dt>
                    <dd>{songs.length}곡</dd>
                  </div>
                  <div>
                    <dt>영어 없는 슬라이드</dt>
                    <dd>{missingEnglish}장</dd>
                  </div>
                  <div>
                    <dt>기도 · 추가 자료</dt>
                    <dd>
                      기도 {prayerCount}장 · 자료 {additionalFiles.length}개
                    </dd>
                  </div>
                  <div>
                    <dt>전체 슬라이드</dt>
                    <dd data-testid="praise-slide-count">{slideCount}장</dd>
                  </div>
                </dl>

                {warnings.length > 0 && (
                  <ul className="wednesday-warnings">
                    {warnings.map((warning) => (
                      <li key={warning} className="banner banner-notice">
                        <Icon name="info" />
                        <span className="banner-text">{warning}</span>
                      </li>
                    ))}
                  </ul>
                )}

                <AutoSaveIndicator status={autoSaveStatus} testId="praise-auto-save-status" />

                <div className="download-actions">
                  <button
                    type="button"
                    className="btn btn-ghost"
                    data-testid="praise-reset"
                    onClick={startOver}
                  >
                    <Icon name="trash" />
                    새 찬양집회 시작
                  </button>
                  <button
                    type="button"
                    className="btn"
                    disabled={generating}
                    data-testid="praise-preview"
                    onClick={() => void renderPreview()}
                  >
                    <Icon name="slide" />
                    미리보기
                  </button>
                  <button
                    type="button"
                    className="btn btn-primary btn-download"
                    disabled={generating}
                    data-testid="praise-download"
                    onClick={() => void downloadDeck()}
                  >
                    <Icon name="download" />
                    {generating ? '만드는 중…' : '찬양집회 PPT 다운로드'}
                  </button>
                </div>
              </section>

              {preview && (
                <section className="card praise-preview" data-testid="praise-preview-grid">
                  <h3>미리보기 {preview.length}장</h3>
                  <ol>
                    {preview.map((slide, index) => (
                      <li key={index}>
                        <SlideThumbnail slide={slide} width={220} />
                        <span className="praise-preview-label">
                          {index + 1}. {overview?.[index]?.label ?? ''}
                        </span>
                      </li>
                    ))}
                  </ol>
                </section>
              )}

              {overview && !preview && (
                <section className="card wednesday-slide-list" data-testid="praise-slide-list">
                  <h3>만든 슬라이드 {overview.length}장</h3>
                  <ol>
                    {overview.map((item, index) => (
                      <li key={item.id} data-kind={item.kind}>
                        <span className="wednesday-slide-index">{index + 1}</span>
                        <Icon name={slideIcon(item.kind)} />
                        <span className="wednesday-slide-label">{item.label}</span>
                        {item.subtitle && <span className="wednesday-slide-subtitle">{item.subtitle}</span>}
                      </li>
                    ))}
                  </ol>
                </section>
              )}
              {stepNav(3)}
            </section>
          </main>
        </div>
      </div>
      <ToastHost />
    </>
  );
}
