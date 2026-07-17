import { useCallback, useEffect, useRef, useState } from 'react';
import type { ContiInfo, LibraryEntry, Song } from '../lib/utils/types';
import { loadConti, type ContiDocument } from '../lib/utils/contiPdf';
import { deriveSongsFromMusicPages, splitLyricsAndConfessionSongs } from '../lib/utils/contiText';
import {
  fetchBundledLibrary,
  findEntry,
  loadUserLibrary,
  mergeLibraries,
  normalizeTitle,
  saveUserLibrary,
  upsertEntry,
} from '../lib/storage/library';
import SongCard, { type RecogState } from './SongCard';
import Modal from './Modal';
import LibraryManager from './LibraryManager';
import LibraryAddSearch from './LibraryAddSearch';
import { getSyncedAiSettings } from '../lib/ai/aiSettings';
import {
  applyScoreToSong,
  recognizeScoreBatch,
  recognizeScoreBatchEnsemble,
  recognizeScoreRaced,
} from '../lib/ai/scoreRecognition';
import type { ParsedScore } from '../lib/ai/scoreParser';
import { planScoreBatch } from '../lib/ai/scoreBatchPlan';
import { recognitionProgress, type RecognitionPhase } from '../lib/ai/recognitionProgress';
import { isExcludedTitle } from '../lib/utils/excludedTitles';
import { showToast } from '../lib/utils/toast';

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
}

