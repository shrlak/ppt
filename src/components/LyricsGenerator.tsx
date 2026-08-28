import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ContiInfo, LibraryEntry, Song, VerificationState } from '../lib/utils/types';
import { loadConti, type ContiDocument } from '../lib/utils/contiPdf';
import { deriveSongsFromMusicPages, splitLyricsAndConfessionSongs } from '../lib/utils/contiText';
import {
  fetchBundledLibrary,
  findEntry,
  findReusableEntry,
  loadUserLibrary,
  mergeLibraries,
  normalizeTitle,
  queueLyricsDelete,
  queueLyricsUpsert,
  saveUserLibrary,
  synchronizeUserLibrary,
  upsertEntry,
} from '../lib/storage/library';
import { hasCloudLibrary } from '../lib/storage/cloudLibrary';
import SongCard, { type RecogState } from './SongCard';
import Modal from './Modal';
import LibraryManager from './LibraryManager';
import LibraryAddSearch from './LibraryAddSearch';
import { getSyncedAiSettings } from '../lib/ai/aiSettings';
import { applyScoreToSong, recognizeScoreRaced } from '../lib/ai/scoreRecognition';
import { recognizeAdaptiveBatch } from '../lib/ai/adaptiveRecognition';
import { fetchLearningMemory, fetchModelReliabilities } from '../lib/learning/learningClient';
import {
  applySafeCorrections,
  buildLearningMemory,
  promptExamplesFor,
  resolveTitleAlias,
  EMPTY_MEMORY,
  type LearningMemory,
} from '../lib/learning/onlineLearning';
import { ERROR_CATEGORY_LABELS } from '../lib/ai/recognitionObservation';
import type { RecognitionObservation } from '../lib/ai/recognitionObservation';
import { hashPageImage, hashText } from '../lib/ai/pageHash';
import { scoreObservation } from '../lib/ai/modelReliability';
import {
  canonicalScore,
  diffFeedback,
  feedbackCandidate,
  verificationFor,
  type FeedbackDiff,
} from '../lib/learning/feedbackDiff';
import { flushFeedbackQueue, queueFeedback } from '../lib/learning/feedbackQueue';
import { dataUrlToBytes, resizeTrainingImage } from '../lib/learning/trainingCorpus';
import { loadActiveCorrectionRunner, uploadTrainingRecord } from '../lib/learning/learningClient';
import { correctConsensus } from '../lib/learning/correctionModel';
import type { ParsedScore } from '../lib/ai/scoreParser';
import { fetchWebLyrics, hasWebLyricsLookup, lyricSample } from '../lib/lyrics/webLyrics';
import { mergeRankedWebLyrics, mergeWebLyrics, type WebReviewState } from '../lib/lyrics/mergeWebLyrics';
import { sameLyrics } from '../lib/lyrics/textSimilarity';
import { planScoreBatch } from '../lib/ai/scoreBatchPlan';
import { recognitionProgress, type RecognitionPhase } from '../lib/ai/recognitionProgress';
import { isExcludedTitle } from '../lib/utils/excludedTitles';
import { showToast } from '../lib/utils/toast';
import { dragCarriesFiles, readContiDrop } from '../lib/utils/fileDrop';
import Icon from './Icon';

const BASE: string = import.meta.env.BASE_URL || '/';

/**
 * Width (CSS px) score pages are rendered at for recognition. Higher than the
 * on-screen preview so the models can read small lyric type under the staves.
 */
const RECOGNITION_RENDER_WIDTH = 1600;

/**
 * The per-page rescue pass re-renders its page even larger: a page the batch
 * pass failed to read is usually one with small or dense type, and a single
 * image per request leaves plenty of payload headroom.
 */
const RESCUE_RENDER_WIDTH = 2200;

/** How often the recognition progress percentage refreshes on screen. */
const PROGRESS_TICK_MS = 400;

function songHasLyrics(song: Song): boolean {
  return song.sections.some((s) => s.lines.some((l) => l.trim().length > 0));
}

/**
 * What recognition produced, before the user touched it.
 *
 * Kept on the song so an explicit save can diff the final wording against the
 * machine's own answer: that diff is what tells 'verified' apart from
 * 'edited', and it is what each model's accuracy is measured from.
 */
/** One page's recognition evidence, held until the user decides about it. */
interface PageEvidence {
  pageHash?: string;
  /** The rendered page, for pairing a verified correction with its image. */
  image?: string;
  observations: RecognitionObservation[];
  confidence: number;
  needsReview: boolean;
}

function recognitionBaseline(score: ParsedScore): NonNullable<Song['provenance']>['baseline'] {
  return {
    title: score.title,
    artist: score.artist,
    key: score.key,
    sections: structuredClone(score.sections),
    order: [...score.order],
  };
}

/** Vision engines may identify a non-score page explicitly or by returning
 * sermon metadata with no song identity. Either form must stay out of lyrics. */
function isNonScoreRecognition(score: ParsedScore): boolean {
  if (score.pageType === 'score') return false;
  return (
    score.pageType === 'non_score' ||
    ((!score.title || !score.title.trim()) && !!(score.sermonTitle?.trim() || score.scripture?.trim()))
  );
}

function songFromLibrary(entry: LibraryEntry, pageIndex?: number): Song {
  return {
    id: crypto.randomUUID(),
    title: entry.title,
    key: entry.key,
    sections: structuredClone(entry.sections),
    order: [...entry.order],
    linesPerSlide: 4,
    pageIndex,
  };
}

function blankSong(title = ''): Song {
  return {
    id: crypto.randomUUID(),
    title,
    sections: [],
    order: ['I'],
    linesPerSlide: 4,
  };
}

interface Props {
  /** Fired whenever the song list changes, so the parent can build the combined deck. */
  onSongsChange: (songs: Song[]) => void;
  /** Fired once the conti cover date is known, so the parent can suggest a file name. */
  onDateDetected?: (date: string | undefined) => void;
  /** Supplies the sermon title/scripture to the Bible section for automatic filling. */
  onContiInfoDetected?: (info: ContiInfo) => void;
  /** Fired with the raw uploaded conti PDF, so it can be archived alongside a saved deck. */
  onContiFileLoaded?: (file: { name: string; data: ArrayBuffer }) => void;
  /** Bumped when a 라이브러리 deck is reopened, to load its songs back in. */
  restoreVersion?: number;
  /** Songs saved with that deck; they replace the current list as-is. */
  restoreSongs?: Song[] | null;
  /** Its archived 콘티 PDF, re-parsed when the entry predates saved songs. */
  restoreConti?: { name: string; data: ArrayBuffer } | null;
  /**
   * Fired when a 콘티 was dropped somewhere outside this step, so the parent can
   * bring the 찬양 step into view — the upload it just started happens here.
   */
  onContiDropAnywhere?: () => void;
}

