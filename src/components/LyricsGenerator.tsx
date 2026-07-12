import { useCallback, useEffect, useRef, useState } from 'react';
import type { ContiInfo, LibraryEntry, Song } from '../lib/types';
import { loadConti, type ContiDocument } from '../lib/contiPdf';
import { deriveSongsFromMusicPages, splitLyricsAndConfessionSongs } from '../lib/contiText';
import {
  fetchBundledLibrary,
  findEntry,
  loadUserLibrary,
  mergeLibraries,
  normalizeTitle,
  saveUserLibrary,
  upsertEntry,
} from '../lib/library';
import SongCard, { type RecogState } from './SongCard';
import Modal from './Modal';
import LibraryManager from './LibraryManager';
import LibraryAddSearch from './LibraryAddSearch';
import { DEFAULT_AI_SETTINGS } from '../lib/aiSettings';
import { applyScoreToSong, recognizeScore } from '../lib/scoreRecognition';
import { showToast } from '../lib/toast';

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
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);

  useEffect(() => {
    void (async () => {
      const bundled = await fetchBundledLibrary(BASE);
      setLibrary(mergeLibraries(bundled, loadUserLibrary()));
    })();
    return () => docRef.current?.destroy();
  }, []);

  /** Recognize one song's score image and merge the draft in, without clobbering edits. */
  const recognizeSong = useCallback(async (songId: string, pageIndex: number) => {
    const doc = docRef.current;
    if (!doc) return;
    setRecog((r) => ({ ...r, [songId]: { status: 'running', progress: 0 } }));
    try {
      const image = await doc.renderPage(pageIndex, 1240);
      const parsed = await recognizeScore(image, DEFAULT_AI_SETTINGS, (p) =>
        setRecog((r) => ({ ...r, [songId]: { status: 'running', progress: p } })),
      );
      setSongs((list) => list.map((s) => (s.id === songId ? applyScoreToSong(s, parsed) : s)));
      setRecog((r) => ({ ...r, [songId]: { status: 'done' } }));
    } catch (e) {
      setRecog((r) => ({
        ...r,
        [songId]: { status: 'error', message: e instanceof Error ? e.message : String(e) },
      }));
    }
  }, []);

  const handleRecognizeClick = useCallback(
    (song: Song) => {
      if (song.pageIndex == null) return;
      void recognizeSong(song.id, song.pageIndex);
    },
    [recognizeSong],
  );

  // Auto-recognize new songs (a score page, no lyrics yet) right after upload.
  // All pending songs are recognized in parallel rather than one at a time,
  // each attempted at most once, and this is skipped under browser automation
  // so tests stay deterministic.
  useEffect(() => {
    const isAutomated = typeof navigator !== 'undefined' && navigator.webdriver;
    if (isAutomated || !docRef.current) return;
    const pending = songs.filter(
      (s) => s.pageIndex != null && !songHasLyrics(s) && !autoAttemptedRef.current.has(s.id),
    );
    if (pending.length === 0) return;
    for (const s of pending) autoAttemptedRef.current.add(s.id);
    for (const s of pending) void recognizeSong(s.id, s.pageIndex as number);
  }, [songs, recognizeSong]);

  useEffect(() => {
    onSongsChange(songs);
  }, [songs, onSongsChange]);

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
    setLibrary((lib) => upsertEntry(lib, entry));
    showToast(`'${entry.title}' 을(를) 라이브러리에 저장했습니다.`);
  }, []);

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

      const next: Song[] = [];
      const assigned = new Set<number>();
      // A conti without a recognized cover page still has usable sheet music:
      // derive the song list straight from the score pages, in page order.
      const hasCover = parsed.info.songs.length > 0;
      const baseSongs = hasCover
        ? parsed.info.songs
        : deriveSongsFromMusicPages(parsed.pageTexts, parsed.musicPages, library);
      const { lyricsSongs, confessionSong } = splitLyricsAndConfessionSongs(baseSongs);
      const excludedPages = new Set<number>();
      if (confessionSong?.pageIndex != null) excludedPages.add(confessionSong.pageIndex);

      for (const entry of lyricsSongs) {
        const hit = findEntry(library, entry.title);
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
        const hit = library.find((e) => {
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
            onChange={updateSong}
            onMove={moveSong}
            onRemove={removeSong}
            onSaveToLibrary={saveToLibrary}
            onZoom={() => setZoomPage(song.pageIndex ?? null)}
            onTitleBlur={(title) => {
              const hit = findEntry(library, title);
              const hasLyrics = song.sections.some((sec) => sec.lines.some((l) => l.trim()));
              if (hit && !hasLyrics) {
                updateSong({
                  ...song,
                  title: hit.title,
                  key: song.key ?? hit.key,
                  sections: structuredClone(hit.sections),
                  order: [...hit.order],
                });
                showToast(`라이브러리에서 '${hit.title}' 가사를 불러왔습니다.`);
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