export default function LyricsGenerator({
  onSongsChange,
  onDateDetected,
  onContiInfoDetected,
  onContiFileLoaded,
}: Props) {
  const [library, setLibrary] = useState<LibraryEntry[]>([]);
  const [info, setInfo] = useState<ContiInfo | null>(null);
  const infoRef = useRef<ContiInfo | null>(null);
  const [songs, setSongs] = useState<Song[]>([]);
  const [pageImages, setPageImages] = useState<Record<number, string>>({});
  const [parsing, setParsing] = useState(false);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [recog, setRecog] = useState<Record<string, RecogState>>({});
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
  // Latest library, for use inside callbacks that must stay referentially stable.
  const libraryRef = useRef<LibraryEntry[]>([]);
  useEffect(() => {
    libraryRef.current = library;
  }, [library]);
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

  useEffect(() => {
    libraryPromiseRef.current = (async () => {
      const bundled = await fetchBundledLibrary(BASE);
      const merged = mergeLibraries(bundled, loadUserLibrary());
      setLibrary(merged);
      return merged;
    })();
    return () => docRef.current?.destroy();
  }, []);

  const saveToLibrary = useCallback((song: Song) => {
    if (!song.title.trim()) return;
    const entry: LibraryEntry = {
      title: song.title.trim(),
      key: song.key,
      sections: structuredClone(song.sections),
      order: [...song.order],
    };
    const user = upsertEntry(loadUserLibrary(), entry);
    saveUserLibrary(user);
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
        saveToLibrary(song);
        showToast(`'${song.title}' 을(를) 라이브러리에 자동으로 저장했습니다.`);
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
  const fillFromLibrary = useCallback((song: Song, entry: LibraryEntry) => {
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
    showToast(`라이브러리에서 '${entry.title}' 가사를 불러왔습니다.`);
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
   * 2) one title-only request for all pages, then resolve library hits
   *    (best-effort — a failure here just skips early library matching);
   * 3) one full-lyrics request containing only the unmatched pages;
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
      const markDone = (ids: string[], engine: string) => {
        for (const id of ids) resolvedIds.add(id);
        setRecog((current) => {
          const next = { ...current };
          for (const id of ids) {
            if (!isCancelled(id)) next[id] = { status: 'done', engine };
          }
          return next;
        });
      };
      enterPhase('render', tracked.ids);

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

        // Quick title pass. Best-effort: on failure the full pass still runs,
        // it just can't resolve library songs early.
        enterPhase('titles', tracked.ids);
        let titleScores: ParsedScore[] = active.map(() => ({ order: [], sections: [] }));
        try {
          titleScores = (await recognizeScoreBatch(images, settings, 'titles')).scores;
        } catch (error) {
          console.warn('제목 일괄 인식 실패, 전체 가사 인식으로 계속:', error instanceof Error ? error.message : error);
        }

        const unmatched: { song: Song; image: string; identity: ParsedScore }[] = [];
        const identityById = new Map<string, ParsedScore>();
        const titlePlan = planScoreBatch(
          titleScores,
          active.map((song) => song.title),
          libraryRef.current,
        );

        active.forEach((song, index) => {
          if (isCancelled(song.id)) return;
          const identity = titleScores[index] ?? { order: [], sections: [] };
          if (discardNonScorePage(song, identity)) {
            resolvedIds.add(song.id);
            return;
          }
          const recognizedTitle = identity.title?.trim();
          if (recognizedTitle && excludeRecognizedSong(song, recognizedTitle, settings.excludedTitles)) {
            resolvedIds.add(song.id);
            return;
          }
          const hit = titlePlan.libraryMatches[index];
          if (hit) {
            resolvedIds.add(song.id);
            fillFromLibrary(song, hit);
            return;
          }
          // Pages that already came from the library still participate in
          // classification, but never need the expensive full-lyrics pass.
          if (songHasLyrics(song)) {
            markDone([song.id], 'library');
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
          // Every model reads the conti at once and works on the answer
          // together: the strongest model that read a page wins it, and the
          // other models fill in whatever fields it missed.
          const lyricResult = await recognizeScoreBatchEnsemble(
            remaining.map(({ image }) => image),
            settings,
            'full',
            remaining.map(hintFor),
          );
          lyricScores = lyricResult.scores;
          lyricEngine = lyricResult.engine;
        } catch (error) {
          console.warn('가사 일괄 인식 실패, 곡별 인식으로 전환:', error instanceof Error ? error.message : error);
        }

        const scoreById = new Map<string, ParsedScore>();
        remaining.forEach(({ song, identity }, index) => {
          if (isCancelled(song.id)) return;
          const full = lyricScores?.[index] ?? { order: [], sections: [] };
          scoreById.set(song.id, {
            ...full,
            title: full.title ?? identity.title,
            key: full.key ?? identity.key,
          });
        });

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
          const hit = recognizedTitle ? findEntry(libraryRef.current, recognizedTitle) : undefined;
          if (hit) {
            scoreById.delete(song.id);
            resolvedIds.add(song.id);
            fillFromLibrary(song, hit);
          }
        }

        // Apply the pages the batch pass actually read; pages that came back
        // without any lyrics move on to the per-page rescue pass instead of
        // being silently marked done while empty.
        const recognized = [...scoreById.entries()].filter(([, score]) => score.sections.length > 0);
        if (recognized.length > 0) {
          for (const [id] of recognized) pendingAutoSaveRef.current.add(id);
          setSongs((current) =>
            current.map((song) => {
              const score = scoreById.get(song.id);
              if (!score || score.sections.length === 0 || isCancelled(song.id)) return song;
              return applyScoreToSong(song, score);
            }),
          );
          markDone(recognized.map(([id]) => id), lyricEngine);
        }

        const needRescue = remaining.filter(
          ({ song }) =>
            !isCancelled(song.id) &&
            !resolvedIds.has(song.id) &&
            (scoreById.get(song.id)?.sections.length ?? 0) === 0,
        );
        if (needRescue.length === 0) return;

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
              const hit = mergedTitle ? findEntry(libraryRef.current, mergedTitle) : undefined;
              if (hit) {
                resolvedIds.add(song.id);
                fillFromLibrary(song, hit);
                return;
              }
              if (merged.sections.length === 0) {
                failures.set(song.id, '가사를 읽지 못했습니다.');
                return;
              }
              pendingAutoSaveRef.current.add(song.id);
              setSongs((current) =>
                current.map((s) => (s.id === song.id && !isCancelled(song.id) ? applyScoreToSong(s, merged) : s)),
              );
              markDone([song.id], single.engine);
            } catch (error) {
              failures.set(song.id, error instanceof Error ? error.message : String(error));
            }
          }),
        );

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
      }
    },
    [fillFromLibrary, excludeRecognizedSong, discardNonScorePage],
  );

  const handleRecognizeClick = useCallback(
    (song: Song) => {
      if (song.pageIndex == null) return;
      const hit = song.title.trim() ? findEntry(libraryRef.current, song.title) : undefined;
      if (hit) {
        fillFromLibrary(song, hit);
        return;
      }
      scanCancelledRef.current.delete(song.id);
      void recognizeSongsBatch([song]);
    },
    [fillFromLibrary, recognizeSongsBatch],
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

  /** Manual "save to library" button press — same as auto-save, but confirms with a toast. */
  const handleSaveToLibrary = useCallback(
    (song: Song) => {
      const entry = saveToLibrary(song);
      if (entry) showToast(`'${entry.title}' 을(를) 라이브러리에 저장했습니다.`);
    },
    [saveToLibrary],
  );

  const removeFromUserLibrary = useCallback((title: string) => {
    const want = normalizeTitle(title);
    const user = loadUserLibrary().filter((e) => normalizeTitle(e.title) !== want);
    saveUserLibrary(user);
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
    for (const e of entries) {
      if (e && typeof e.title === 'string' && Array.isArray(e.sections)) {
        user = upsertEntry(user, e);
      }
    }
    saveUserLibrary(user);
    setLibrary((lib) => entries.reduce((acc, e) => upsertEntry(acc, e), lib));
    showToast(`${entries.length}곡을 라이브러리로 가져왔습니다.`);
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
      const { lyricsSongs, confessionSong } = splitLyricsAndConfessionSongs(baseSongs);
      const excludedPages = new Set<number>();
      if (confessionSong?.pageIndex != null) excludedPages.add(confessionSong.pageIndex);

      for (const entry of lyricsSongs) {
        const hit = findEntry(lib, entry.title);
        const song = hit ? songFromLibrary(hit, entry.pageIndex) : blankSong(entry.title);
        song.title = entry.title;
        song.key = entry.key ?? song.key;
        song.description = entry.description;
        song.pageIndex = entry.pageIndex;
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
          next.push(songFromLibrary(hit, page));
        } else {
          const stub = blankSong(`새 찬양 (p.${page})`);
          stub.pageIndex = page;
          next.push(stub);
        }
      }

      // Cover-listed songs on the administrator exclusion list (공동체
      // 고백송, 예배 전 준비 찬양 등) never become cards in the first place.
      const shared = await getSyncedAiSettings();
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
      <p className="tool-intro">찬양 콘티 PDF를 업로드하면 가사 슬라이드를 자동으로 만들어 드립니다.</p>

      <section className="card">
        <h2>
          <span className="step">1</span> 콘티 업로드
        </h2>
        <div
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
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void handleFile(file);
              e.target.value = '';
            }}
          />
          {parsing ? (
            <div className="parsing">
              <div className="spinner" />
              <p>콘티를 분석하는 중입니다…</p>
            </div>
          ) : (
            <>
              <p className="dropzone-title">📄 찬양 콘티 PDF를 여기에 끌어다 놓거나 클릭하세요</p>
              <p className="dropzone-sub">
                악보 페이지에서만 찬양 가사를 읽고, 악보가 없는 페이지에서는 설교 제목·본문을
                찾아 자동으로 채워 드립니다.
              </p>
            </>
          )}
        </div>

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
        <h2>
          <span className="step">2</span> 찬양 편집
        </h2>
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
          <button className="btn" data-testid="add-song" onClick={() => setSongs((l) => [...l, blankSong()])}>
            ＋ 빈 찬양 추가
          </button>
          <LibraryAddSearch
            library={library}
            onAdd={(entry) => {
              setSongs((l) => [...l, songFromLibrary(entry)]);
              setEdited(true);
            }}
          />
          <button className="btn btn-ghost" onClick={() => setLibraryOpen(true)}>
            📚 라이브러리 관리
          </button>
        </div>
      </section>

      {libraryOpen && (
        <Modal title="곡 라이브러리" onClose={() => setLibraryOpen(false)}>
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
    </div>
  );
}