export default function LyricsGenerator({
  onSongsChange,
  onDateDetected,
  onContiInfoDetected,
  onContiFileLoaded,
  restoreVersion = 0,
  restoreSongs = null,
  restoreConti = null,
  onContiDropAnywhere,
}: Props) {
  const [library, setLibrary] = useState<LibraryEntry[]>([]);
  const [librarySync, setLibrarySync] = useState<'syncing' | 'synced' | 'local' | 'error'>(
    hasCloudLibrary() ? 'syncing' : 'local',
  );
  const [info, setInfo] = useState<ContiInfo | null>(null);
  const infoRef = useRef<ContiInfo | null>(null);
  const [songs, setSongs] = useState<Song[]>([]);
  const [pageImages, setPageImages] = useState<Record<number, string>>({});
  const [parsing, setParsing] = useState(false);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [recog, setRecog] = useState<Record<string, RecogState>>({});
  /**
   * Web candidates a song is still waiting on a decision about.
   *
   * Held apart from the song itself: nothing here has been applied, and the
   * song must stay exactly as the models read it until the user picks.
   */
  const [webReview, setWebReview] = useState<Record<string, WebReviewState>>({});
  // The consensus reading each pending review would be merged into.
  const webBaselineRef = useRef<Record<string, ParsedScore>>({});
  // Latest review state, for callbacks that must stay referentially stable.
  const webReviewRef = useRef<Record<string, WebReviewState>>({});
  /**
   * What recognition learned about each song: the page it read, every model's
   * answer, and how settled the consensus was.
   *
   * Kept until the user explicitly saves. An automatic save is a draft and
   * proves nothing, so evidence only becomes training data when somebody
   * stands behind the result.
   */
  const evidenceRef = useRef<Map<string, PageEvidence>>(new Map());
  // Latest learning memory, for the rescue path that runs after the main flow.
  const memoryRef = useRef<LearningMemory>(EMPTY_MEMORY);
  // Song being edited in the split-screen conti view (null = closed).
  const [zoomSongId, setZoomSongId] = useState<string | null>(null);
  const [edited, setEdited] = useState(false);
  const docRef = useRef<ContiDocument | null>(null);
  const autoAttemptedRef = useRef<Set<string>>(new Set());
  const pendingAutoSaveRef = useRef<Set<string>>(new Set());
  // Songs whose scan result should be discarded (library lyrics arrived first).
  const scanCancelledRef = useRef<Set<string>>(new Set());
  const libraryPromiseRef = useRef<Promise<LibraryEntry[]> | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  // A file is being dragged over the window, anywhere — not just the dropzone.
  const [fileDragOverWindow, setFileDragOverWindow] = useState(false);
  // Latest library, for use inside callbacks that must stay referentially stable.
  const libraryRef = useRef<LibraryEntry[]>([]);
  useEffect(() => {
    libraryRef.current = library;
  }, [library]);
  useEffect(() => {
    webReviewRef.current = webReview;
  }, [webReview]);
  // Mirror of pageImages for async loops that must see the latest cache.
  const pageImagesRef = useRef<Record<number, string>>({});
  useEffect(() => {
    pageImagesRef.current = pageImages;
  }, [pageImages]);

  /** Merge metadata found on scanned non-score pages without replacing the
   * cover's existing values, then re-send the complete info to the Bible step. */
  const mergeDetectedContiInfo = useCallback(
    (detected: Pick<ParsedScore, 'sermonTitle' | 'scripture'>) => {
      const sermonTitle = detected.sermonTitle?.trim();
      const scripture = detected.scripture?.trim();
      if (!sermonTitle && !scripture) return;

      const current = infoRef.current ?? { songs: [] };
      const next: ContiInfo = {
        ...current,
        sermonTitle: current.sermonTitle || sermonTitle,
        scripture: current.scripture || scripture,
      };
      infoRef.current = next;
      setInfo(next);
      onContiInfoDetected?.(next);
    },
    [onContiInfoDetected],
  );

  const zoomSong = zoomSongId != null ? (songs.find((s) => s.id === zoomSongId) ?? null) : null;

  // The split view shows the whole conti: render any pages (cover included)
  // that the background music-page pass hasn't produced yet.
  useEffect(() => {
    if (zoomSongId == null) return;
    const doc = docRef.current;
    if (!doc) return;
    let cancelled = false;
    void (async () => {
      for (let page = 1; page <= doc.parsed.numPages; page++) {
        if (cancelled) return;
        if (pageImagesRef.current[page]) continue;
        try {
          const url = await doc.renderPage(page, 900);
          if (!cancelled) setPageImages((imgs) => ({ ...imgs, [page]: url }));
        } catch {
          // page preview is best-effort
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [zoomSongId]);

  // Jump the left pane to the page whose thumbnail was clicked.
  useEffect(() => {
    if (zoomSongId == null) return;
    const page = songs.find((s) => s.id === zoomSongId)?.pageIndex;
    if (page == null) return;
    const frame = requestAnimationFrame(() => {
      document.getElementById(`split-page-${page}`)?.scrollIntoView({ block: 'start' });
    });
    return () => cancelAnimationFrame(frame);
    // Only on open — later song edits must not yank the scroll position back.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zoomSongId]);

  const refreshLibrary = useCallback(async () => {
    const [bundled, synchronized] = await Promise.all([
      fetchBundledLibrary(BASE),
      synchronizeUserLibrary(),
    ]);
    const merged = mergeLibraries(bundled, synchronized.entries);
    libraryRef.current = merged;
    setLibrary(merged);
    setLibrarySync(synchronized.synced ? 'synced' : synchronized.error ? 'error' : 'local');
    return merged;
  }, []);

  useEffect(() => {
    libraryPromiseRef.current = refreshLibrary();
    const refreshOnFocus = () => {
      if (document.visibilityState === 'hidden') return;
      libraryPromiseRef.current = refreshLibrary();
      // Queued corrections retry on the same signal the library sync uses, so
      // a save made offline reaches the proxy the next time the tab is used.
      void flushFeedbackQueue().catch(() => undefined);
    };
    window.addEventListener('focus', refreshOnFocus);
    document.addEventListener('visibilitychange', refreshOnFocus);
    return () => {
      window.removeEventListener('focus', refreshOnFocus);
      document.removeEventListener('visibilitychange', refreshOnFocus);
      docRef.current?.destroy();
    };
  }, [refreshLibrary]);

  /**
   * Write a song to the library at a given trust level.
   *
   * A draft is what automatic recognition produces; it is stored so the song
   * is not lost, but upsertEntry refuses to let it replace an entry somebody
   * already confirmed. Only an explicit save passes 'verified' or 'edited'.
   */
  const saveToLibrary = useCallback((song: Song, verification: VerificationState = 'draft') => {
    if (!song.title.trim()) return;
    const previous = findEntry(libraryRef.current, song.title);
    const entry: LibraryEntry = {
      title: song.title.trim(),
      artist: song.artist,
      key: song.key,
      sections: structuredClone(song.sections),
      order: [...song.order],
      verification,
      version: (previous?.version ?? 0) + 1,
      updatedAt: new Date().toISOString(),
      ...(song.provenance
        ? {
            provenance: {
              pageHash: song.provenance.pageHash,
              source: song.provenance.source,
              webSourceUrl: song.provenance.webSourceUrl,
              confidence: song.provenance.confidence,
              correctionModelVersion: song.provenance.correctionModelVersion,
            },
          }
        : {}),
    };
    const user = upsertEntry(loadUserLibrary(), entry);
    saveUserLibrary(user);
    queueLyricsUpsert(entry);
    setLibrary((lib) => {
      const next = upsertEntry(lib, entry);
      libraryRef.current = next;
      return next;
    });
    return entry;
  }, []);

  // Auto-save only after React has committed the recognized lyrics. Keeping
  // this side effect outside a state updater also makes it safe in Strict Mode.
  useEffect(() => {
    if (pendingAutoSaveRef.current.size === 0) return;
    for (const id of [...pendingAutoSaveRef.current]) {
      const song = songs.find((candidate) => candidate.id === id);
      if (!song) {
        pendingAutoSaveRef.current.delete(id);
        continue;
      }
      if (
        song.title.trim() &&
        !/^새 찬양/.test(song.title) &&
        songHasLyrics(song) &&
        !findEntry(libraryRef.current, song.title)
      ) {
        // Automatic recognition produces a DRAFT. Nobody has looked at it, so
        // it must not become the ground truth a later conti reuses, nor count
        // as evidence that any model read the page correctly.
        saveToLibrary(song, 'draft');
        showToast(`'${song.title}' 을(를) 초안으로 저장했습니다.`);
      }
      pendingAutoSaveRef.current.delete(id);
    }
  }, [songs, saveToLibrary]);

  /**
   * Drop a song whose recognized title is on the administrator-managed
   * exclusion list (공동체 고백송, 예배 전 준비 찬양 등). Returns true when
   * the song was removed, so callers stop processing it.
   */
  const excludeRecognizedSong = useCallback((song: Song, title: string, excludedTitles: string[]) => {
    if (!isExcludedTitle(title, excludedTitles)) return false;
    scanCancelledRef.current.add(song.id);
    autoAttemptedRef.current.add(song.id);
    setSongs((list) => list.filter((s) => s.id !== song.id));
    setRecog((r) => {
      const { [song.id]: _dropped, ...rest } = r;
      return rest;
    });
    showToast(`'${title}'은(는) 제외 목록에 있어 찬양 편집에서 제외했습니다.`);
    return true;
  }, []);

  /**
   * Fill a lyric-less song from the library when its title is already known
   * there, and stop any scan that is still running for it — the saved lyrics
   * are authoritative, so scanning the score would be wasted work.
   */
  const fillFromLibrary = useCallback((song: Song, entry: LibraryEntry, message?: string) => {
    scanCancelledRef.current.add(song.id);
    autoAttemptedRef.current.add(song.id);
    setSongs((list) =>
      list.map((s) =>
        s.id === song.id
          ? {
              ...s,
              title: entry.title,
              key: s.key ?? entry.key,
              sections: structuredClone(entry.sections),
              order: [...entry.order],
            }
          : s,
      ),
    );
    setRecog((r) =>
      r[song.id] ? { ...r, [song.id]: { status: 'done', engine: 'library' } } : r,
    );
    showToast(message ?? `라이브러리에서 '${entry.title}' 가사를 불러왔습니다.`);
  }, []);

  /** Remove an AI-classified non-score page from the song editor and forward
   * any sermon metadata found there to the Bible step. */
  const discardNonScorePage = useCallback(
    (song: Song, result: ParsedScore) => {
      if (!isNonScoreRecognition(result)) return false;
      scanCancelledRef.current.add(song.id);
      autoAttemptedRef.current.add(song.id);
      setSongs((list) => list.filter((candidate) => candidate.id !== song.id));
      setRecog((current) => {
        const { [song.id]: _discarded, ...rest } = current;
        return rest;
      });
      mergeDetectedContiInfo(result);
      return true;
    },
    [mergeDetectedContiInfo],
  );

  /**
   * Recognize every supplied score as one staged job with a live percentage:
   * 1) render the score pages (real per-page progress);
   * 2) one title-only request for all pages; a page whose settled title is
   *    already in the library ends here with the saved lyrics (best-effort —
   *    a failure here just skips early library matching);
   * 3) one full-lyrics request containing only the pages the library could not
   *    answer;
   * 4) rescue pass — any page the batch answer left without lyrics is retried
   *    individually, so one bad page can't blank out the whole conti.
   */
  const recognizeSongsBatch = useCallback(
    async (targets: Song[]) => {
      const doc = docRef.current;
      const active = targets.filter((song) => song.pageIndex != null);
      if (!doc || active.length === 0) return;

      const isCancelled = (id: string) => scanCancelledRef.current.has(id);

      // One ticker drives every card in the batch. The interval only fires
      // between awaits, and each stage transition updates `tracked` in the
      // same synchronous block that resolves cards, so a card marked done or
      // errored is never flipped back to running by a late tick.
      const tracked = { ids: active.map((song) => song.id), phase: 'render' as RecognitionPhase, startedAt: Date.now(), realFraction: 0 };
      const applyProgress = () => {
        const value = recognitionProgress(tracked.phase, Date.now() - tracked.startedAt, tracked.realFraction);
        setRecog((current) => {
          const next = { ...current };
          for (const id of tracked.ids) {
            // A card resolved mid-stage (library hit or rescue finish) stays
            // done — the tick must not flip it back to running.
            if (!isCancelled(id) && !resolvedIds.has(id)) {
              next[id] = { status: 'running', phase: tracked.phase, progress: value };
            }
          }
          return next;
        });
      };
      const enterPhase = (phase: RecognitionPhase, ids: string[]) => {
        tracked.phase = phase;
        tracked.ids = ids;
        tracked.startedAt = Date.now();
        tracked.realFraction = 0;
        applyProgress();
      };
      const ticker = window.setInterval(applyProgress, PROGRESS_TICK_MS);

      const resolvedIds = new Set<string>();
      /** Pages the models did not settle on, so the card can say so. */
      let reviewFlags = new Map<string, boolean>();
      const markDone = (ids: string[], engine: string) => {
        for (const id of ids) resolvedIds.add(id);
        setRecog((current) => {
          const next = { ...current };
          for (const id of ids) {
            if (!isCancelled(id)) {
              next[id] = { status: 'done', engine, needsReview: reviewFlags.get(id) || undefined };
            }
          }
          return next;
        });
      };

      /**
       * Songs the models read off the 악보 that are new to the library, with
       * the engine that read them. They are shown immediately but held back
       * from "done" and from auto-save until the web pass below has had its
       * turn — otherwise the library would keep the uncorrected OCR wording.
       */
      const webQueue = new Map<string, { score: ParsedScore; engine: string; title: string }>();

      // Everything recognition learns about each song is kept on the component
      // (see evidenceRef): an explicit save happens long after this function
      // has returned, and that save is the only thing that turns evidence into
      // training data.
      const evidence = evidenceRef.current;

      /** Commit a finished song: write the lyrics, allow auto-save, mark done. */
      const applyRecognizedScore = (
        id: string,
        score: ParsedScore,
        engine: string,
        provenance?: Partial<NonNullable<Song['provenance']>>,
      ) => {
        pendingAutoSaveRef.current.add(id);
        const found = evidence.get(id);
        setSongs((current) =>
          current.map((song) => {
            if (song.id !== id || isCancelled(id)) return song;
            const next = applyScoreToSong(song, score);
            return {
              ...next,
              // A machine answer is a draft until somebody stands behind it.
              verification: 'draft',
              provenance: {
                ...song.provenance,
                pageHash: found?.pageHash,
                baseline: song.provenance?.baseline ?? recognitionBaseline(score),
                source: 'models',
                confidence: found?.confidence,
                ...provenance,
              },
            };
          }),
        );
        markDone([id], engine);
      };

      /**
       * Last stage: look each new song's published lyrics up on the web and
       * reconcile them with the score (see mergeWebLyrics — the score keeps
       * the part labels and 진행 순서, the web supplies the wording). Songs
       * that came from the library never get here, so a saved song is never
       * rewritten. A line taken from the page goes in exactly as published;
       * only the score's own reading is normalized to 한국어 띄어쓰기·맞춤법,
       * and a failed lookup simply leaves that normalized reading in place.
       */
      const runWebLyricsPass = async () => {
        const pending = [...webQueue.entries()].filter(([id]) => !isCancelled(id));
        if (pending.length === 0) return;

        if (!hasWebLyricsLookup()) {
          for (const [id, { score, engine }] of pending) {
            applyRecognizedScore(id, mergeWebLyrics(score, null).score, engine);
          }
          return;
        }

        enterPhase('web', pending.map(([id]) => id));
        await Promise.all(
          pending.map(async ([id, { score, engine, title }]) => {
            // What the models read is sent as matching evidence, so a page
            // that merely shares this title cannot be mistaken for this song.
            const lookup = title
              ? await fetchWebLyrics({ title, sample: lyricSample(score.sections) })
              : { candidates: [], links: [] };
            if (isCancelled(id)) return;
            const auto = lookup.candidates.find((candidate) => candidate.decision === 'auto') ?? null;
            const review = lookup.candidates.filter((candidate) => candidate.decision === 'review');

            // Several plausible pages: the song stays exactly as the models
            // read it, editable, and out of auto-save until the user chooses.
            if (!auto && review.length > 0) {
              webBaselineRef.current[id] = score;
              setWebReview((current) => ({
                ...current,
                [id]: { candidates: review, decision: 'review', links: lookup.links },
              }));
              const normalized = mergeWebLyrics(score, null);
              setSongs((current) =>
                current.map((song) =>
                  song.id === id && !isCancelled(id)
                    ? {
                        ...applyScoreToSong(song, normalized.score),
                        verification: 'draft',
                        provenance: {
                          ...song.provenance,
                          pageHash: evidence.get(id)?.pageHash,
                          baseline: song.provenance?.baseline ?? recognitionBaseline(score),
                          source: 'models',
                          confidence: evidence.get(id)?.confidence,
                        },
                      }
                    : song,
                ),
              );
              markDone([id], engine);
              return;
            }

            const merged = mergeRankedWebLyrics(score, auto);
            applyRecognizedScore(id, merged.score, engine, {
              source: auto ? 'web' : 'models',
              webSourceUrl: auto?.sourceUrl,
            });
            if (auto && merged.outcome !== 'unused') {
              showToast(
                merged.outcome === 'filled'
                  ? `'${title}' 가사를 ${auto.sourceHost}에서 가져왔습니다.`
                  : `'${title}' 가사를 ${auto.sourceHost}와 대조해 ${merged.correctedParts}개 파트를 고쳤습니다.`,
              );
            }
          }),
        );
      };

      enterPhase('render', tracked.ids);

      /** Models whose free daily allowance ran out during this conti. */
      const exhausted = new Set<string>();

      try {
        // Rendering and recognition are both batched: no per-song request loop.
        let renderedPages = 0;
        const images = await Promise.all(
          active.map(async (song) => {
            // PNG: lossless line art reads far better than JPEG for OCR.
            const url = await doc.renderPage(song.pageIndex as number, RECOGNITION_RENDER_WIDTH, 'png');
            renderedPages += 1;
            tracked.realFraction = renderedPages / active.length;
            return url;
          }),
        );
        // Shared settings: concurrent model pool and the
        // excluded-title list, synced across every device via the proxy.
        const settings = await getSyncedAiSettings();
        // Measured accuracy decides which models read every page and how much
        // each answer counts. No proxy, or a failed lookup, just means the
        // catalog's own roles are used.
        const reliabilities = await fetchModelReliabilities();
        // What the app already learned to fix. Aliases redirect a title the
        // models keep misreading to the saved song; examples warn them off
        // repeating a correction the user already made.
        const memory = await fetchLearningMemory();
        memoryRef.current = memory;
        // The hand-trained corrector, when this deployment has one. Loading it
        // is what pulls in the inference runtime, so a deployment without an
        // artifact never downloads it.
        const corrector = await loadActiveCorrectionRunner();
        // Page hashes tie this run's evidence to the page it came from, so a
        // correction saved next week still knows which reading it corrected.
        const pageHashes = await Promise.all(
          images.map((image) => hashPageImage(image).catch(() => undefined)),
        );
        active.forEach((song, index) => {
          evidence.set(song.id, {
            pageHash: pageHashes[index],
            // Kept so an explicit save can pair the correction with the page
            // it corrected. Recognition renders these anyway; storing the
            // reference costs nothing until somebody verifies the song.
            image: images[index],
            observations: [],
            confidence: 0,
            needsReview: true,
          });
        });
        // Quick title pass. Best-effort: on failure the full pass still runs,
        // it just can't resolve library songs early.
        enterPhase('titles', tracked.ids);
        let titleScores: ParsedScore[] = active.map(() => ({ order: [], sections: [] }));
        // How much of the models' weight agreed on each title. It is what
        // decides whether the library may answer a page outright, so a title
        // pass that never ran leaves every page at zero — unsettled.
        let titleConfidence: number[] = active.map(() => 0);
        try {
          const titleResult = await recognizeAdaptiveBatch(
            images,
            settings,
            'titles',
            undefined,
            reliabilities,
            undefined,
            promptExamplesFor({}, memory),
          );
          titleScores = titleResult.scores;
          titleConfidence = titleResult.titleConfidence;
          for (const modelKey of titleResult.exhaustedModels) exhausted.add(modelKey);
        } catch (error) {
          console.warn('제목 일괄 인식 실패, 전체 가사 인식으로 계속:', error instanceof Error ? error.message : error);
        }

        // A title the models are known to misread is resolved BEFORE the
        // library and the web are searched, so a page whose title never comes
        // back right still finds its saved lyrics.
        const aliasedTitles = titleScores.map((identity) =>
          identity.title ? { ...identity, title: resolveTitleAlias(identity.title, memory) } : identity,
        );
        const unmatched: { song: Song; image: string; identity: ParsedScore }[] = [];
        const identityById = new Map<string, ParsedScore>();
        // The saved entry a page might turn out to be, where the title behind
        // the match was NOT settled — models reading different titles, mostly.
        // Those are held until the lyrics pass has read the page, because on a
        // shaky title a matching name is not evidence that the page carries
        // those lyrics.
        const libraryCandidates = new Map<string, LibraryEntry>();
        const titlePlan = planScoreBatch(
          aliasedTitles,
          active.map((song) => song.title),
          libraryRef.current,
          titleConfidence,
        );

        active.forEach((song, index) => {
          if (isCancelled(song.id)) return;
          const identity = aliasedTitles[index] ?? { order: [], sections: [] };
          if (discardNonScorePage(song, identity)) {
            resolvedIds.add(song.id);
            return;
          }
          const recognizedTitle = identity.title?.trim();
          if (recognizedTitle && excludeRecognizedSong(song, recognizedTitle, settings.excludedTitles)) {
            resolvedIds.add(song.id);
            return;
          }
          const candidate = titlePlan.libraryCandidates[index];
          if (candidate) libraryCandidates.set(song.id, candidate);
          // A song that already has lyrics has them from the user or from a
          // restored deck — both are authoritative, so the page is classified
          // but never read again.
          if (songHasLyrics(song)) {
            markDone([song.id], 'library');
            return;
          }
          // The library already holds this exact title and the title is
          // settled: stop here and load the saved lyrics. Reading the 악보
          // would spend a request to learn what is already saved, and the
          // saved copy is the wording somebody confirmed.
          const match = titlePlan.libraryMatches[index];
          if (match) {
            resolvedIds.add(song.id);
            fillFromLibrary(
              song,
              match,
              `'${match.title}'은(는) 라이브러리에 있어 가사 인식을 건너뛰고 불러왔습니다.`,
            );
            return;
          }
          identityById.set(song.id, identity);
          unmatched.push({ song, image: images[index], identity });
        });

        // Show the recognized title/key while the remaining pages move into the
        // full lyric pass. applyScoreToSong preserves anything the user edited.
        if (identityById.size > 0) {
          setSongs((current) =>
            current.map((song) => {
              const identity = identityById.get(song.id);
              return identity && !isCancelled(song.id) ? applyScoreToSong(song, identity) : song;
            }),
          );
        }

        const remaining = unmatched.filter(({ song }) => !isCancelled(song.id));
        if (remaining.length === 0) return;

        // Full-lyrics pass for every unmatched page in one request. If the
        // whole batch fails (payload too large, every engine down for batch
        // requests), the rescue pass below still tries each page separately.
        enterPhase('lyrics', remaining.map(({ song }) => song.id));
        // Title hints: the conti cover's title is ground truth when present;
        // otherwise reuse what the quick title pass read.
        const hintFor = ({ song, identity }: { song: Song; identity: ParsedScore }) => {
          const coverTitle = song.title.trim();
          if (coverTitle && !/^새 찬양/.test(coverTitle)) return coverTitle;
          return identity.title?.trim() || undefined;
        };
        let lyricScores: ParsedScore[] | null = null;
        let lyricEngine = '';
        try {
          // Three champions read every page; only a page they disagreed on is
          // escalated to a challenger, one at a time and one page at a time.
          const lyricResult = await recognizeAdaptiveBatch(
            remaining.map(({ image }) => image),
            settings,
            'full',
            remaining.map(hintFor),
            reliabilities,
            undefined,
            promptExamplesFor(
              {
                title: remaining[0] ? hintFor(remaining[0]) : undefined,
                partLabels: ['V', 'C', 'B', 'PC'],
              },
              memory,
            ),
          );
          lyricScores = lyricResult.scores;
          lyricEngine = lyricResult.engine;
          for (const modelKey of lyricResult.exhaustedModels) exhausted.add(modelKey);
          remaining.forEach(({ song }, index) => {
            const found = evidence.get(song.id);
            if (!found) return;
            found.observations = lyricResult.observations[index] ?? [];
            found.confidence = lyricResult.confidence[index] ?? 0;
            found.needsReview = lyricResult.needsReview[index] ?? true;
          });
          reviewFlags = new Map(
            remaining.map(({ song }, index) => [song.id, lyricResult.needsReview[index] ?? false]),
          );
        } catch (error) {
          console.warn('가사 일괄 인식 실패, 곡별 인식으로 전환:', error instanceof Error ? error.message : error);
        }

        const scoreById = new Map<string, ParsedScore>();
        remaining.forEach(({ song, identity }, index) => {
          if (isCancelled(song.id)) return;
          const full = lyricScores?.[index] ?? { order: [], sections: [] };
          scoreById.set(
            song.id,
            // Learned corrections land after the models have agreed and before
            // the web is consulted: a repeat misreading is fixed from our own
            // verified history, and a high-confidence web line still wins.
            applySafeCorrections(
              {
                ...full,
                title: full.title ?? identity.title,
                artist: full.artist ?? identity.artist,
                key: full.key ?? identity.key,
              },
              memory,
            ),
          );
        });

        // The hand-trained corrector runs last among the local steps: it has
        // seen this deployment's own hard pages, so it can propose a fix where
        // every vision model made the same mistake and consensus had nothing
        // to choose between. Every failure leaves consensus exactly as it was.
        if (corrector) {
          enterPhase('crosscheck', [...scoreById.keys()]);
          for (const [id, score] of [...scoreById.entries()]) {
            if (isCancelled(id)) continue;
            const found = evidence.get(id);
            scoreById.set(
              id,
              await correctConsensus(score, found?.observations ?? [], corrector, {
                titleConfidence: found?.confidence,
              }),
            );
          }
        }

        // A full response can occasionally identify a title that the quick
        // title pass missed. Apply the exclusion list first, then prefer the
        // saved library copy.
        for (const { song } of remaining) {
          const score = scoreById.get(song.id);
          if (!score || isCancelled(song.id)) continue;
          if (discardNonScorePage(song, score)) {
            scoreById.delete(song.id);
            resolvedIds.add(song.id);
            continue;
          }
          const recognizedTitle = score.title?.trim() || song.title;
          if (recognizedTitle && excludeRecognizedSong(song, recognizedTitle, settings.excludedTitles)) {
            scoreById.delete(song.id);
            resolvedIds.add(song.id);
            continue;
          }
          const aliased = recognizedTitle ? resolveTitleAlias(recognizedTitle, memory) : '';
          const saved =
            (aliased
              ? findReusableEntry(libraryRef.current, { title: aliased, artist: score.artist })
              : undefined) ?? libraryCandidates.get(song.id);
          // The saved copy replaces what was read only when the page says the
          // same thing. Where they differ the page wins: it is this week's
          // arrangement, and the library may be holding another song that
          // happens to share the title.
          if (saved && sameLyrics(saved.sections, score.sections)) {
            scoreById.delete(song.id);
            resolvedIds.add(song.id);
            fillFromLibrary(song, saved);
          }
        }

        // Apply the pages the batch pass actually read; pages that came back
        // without any lyrics move on to the per-page rescue pass instead of
        // being silently marked done while empty.
        const recognized = [...scoreById.entries()].filter(([, score]) => score.sections.length > 0);
        if (recognized.length > 0) {
          // Show what the score said straight away, but hold the song open:
          // the web pass still has to check the wording before it is saved.
          setSongs((current) =>
            current.map((song) => {
              const score = scoreById.get(song.id);
              if (!score || score.sections.length === 0 || isCancelled(song.id)) return song;
              return applyScoreToSong(song, score);
            }),
          );
          for (const [id, score] of recognized) {
            const fallback = remaining.find(({ song }) => song.id === id)?.song.title ?? '';
            webQueue.set(id, {
              score,
              engine: lyricEngine,
              title: (score.title || fallback).trim(),
            });
          }
        }

        const needRescue = remaining.filter(
          ({ song }) =>
            !isCancelled(song.id) &&
            !resolvedIds.has(song.id) &&
            !webQueue.has(song.id) &&
            (scoreById.get(song.id)?.sections.length ?? 0) === 0,
        );
        if (needRescue.length === 0) {
          await runWebLyricsPass();
          return;
        }

        enterPhase('rescue', needRescue.map(({ song }) => song.id));
        const failures = new Map<string, string>();
        await Promise.all(
          needRescue.map(async ({ song, image, identity }) => {
            try {
              // Re-render sharper for the retry; fall back to the batch image.
              const rescueImage = await doc
                .renderPage(song.pageIndex as number, RESCUE_RENDER_WIDTH, 'png')
                .catch(() => image);
              // Hard page: race the complete model pool and take the first
              // non-empty answer.
              const single = await recognizeScoreRaced(rescueImage, settings);
              if (isCancelled(song.id)) return;
              const known = scoreById.get(song.id);
              const merged: ParsedScore = {
                ...single.score,
                title: single.score.title ?? known?.title ?? identity.title,
                key: single.score.key ?? known?.key ?? identity.key,
              };
              if (discardNonScorePage(song, merged)) {
                resolvedIds.add(song.id);
                return;
              }
              const mergedTitle = merged.title?.trim();
              if (mergedTitle && excludeRecognizedSong(song, mergedTitle, settings.excludedTitles)) {
                resolvedIds.add(song.id);
                return;
              }
              const aliasedTitle = mergedTitle ? resolveTitleAlias(mergedTitle, memoryRef.current) : '';
              const saved =
                (aliasedTitle
                  ? findReusableEntry(libraryRef.current, { title: aliasedTitle, artist: merged.artist })
                  : undefined) ?? libraryCandidates.get(song.id);
              // Same rule as the batch path: identical title AND identical
              // lyrics, or the page's own reading stands.
              if (saved && sameLyrics(saved.sections, merged.sections)) {
                resolvedIds.add(song.id);
                fillFromLibrary(song, saved);
                return;
              }
              if (merged.sections.length === 0) {
                failures.set(song.id, '가사를 읽지 못했습니다.');
                return;
              }
              // Same as the batch path: show it now, finish it in the web pass.
              setSongs((current) =>
                current.map((s) => (s.id === song.id && !isCancelled(song.id) ? applyScoreToSong(s, merged) : s)),
              );
              webQueue.set(song.id, {
                score: merged,
                engine: single.engine,
                title: (merged.title || song.title).trim(),
              });
            } catch (error) {
              failures.set(song.id, error instanceof Error ? error.message : String(error));
            }
          }),
        );

        await runWebLyricsPass();

        if (failures.size > 0) {
          setRecog((current) => {
            const next = { ...current };
            for (const [id, message] of failures) {
              if (!isCancelled(id)) next[id] = { status: 'error', message };
            }
            return next;
          });
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setRecog((current) => {
          const next = { ...current };
          for (const song of active) {
            if (!isCancelled(song.id) && !resolvedIds.has(song.id)) {
              next[song.id] = { status: 'error', message };
            }
          }
          return next;
        });
      } finally {
        window.clearInterval(ticker);
        if (exhausted.size > 0) {
          // A spent free allowance is not a recognition failure, and saying so
          // is the difference between "try again tomorrow" and "something is
          // broken".
          showToast(`${ERROR_CATEGORY_LABELS.quota}: ${exhausted.size}개 모델의 오늘 무료 한도가 끝났습니다.`);
        }
      }
    },
    [fillFromLibrary, excludeRecognizedSong, discardNonScorePage],
  );

  const handleRecognizeClick = useCallback(
    (song: Song) => {
      if (song.pageIndex == null) return;
      // The title pass runs first: if it settles on a title the library
      // already holds, the saved lyrics are loaded and the page is never read
      // for lyrics at all.
      scanCancelledRef.current.delete(song.id);
      void recognizeSongsBatch([song]);
    },
    [recognizeSongsBatch],
  );

  /** Stop an accidentally started scan: discard its result and reset the card. */
  const cancelRecognition = useCallback((song: Song) => {
    scanCancelledRef.current.add(song.id);
    autoAttemptedRef.current.add(song.id);
    setRecog((r) => {
      const { [song.id]: _dropped, ...rest } = r;
      return rest;
    });
  }, []);

  // Classify every candidate PDF page right after upload — including pages
  // whose song is already in the library. That first visual pass is what keeps
  // non-score pages out of 찬양 가사. Only classified score pages that still
  // lack lyrics continue into the full pass. Each page is attempted once, and
  // scanning is skipped under browser automation so tests stay deterministic.
  useEffect(() => {
    const pending = songs.filter(
      (s) => s.pageIndex != null && !autoAttemptedRef.current.has(s.id),
    );
    if (pending.length === 0) return;

    const isAutomated = typeof navigator !== 'undefined' && navigator.webdriver;
    if (isAutomated || !docRef.current) return;
    for (const song of pending) autoAttemptedRef.current.add(song.id);
    void recognizeSongsBatch(pending);
  }, [songs, recognizeSongsBatch]);

  useEffect(() => {
    onSongsChange(songs);
  }, [songs, onSongsChange]);

  /**
   * Reopen a 라이브러리 deck in this step. Songs saved with the deck are
   * authoritative and load as-is — no re-parsing, no recognition, so the
   * lyrics come back exactly as they were downloaded. An entry saved before
   * snapshots existed has only its archived 콘티 PDF, which is re-parsed the
   * same way a fresh upload is.
   */
  useEffect(() => {
    if (restoreVersion === 0) return;
    if (restoreSongs) {
      docRef.current?.destroy();
      docRef.current = null;
      infoRef.current = null;
      setInfo(null);
      setSongs(restoreSongs.map((song) => structuredClone(song)));
      setPageImages({});
      setRecog({});
      setEdited(false);
      autoAttemptedRef.current.clear();
      scanCancelledRef.current.clear();
      return;
    }
    if (restoreConti) {
      void handleFile(new File([restoreConti.data], restoreConti.name, { type: 'application/pdf' }));
    }
    // Only a version bump restores; the payload props changing identity must not.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [restoreVersion]);

  /**
   * Apply — or decline — a web candidate the user chose.
   *
   * The merge runs against the reading recognition produced, not against
   * whatever is on screen now, so choosing a candidate after editing a line by
   * hand still lines the published wording up with what the score said.
   * Declining leaves the models' reading exactly as it is.
   */
  const selectWebCandidate = useCallback((songId: string, candidateId: string | null) => {
    const review = webReviewRef.current[songId];
    const baseline = webBaselineRef.current[songId];
    if (!review || !baseline) return;
    const chosen = candidateId ? review.candidates.find((entry) => entry.id === candidateId) : undefined;
    const merged = mergeRankedWebLyrics(baseline, chosen ?? null, candidateId ?? undefined);

    setSongs((current) =>
      current.map((song) => {
        if (song.id !== songId) return song;
        return {
          ...song,
          // The merge already decided the shape; applyScoreToSong would refuse
          // to touch a song that has lyrics, which by now it does.
          sections: merged.score.sections.map((section) => ({ label: section.label, lines: [...section.lines] })),
          order: [...merged.score.order],
          verification: 'draft',
          provenance: {
            ...song.provenance,
            source: chosen ? 'web' : 'models',
            webSourceUrl: chosen?.sourceUrl,
          },
        };
      }),
    );
    setEdited(true);
    setWebReview((current) => ({
      ...current,
      [songId]: { ...review, selectedId: candidateId ?? undefined, decision: chosen ? 'auto' : 'none' },
    }));
    if (chosen) {
      showToast(`'${chosen.title || '선택한 곡'}' 가사를 ${chosen.sourceHost}에서 적용했습니다.`);
    }
  }, []);

  /**
   * Pair one verified correction with a shrunken copy of the page it came
   * from, and store it in the training corpus.
   */
  const storeTrainingRecord = useCallback(
    async (evidence: PageEvidence, finalHash: string, final: ParsedScore, diff: FeedbackDiff) => {
      const pageHash = evidence.pageHash;
      if (!pageHash) return;
      const resized = evidence.image ? await resizeTrainingImage(evidence.image) : null;
      const bytes = resized ? dataUrlToBytes(resized.dataUrl) : undefined;
      await uploadTrainingRecord(
        {
          // Derived from the page, so re-verifying the same page adds a
          // version instead of a second record.
          id: pageHash.slice(0, 32),
          pageHash,
          feedbackId: finalHash,
          createdAt: new Date().toISOString(),
          imageAvailable: !!bytes,
          ...(bytes && resized
            ? {
                image: {
                  mimeType: resized.mimeType,
                  size: bytes.byteLength,
                  sha256: await hashText(resized.dataUrl),
                  chunkCount: Math.max(1, Math.ceil(bytes.byteLength / (1024 * 1024))),
                },
              }
            : {}),
          versions: [final],
          diff,
        },
        bytes,
      );
    },
    [],
  );

  /**
   * Turn one explicit save into a training record and queue it.
   *
   * Everything here is best-effort and deliberately after the library write:
   * the user is building a slide deck, and a save must never fail, block, or
   * wait on the network because a model could be scored from it.
   */
  const submitFeedback = useCallback(
    async (song: Song, final: ParsedScore, diff: FeedbackDiff, verification: 'verified' | 'edited') => {
      const evidence = evidenceRef.current.get(song.id);
      const baseline = song.provenance?.baseline;
      if (!evidence?.pageHash || !baseline) return;

      const review = webReviewRef.current[song.id];
      const finalHash = await hashText(canonicalScore(final));
      // What this one correction teaches: a title alias, the exact text pairs
      // that changed, and short before/after examples for future prompts.
      const learned = buildLearningMemory([
        {
          id: 'pending',
          pageHash: evidence.pageHash,
          finalHash,
          createdAt: new Date().toISOString(),
          observations: [],
          baseline: {
            title: baseline.title,
            artist: baseline.artist,
            key: baseline.key,
            order: baseline.order,
            sections: baseline.sections,
          },
          final,
          webCandidates: [],
          diff,
          verification,
          evaluations: [],
        },
      ]);
      const memoryContribution = {
        aliases: learned.titleAliases.map((alias) => ({ from: alias.from, to: alias.to })),
        corrections: learned.corrections.map(({ before, after, contextBefore, contextAfter }) => ({
          before,
          after,
          contextBefore,
          contextAfter,
        })),
        examples: learned.examples,
      };
      queueFeedback({
        id: crypto.randomUUID(),
        pageHash: evidence.pageHash,
        finalHash,
        createdAt: new Date().toISOString(),
        observations: evidence.observations,
        baseline: {
          title: baseline.title,
          artist: baseline.artist,
          key: baseline.key,
          order: baseline.order,
          sections: baseline.sections,
        },
        final,
        webCandidates: (review?.candidates ?? []).map(feedbackCandidate),
        selectedWebCandidateId: review?.selectedId,
        diff,
        verification,
        // Scored here, against the answer the user stood behind. The proxy
        // stores numbers, not judgements, so the comparison has to happen on
        // the side that has both readings.
        evaluations: evidence.observations.map((observation) => scoreObservation(observation, final)),
        memory: memoryContribution,
      });

      // The training copy is stored after the record is safely queued and is
      // never allowed to hold up a save: a page whose image cannot be captured
      // still contributes its correction as metadata.
      void storeTrainingRecord(evidence, finalHash, final, diff).catch(() => undefined);
    },
    [storeTrainingRecord],
  );

  /**
   * The user pressing "save to library" — the only thing in the app that
   * creates ground truth.
   *
   * Confirming the machine's answer unchanged is as informative as correcting
   * it: it is the only evidence a model read a page RIGHT. So both outcomes
   * are recorded, distinguished by the diff against what recognition produced.
   * Everything after the library write is best-effort and never blocks it.
   */
  const handleSaveToLibrary = useCallback(
    (song: Song) => {
      const baseline = song.provenance?.baseline;
      const final: ParsedScore = {
        title: song.title.trim() || undefined,
        artist: song.artist,
        key: song.key,
        order: [...song.order],
        sections: structuredClone(song.sections),
      };
      const diff = baseline
        ? diffFeedback(
            { title: baseline.title, artist: baseline.artist, key: baseline.key, order: baseline.order, sections: baseline.sections },
            final,
          )
        : undefined;
      // With no recorded baseline this song never went through recognition
      // (typed by hand, or pulled from the library), so there is nothing to
      // have corrected — the user's copy is simply verified.
      const verification = diff ? verificationFor(diff) : 'verified';

      const entry = saveToLibrary(song, verification);
      if (!entry) return;
      setSongs((current) =>
        current.map((candidate) =>
          candidate.id === song.id
            ? { ...candidate, verification, version: entry.version }
            : candidate,
        ),
      );
      showToast(
        verification === 'verified'
          ? `'${entry.title}' 을(를) 검증된 가사로 저장했습니다.`
          : `'${entry.title}' 수정본을 학습 자료로 저장했습니다.`,
      );

      if (!diff || !song.provenance?.pageHash) return;
      void submitFeedback(song, final, diff, verification).catch(() => {
        // Learning is best-effort: a save is never allowed to fail because a
        // training record could not be built or sent.
      });
    },
    [saveToLibrary, submitFeedback],
  );

  const removeFromUserLibrary = useCallback((title: string) => {
    const want = normalizeTitle(title);
    const user = loadUserLibrary().filter((e) => normalizeTitle(e.title) !== want);
    saveUserLibrary(user);
    queueLyricsDelete(title);
    void (async () => {
      const bundled = await fetchBundledLibrary(BASE);
      setLibrary(mergeLibraries(bundled, user));
    })();
  }, []);

  const addFromLibrary = useCallback((entry: LibraryEntry) => {
    setSongs((l) => [...l, songFromLibrary(entry)]);
    setEdited(true);
    showToast(`'${entry.title}' 을(를) 목록에 추가했습니다.`);
  }, []);

  const importLibrary = useCallback((entries: LibraryEntry[]) => {
    let user = loadUserLibrary();
    const imported: LibraryEntry[] = [];
    for (const e of entries) {
      if (e && typeof e.title === 'string' && Array.isArray(e.sections) && Array.isArray(e.order)) {
        user = upsertEntry(user, e);
        imported.push(e);
      }
    }
    saveUserLibrary(user);
    for (const entry of imported) queueLyricsUpsert(entry);
    setLibrary((lib) => imported.reduce((acc, e) => upsertEntry(acc, e), lib));
    showToast(`${imported.length}곡을 라이브러리로 가져왔습니다.`);
  }, []);

  async function handleFile(file: File) {
    if (edited && songs.length > 0) {
      if (!window.confirm('편집 중인 내용이 있습니다. 새 콘티로 교체할까요?')) return;
    }
    setParsing(true);
    try {
      const data = await file.arrayBuffer();
      docRef.current?.destroy();
      const doc = await loadConti(data);
      docRef.current = doc;
      const parsed = doc.parsed;
      onContiFileLoaded?.({ name: file.name, data });

      // Wait for the song library before matching titles, so a conti uploaded
      // right after page load still pulls saved lyrics instead of scanning.
      const lib = library.length > 0 ? library : ((await libraryPromiseRef.current) ?? []);

      const next: Song[] = [];
      const assigned = new Set<number>();
      // A conti without a recognized cover page still has usable sheet music:
      // derive the song list straight from the score pages, in page order.
      const hasCover = parsed.info.songs.length > 0;
      const baseSongs = hasCover
        ? parsed.info.songs
        : deriveSongsFromMusicPages(parsed.pageTexts, parsed.musicPages, lib);
      // Which song is the 공동체 고백송 is an administrator setting, and it
      // also decides which entry is the 설교 후 찬양 (the one listed after it).
      const shared = await getSyncedAiSettings();
      const { lyricsSongs, confessionSong, postSermonSong } = splitLyricsAndConfessionSongs(
        baseSongs,
        shared.confessionSong,
      );
      const excludedPages = new Set<number>();
      if (confessionSong?.pageIndex != null) excludedPages.add(confessionSong.pageIndex);

      for (const entry of lyricsSongs) {
        // A song with a score page waits for recognition: nothing has read the
        // page yet, so there is no way to tell whether the saved lyrics are the
        // ones printed on it. A song the conti lists with no score page will
        // never be read at all — there the saved copy, under exactly this
        // title, is all there is.
        const hit = entry.pageIndex == null ? findEntry(lib, entry.title) : undefined;
        const song = hit ? songFromLibrary(hit, entry.pageIndex) : blankSong(entry.title);
        song.title = entry.title;
        song.key = entry.key ?? song.key;
        song.description = entry.description;
        song.pageIndex = entry.pageIndex;
        // 콘티 order: the song right after the 공동체 고백송 is sung after the
        // sermon, so its slides go after the post-sermon 기도 slide.
        if (postSermonSong && entry === postSermonSong) song.postSermon = true;
        next.push(song);
        if (entry.pageIndex != null) assigned.add(entry.pageIndex);
      }
      // Music pages the cover didn't list: match against the library by page text,
      // else add a stub the user can fill in while looking at the score image.
      for (const page of parsed.musicPages) {
        if (assigned.has(page) || excludedPages.has(page)) continue;
        const pageText = normalizeTitle(parsed.pageTexts[page - 1] ?? '');
        const hit = lib.find((e) => {
          const t = normalizeTitle(e.title);
          return t.length >= 2 && pageText.includes(t);
        });
        if (hit) {
          if (confessionSong && normalizeTitle(hit.title) === normalizeTitle(confessionSong.title)) continue;
          // The page text names the song; its lyrics still come from reading
          // the score, and the saved copy only stands in if the two agree.
          const named = blankSong(hit.title);
          named.key = hit.key;
          named.pageIndex = page;
          next.push(named);
        } else {
          const stub = blankSong(`새 찬양 (p.${page})`);
          stub.pageIndex = page;
          next.push(stub);
        }
      }

      // Cover-listed songs on the administrator exclusion list (공동체
      // 고백송, 예배 전 준비 찬양 등) never become cards in the first place.
      const excludedSongs = next.filter(
        (song) => song.title.trim() && isExcludedTitle(song.title, shared.excludedTitles),
      );
      const kept = next.filter((song) => !excludedSongs.includes(song));
      if (excludedSongs.length > 0) {
        showToast(
          `${excludedSongs.map((song) => `'${song.title}'`).join(', ')}은(는) 제외 목록에 있어 찬양 편집에서 제외했습니다.`,
        );
      }

      const hasDetectedInfo = !!(
        parsed.info.date ||
        parsed.info.sermonTitle ||
        parsed.info.scripture ||
        parsed.info.songs.length > 0
      );
      const initialInfo = hasDetectedInfo ? parsed.info : null;
      infoRef.current = initialInfo;
      setInfo(initialInfo);
      setSongs(kept);
      setEdited(false);
      setPageImages({});
      setRecog({});
      autoAttemptedRef.current.clear();
      onDateDetected?.(parsed.info.date);
      onContiInfoDetected?.(parsed.info);
      if (!hasCover && next.length > 0) {
        showToast(
          `표지를 찾지 못해 악보 순서대로 ${next.length}곡을 정리했습니다.` +
            (confessionSong ? ` '${confessionSong.title}'은 공동체 고백송으로 제외했어요.` : '') +
            ' 제목과 가사를 확인해 주세요.',
          'warn',
        );
      } else if (confessionSong) {
        showToast(`'${confessionSong.title}'은 공동체 고백송으로 찬양 슬라이드에서 제외했습니다 (백 슬라이드에 포함).`);
      }
      const postSermonKept = kept.find((song) => song.postSermon);
      if (postSermonKept) {
        showToast(`'${postSermonKept.title}'은 설교 후 찬양으로 두었습니다 (설교 뒤 기도 슬라이드 다음).`);
      }

      // Render score previews in the background.
      void (async () => {
        for (const page of parsed.musicPages) {
          try {
            const url = await doc.renderPage(page, 700);
            setPageImages((imgs) => ({ ...imgs, [page]: url }));
          } catch {
            // preview is best-effort
          }
        }
      })();

      // New songs are auto-recognized by the reactive effect above once
      // recognition is ready (on upload, or later when a key is added).

      if (next.length === 0) {
        showToast('콘티에서 곡을 찾지 못했습니다. 곡을 직접 추가해 주세요.', 'error');
      }
    } catch (e) {
      showToast(`PDF를 읽는 중 오류가 발생했습니다: ${e instanceof Error ? e.message : String(e)}`, 'error');
    } finally {
      setParsing(false);
    }
  }

  // Latest handleFile, for the window-wide listener that must not be torn down
  // and rebuilt on every render.
  const handleFileRef = useRef(handleFile);
  useEffect(() => {
    handleFileRef.current = handleFile;
  });

  /**
   * 콘티는 화면 어디에 놓아도 열린다.
   *
   * 업로드 상자를 정확히 겨냥하지 않아도, 다른 단계를 보고 있어도, PDF를 창 안
   * 아무 곳에나 떨어뜨리면 그대로 콘티로 읽는다. 이미 자기 영역에서 받은
   * 드롭(콘티 상자·설교 PPT·추가 자료)은 그 핸들러가 preventDefault()를 부른
   * 뒤에야 이 리스너가 돌기 때문에 여기서 도로 가져가지 않는다.
   */
  useEffect(() => {
    // dragenter/dragleave fire in pairs as the pointer crosses nested elements;
    // counting them keeps the hint up until the drag really leaves the window.
    let depth = 0;
    // dragover repeats every few milliseconds — only tell React on a change.
    let shown = false;
    function show() {
      if (shown) return;
      shown = true;
      setFileDragOverWindow(true);
    }
    function endDrag() {
      depth = 0;
      if (!shown) return;
      shown = false;
      setFileDragOverWindow(false);
    }
    function onDragEnter(event: DragEvent) {
      if (!dragCarriesFiles(event.dataTransfer)) return;
      depth += 1;
      show();
    }
    function onDragOver(event: DragEvent) {
      if (!dragCarriesFiles(event.dataTransfer)) return;
      // Without this the browser refuses the drop and opens the file instead.
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
      show();
    }
    function onDragLeave() {
      depth = Math.max(0, depth - 1);
      if (depth === 0) endDrag();
    }
    function onDrop(event: DragEvent) {
      endDrag();
      if (event.defaultPrevented) return;
      const drop = readContiDrop(event.dataTransfer?.files);
      if (drop.kind === 'empty') return;
      // Keep the browser from opening the file and throwing the work away.
      event.preventDefault();
      if (drop.kind === 'unsupported') {
        showToast('찬양 콘티는 PDF 파일만 올릴 수 있습니다.', 'error');
        return;
      }
      onContiDropAnywhere?.();
      void handleFileRef.current(drop.file);
    }
    window.addEventListener('dragenter', onDragEnter);
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('dragleave', onDragLeave);
    window.addEventListener('dragend', endDrag);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragenter', onDragEnter);
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('dragleave', onDragLeave);
      window.removeEventListener('dragend', endDrag);
      window.removeEventListener('drop', onDrop);
    };
  }, [onContiDropAnywhere]);

  function updateSong(next: Song) {
    setEdited(true);
    setSongs((list) => list.map((s) => (s.id === next.id ? next : s)));
  }

  function moveSong(id: string, delta: -1 | 1) {
    setSongs((list) => {
      const idx = list.findIndex((s) => s.id === id);
      const to = idx + delta;
      if (idx === -1 || to < 0 || to >= list.length) return list;
      const next = list.slice();
      [next[idx], next[to]] = [next[to], next[idx]];
      return next;
    });
  }

  function removeSong(id: string) {
    setSongs((list) => list.filter((s) => s.id !== id));
  }

  return (
    <div className="tool">
      <section className="card">
        <h3>
          <span className="step">1</span> 콘티 업로드
        </h3>
        {/* A real button, so the dropzone is reachable with Tab and fires on
            Enter/Space — dropping a file stays the shortcut, not the only way in. */}
        <button
          type="button"
          className={`dropzone${dragOver ? ' dragover' : ''}`}
          data-testid="upload-dropzone"
          onClick={() => fileInputRef.current?.click()}
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(false);
            const file = e.dataTransfer.files[0];
            if (file) void handleFile(file);
          }}
        >
          <input
            ref={fileInputRef}
            type="file"
            accept="application/pdf,.pdf"
            data-testid="pdf-input"
            className="visually-hidden-input"
            tabIndex={-1}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void handleFile(file);
              e.target.value = '';
            }}
          />
          {parsing ? (
            <span className="parsing">
              <span className="spinner" aria-hidden="true" />
              <span>콘티를 분석하는 중입니다…</span>
            </span>
          ) : (
            <>
              <span className="dropzone-title">
                <Icon name="file" />
                찬양 콘티 PDF를 여기에 끌어다 놓거나 클릭하세요
              </span>
              <span className="dropzone-sub">
                악보 페이지에서만 찬양 가사를 읽고, 악보가 없는 페이지에서는 설교 제목·본문을
                찾아 자동으로 채워 드립니다.
              </span>
            </>
          )}
        </button>

        {info && (
          <div className="conti-info" data-testid="conti-info">
            <div className="info-grid">
              {info.date && (
                <div>
                  <span className="info-label">날짜</span> {info.date}
                </div>
              )}
              {info.sermonTitle && (
                <div>
                  <span className="info-label">설교 제목</span> “{info.sermonTitle}”
                </div>
              )}
              {info.scripture && (
                <div>
                  <span className="info-label">본문</span> {info.scripture}
                </div>
              )}
            </div>
            <div className="info-songs">
              {info.songs.map((s, i) => (
                <span key={i} className="chip chip-song">
                  {s.title}
                  {s.key && <em>{s.key}</em>}
                </span>
              ))}
            </div>
          </div>
        )}
      </section>

      <section className="card">
        <h3>
          <span className="step">2</span> 찬양 편집
        </h3>
        {songs.length === 0 && (
          <p className="empty-hint">
            콘티를 업로드하거나, 아래 버튼으로 곡을 직접 추가하세요. V(절)·PC(프리코러스)·C(후렴)·
            B(브릿지)·I(간주) 등 파트 이름을 자유롭게 정하고 순서를 적으면 그대로 슬라이드가
            됩니다. 절·후렴이 여러 개면 버튼을 다시 눌러 V2, C2처럼 이어서 추가할 수 있어요.
          </p>
        )}
        {songs.map((song, idx) => (
          <div key={song.id} id={`song-editor-${song.id}`}>
            <SongCard
              song={song}
              index={idx}
              total={songs.length}
              pageImage={song.pageIndex != null ? pageImages[song.pageIndex] : undefined}
              recog={recog[song.id]}
              onRecognize={song.pageIndex != null ? () => handleRecognizeClick(song) : undefined}
              onCancelRecognize={() => cancelRecognition(song)}
              onChange={updateSong}
              onMove={moveSong}
              onRemove={removeSong}
              onSaveToLibrary={handleSaveToLibrary}
              webReview={webReview[song.id]}
              onSelectWebCandidate={(candidateId) => selectWebCandidate(song.id, candidateId)}
              onZoom={() => setZoomSongId(song.id)}
              onTitleBlur={(title) => {
                const hit = findEntry(library, title);
                if (hit && !songHasLyrics(song)) {
                  setEdited(true);
                  fillFromLibrary(song, hit);
                }
              }}
            />
          </div>
        ))}
        <div className="add-row">
          <button
            type="button"
            className="btn"
            data-testid="add-song"
            onClick={() => setSongs((l) => [...l, blankSong()])}
          >
            <Icon name="plus" />
            빈 찬양 추가
          </button>
          <LibraryAddSearch
            library={library}
            onAdd={(entry) => {
              setSongs((l) => [...l, songFromLibrary(entry)]);
              setEdited(true);
            }}
          />
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => {
              setLibraryOpen(true);
              libraryPromiseRef.current = refreshLibrary();
            }}
          >
            <Icon name="library" />
            라이브러리 관리
          </button>
        </div>
      </section>

      {libraryOpen && (
        <Modal title="곡 라이브러리" onClose={() => setLibraryOpen(false)}>
          <p className={`admin-sync admin-sync-${librarySync}`} data-testid="lyrics-library-sync" role="status">
            {librarySync === 'syncing'
              ? '모든 기기의 가사 라이브러리를 불러오는 중…'
              : librarySync === 'synced'
                ? '공유 서버에 저장됨 · 모든 기기와 동기화됩니다.'
                : librarySync === 'error'
                  ? '공유 서버에 연결하지 못했습니다. 변경 사항은 이 기기에 보관하고 자동으로 다시 시도합니다.'
                  : '공유 서버 미연결 · 이 기기에만 저장됩니다.'}
          </p>
          <LibraryManager
            library={library}
            onDelete={removeFromUserLibrary}
            onImport={importLibrary}
            onAdd={addFromLibrary}
          />
        </Modal>
      )}
      {zoomSong && (
        <Modal
          title={`콘티 보기 — ${zoomSong.title.trim() || '제목 없음'}`}
          full
          onClose={() => setZoomSongId(null)}
        >
          <div className="split-view" data-testid="split-view">
            <div className="split-view-pdf" data-testid="split-view-pdf">
              {(docRef.current
                ? Array.from({ length: docRef.current.parsed.numPages }, (_, i) => i + 1)
                : zoomSong.pageIndex != null
                  ? [zoomSong.pageIndex]
                  : []
              ).map((page) => (
                <figure
                  key={page}
                  id={`split-page-${page}`}
                  className={`split-page${zoomSong.pageIndex === page ? ' split-page-active' : ''}`}
                >
                  {pageImages[page] ? (
                    <img src={pageImages[page]} alt={`콘티 ${page}페이지`} loading="lazy" />
                  ) : (
                    <div className="split-page-loading">페이지 {page} 준비 중…</div>
                  )}
                  <figcaption className="split-page-number">p.{page}</figcaption>
                </figure>
              ))}
            </div>
            <div className="split-view-editor" data-testid="split-view-editor">
              <SongCard
                editorOnly
                song={zoomSong}
                index={songs.findIndex((s) => s.id === zoomSong.id)}
                total={songs.length}
                recog={recog[zoomSong.id]}
                onRecognize={zoomSong.pageIndex != null ? () => handleRecognizeClick(zoomSong) : undefined}
                onCancelRecognize={() => cancelRecognition(zoomSong)}
                onChange={updateSong}
                onMove={moveSong}
                onRemove={removeSong}
                onSaveToLibrary={handleSaveToLibrary}
                webReview={webReview[zoomSong.id]}
                onSelectWebCandidate={(candidateId) => selectWebCandidate(zoomSong.id, candidateId)}
                onZoom={() => {}}
                onTitleBlur={(title) => {
                  const hit = findEntry(library, title);
                  if (hit && !songHasLyrics(zoomSong)) {
                    setEdited(true);
                    fillFromLibrary(zoomSong, hit);
                  }
                }}
              />
            </div>
          </div>
        </Modal>
      )}

      {/* The window-wide hint lives on <body>: this step is display:none while
          another wizard step is open, and a drop is welcome there too. It never
          takes pointer events, so every real dropzone under it still wins. */}
      {fileDragOverWindow &&
        createPortal(
          <div className="drop-anywhere" data-testid="drop-anywhere-overlay" aria-hidden="true">
            <div className="drop-anywhere-card">
              <Icon name="file" large />
              <p className="drop-anywhere-title">찬양 콘티 PDF를 화면 아무 곳에나 놓으세요</p>
              <p className="drop-anywhere-sub">
                설교 PPT와 추가 자료는 각 단계의 업로드 상자에 그대로 놓으면 됩니다.
              </p>
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}
