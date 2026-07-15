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
import { getAiSettings } from '../lib/ai/aiSettings';
import { applyScoreToSong, recognizeScoreBatch } from '../lib/ai/scoreRecognition';
import type { ParsedScore } from '../lib/ai/scoreParser';
import { planScoreBatch } from '../lib/ai/scoreBatchPlan';
import { showToast } from '../lib/utils/toast';

const BASE: string = import.meta.env.BASE_URL || '/';

function songHasLyrics(song: Song): boolean {
  return song.sections.some((s) => s.lines.some((l) => l.trim().length > 0));
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
}

export default function LyricsGenerator({ onSongsChange, onDateDetected, onContiInfoDetected }: Props) {
  const [library, setLibrary] = useState<LibraryEntry[]>([]);
  const [info, setInfo] = useState<ContiInfo | null>(null);
  const [songs, setSongs] = useState<Song[]>([]);
  const [pageImages, setPageImages] = useState<Record<number, string>>({});
  const [parsing, setParsing] = useState(false);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [recog, setRecog] = useState<Record<string, RecogState>>({});
  const [zoomPage, setZoomPage] = useState<number | null>(null);
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

  /**
   * Recognize every supplied score as one two-stage job:
   * 1) one title-only request for all pages, then resolve library hits;
   * 2) one full-lyrics request containing only the unmatched pages.
   */
  const recognizeSongsBatch = useCallback(
    async (targets: Song[]) => {
      const doc = docRef.current;
      const active = targets.filter((song) => song.pageIndex != null);
      if (!doc || active.length === 0) return;

      const isCancelled = (id: string) => scanCancelledRef.current.has(id);
      const setRunning = (ids: string[], phase: 'titles' | 'lyrics', progress: number) => {
        setRecog((current) => {
          const next = { ...current };
          for (const id of ids) {
            if (!isCancelled(id)) next[id] = { status: 'running', phase, progress };
          }
          return next;
        });
      };
      const activeIds = active.map((song) => song.id);
      const resolvedIds = new Set<string>();
      setRunning(activeIds, 'titles', 0);

      try {
        // Rendering and recognition are both batched: no per-song request loop.
        const images = await Promise.all(
          active.map((song) => doc.renderPage(song.pageIndex as number, 1240)),
        );
        const settings = getAiSettings();
        const titleResult = await recognizeScoreBatch(images, settings, 'titles', (progress) => {
          setRunning(activeIds, 'titles', progress);
        });

        const unmatched: { song: Song; image: string; identity: ParsedScore }[] = [];
        const identityById = new Map<string, ParsedScore>();
        const titlePlan = planScoreBatch(
          titleResult.scores,
          active.map((song) => song.title),
          libraryRef.current,
        );

        active.forEach((song, index) => {
          if (isCancelled(song.id)) return;
          const identity = titleResult.scores[index] ?? { order: [], sections: [] };
          const hit = titlePlan.libraryMatches[index];
          if (hit) {
            resolvedIds.add(song.id);
            fillFromLibrary(song, hit);
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

        const remainingIds = remaining.map(({ song }) => song.id);
        setRunning(remainingIds, 'lyrics', 0);
        const lyricResult = await recognizeScoreBatch(
          remaining.map(({ image }) => image),
          settings,
          'full',
          (progress) => setRunning(remainingIds, 'lyrics', progress),
        );

        const scoreById = new Map<string, ParsedScore>();
        remaining.forEach(({ song, identity }, index) => {
          if (isCancelled(song.id)) return;
          const full = lyricResult.scores[index] ?? { order: [], sections: [] };
          scoreById.set(song.id, {
            ...full,
            title: full.title ?? identity.title,
            key: full.key ?? identity.key,
          });
        });

        // A full response can occasionally identify a title that the quick
        // title pass missed. Prefer the saved library copy in that case too.
        for (const { song } of remaining) {
          const score = scoreById.get(song.id);
          if (!score || isCancelled(song.id)) continue;
          const recognizedTitle = score.title?.trim() || song.title;
          const hit = recognizedTitle ? findEntry(libraryRef.current, recognizedTitle) : undefined;
          if (hit) {
            scoreById.delete(song.id);
            resolvedIds.add(song.id);
            fillFromLibrary(song, hit);
          }
        }

        if (scoreById.size > 0) {
          for (const id of scoreById.keys()) pendingAutoSaveRef.current.add(id);
          setSongs((current) =>
            current.map((song) => {
              const score = scoreById.get(song.id);
              if (!score || isCancelled(song.id)) return song;
              return applyScoreToSong(song, score);
            }),
          );
        }
        setRecog((current) => {
          const next = { ...current };
          for (const id of scoreById.keys()) {
            if (!isCancelled(id)) next[id] = { status: 'done', engine: lyricResult.engine };
          }
          return next;
        });

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
      }
    },
    [fillFromLibrary, saveToLibrary],
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

  // Auto-recognize new songs (a score page, no lyrics yet) right after upload.
  // Songs whose title is already in the library skip the scan entirely and get
  // their saved lyrics instead. The rest are sent through one batch job rather
  // than one request per song, each attempted at most once, and scanning is skipped
  // under browser automation so tests stay deterministic.
  useEffect(() => {
    const pending = songs.filter(
      (s) => s.pageIndex != null && !songHasLyrics(s) && !autoAttemptedRef.current.has(s.id),
    );
    if (pending.length === 0) return;

    const toScan: Song[] = [];
    for (const s of pending) {
      const known = s.title.trim() && !/^새 찬양/.test(s.title) ? findEntry(library, s.title) : undefined;
      if (known) fillFromLibrary(s, known);
      else toScan.push(s);
    }

    const isAutomated = typeof navigator !== 'undefined' && navigator.webdriver;
    if (isAutomated || !docRef.current) return;
    for (const s of toScan) autoAttemptedRef.current.add(s.id);
    void recognizeSongsBatch(toScan);
  }, [songs, library, recognizeSongsBatch, fillFromLibrary]);

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

      setInfo(hasCover ? parsed.info : null);
      setSongs(next);
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
                표지의 날짜·설교 제목·곡 목록(키)을 자동으로 인식하고, 저장된 곡은 가사까지
                채워 드립니다.
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
          <SongCard
            key={song.id}
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
            onZoom={() => setZoomPage(song.pageIndex ?? null)}
            onTitleBlur={(title) => {
              const hit = findEntry(library, title);
              if (hit && !songHasLyrics(song)) {
                setEdited(true);
                fillFromLibrary(song, hit);
              }
            }}
          />
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
      {zoomPage != null && pageImages[zoomPage] && (
        <Modal title={`악보 (p.${zoomPage})`} wide onClose={() => setZoomPage(null)}>
          <img className="zoom-img" src={pageImages[zoomPage]} alt={`악보 ${zoomPage}페이지`} />
        </Modal>
      )}
    </div>
  );
}
