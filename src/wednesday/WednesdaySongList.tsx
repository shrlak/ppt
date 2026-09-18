// The 찬양 step: this week's songs, in order, each with the slides that go
// into the deck.
//
// A song is a title plus its slides, and the slides come from either its 찬양
// PPT or its 악보 사진 (one slide per page). Typing the title is enough: the
// app searches, downloads and attaches what it is sure about by itself. When
// it is not sure it shows what it found instead of guessing, and the upload
// button is always there — a source behind a login (네이버 카페) can never be
// automated, and a photo taken on a phone is nobody's search result.
import { useEffect, useMemo, useRef, useState } from 'react';
import Icon from '../components/Icon';
import { showToast } from '../lib/utils/toast';
import {
  SONG_FILE_ACCEPT,
  autoAttachSong,
  downloadSheetImage,
  downloadSongPpt,
  hasSongPptProxy,
  hostOf,
  readUploadedSheetImages,
  readUploadedSongDeck,
  type LoadedSheetImage,
  type SheetImageCandidate,
  type SongPptCandidate,
} from './songSource';
import { songSlideCount, type WednesdaySong, type WednesdaySongImage } from './types';
import {
  loadSongLibrary,
  saveSongEntry,
  searchSongEntries,
  synchronizeSongLibrary,
  type WednesdaySongEntry,
} from './songLibrary';

/** Same shape as a React setter: a download that finishes after the list has
 *  already changed must compose onto the current list, not the one it saw. */
export type SongsUpdate = WednesdaySong[] | ((current: WednesdaySong[]) => WednesdaySong[]);

interface Props {
  songs: WednesdaySong[];
  onChange: (songs: SongsUpdate) => void;
  /** Called when a song's files are dropped, so the draft can forget them. */
  onForgetDeck?: (id: string) => void;
}

interface RowState {
  /** 'searching' while the app looks the song up by itself. */
  busy?: 'searching' | 'downloading';
  pptCandidates?: SongPptCandidate[];
  sheetCandidates?: SheetImageCandidate[];
  message?: string;
  /** The title the automatic search last ran for, so it runs once per title. */
  searchedTitle?: string;
}

export function blankWednesdaySong(title = ''): WednesdaySong {
  return { id: crypto.randomUUID(), title };
}

function imageOf(loaded: LoadedSheetImage): WednesdaySongImage {
  return {
    id: crypto.randomUUID(),
    name: loaded.name,
    mimeType: loaded.mimeType,
    data: loaded.data,
    width: loaded.width,
    height: loaded.height,
    sourceUrl: loaded.sourceUrl,
  };
}

/** A thumbnail for one 악보 사진, revoked when the row stops showing it. */
function SheetThumbnail({ image }: { image: WednesdaySongImage }) {
  const [url, setUrl] = useState<string>();

  useEffect(() => {
    const objectUrl = URL.createObjectURL(new Blob([image.data], { type: image.mimeType }));
    setUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [image.data, image.mimeType]);

  return url ? <img src={url} alt={image.name} loading="lazy" /> : <span className="empty-hint">…</span>;
}

export default function WednesdaySongList({ songs, onChange, onForgetDeck }: Props) {
  const [rows, setRows] = useState<Record<string, RowState>>({});
  const [library, setLibrary] = useState<WednesdaySongEntry[]>(loadSongLibrary);
  const [libraryQuery, setLibraryQuery] = useState('');
  const fileInputs = useRef<Record<string, HTMLInputElement | null>>({});

  // The library is titles and links only, so it is small enough to sync on
  // open and keep in memory.
  useEffect(() => {
    let cancelled = false;
    void synchronizeSongLibrary().then((result) => {
      if (!cancelled) setLibrary(result.entries);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const libraryMatches = useMemo(
    () => searchSongEntries(library, libraryQuery, 8),
    [library, libraryQuery],
  );

  const patchRow = (id: string, patch: RowState) =>
    setRows((current) => ({ ...current, [id]: { ...current[id], ...patch } }));

  const updateSong = (id: string, patch: Partial<WednesdaySong>) =>
    onChange((current) => current.map((song) => (song.id === id ? { ...song, ...patch } : song)));

  const addSong = () => onChange((current) => [...current, blankWednesdaySong()]);

  const removeSong = (id: string) => {
    onChange((current) => current.filter((song) => song.id !== id));
    onForgetDeck?.(id);
  };

  const moveSong = (id: string, delta: -1 | 1) => {
    onChange((current) => {
      const index = current.findIndex((song) => song.id === id);
      const next = index + delta;
      if (index === -1 || next < 0 || next >= current.length) return current;
      const reordered = [...current];
      [reordered[index], reordered[next]] = [reordered[next], reordered[index]];
      return reordered;
    });
  };

  /** Remember the song and where its slides came from, for later weeks. */
  const remember = (title: string, sourceUrl: string | undefined, slideCount: number) => {
    const clean = title.trim();
    if (!clean) return;
    void saveSongEntry({ title: clean, sourceUrl, slideCount }).then(setLibrary);
  };

  /** Attach a 찬양 PPT. A song's slides are its PPT or its 악보 사진, never both. */
  const attachDeck = (song: WednesdaySong, patch: Partial<WednesdaySong>) => {
    updateSong(song.id, { images: undefined, ...patch });
    remember(song.title, patch.sourceUrl, patch.slideCount ?? 0);
  };

  const attachImages = (song: WednesdaySong, images: WednesdaySongImage[], replace: boolean) => {
    const next = replace ? images : [...(song.images ?? []), ...images];
    const fromWeb = next.find((image) => image.sourceUrl)?.sourceUrl;
    updateSong(song.id, {
      deck: undefined,
      slideCount: undefined,
      fileName: undefined,
      images: next,
      origin: images.some((image) => image.sourceUrl) ? 'download' : 'upload',
      sourceUrl: fromWeb ?? song.sourceUrl,
      sourceHost: fromWeb ? hostOf(fromWeb) : song.sourceHost,
    });
    remember(song.title, fromWeb, next.length);
  };

  const removeImage = (song: WednesdaySong, imageId: string) =>
    updateSong(song.id, { images: (song.images ?? []).filter((image) => image.id !== imageId) });

  const downloadDeckCandidate = async (
    song: WednesdaySong,
    candidate: Pick<SongPptCandidate, 'token' | 'url'> & Partial<SongPptCandidate>,
  ) => {
    patchRow(song.id, { busy: 'downloading', message: undefined });
    try {
      const loaded = await downloadSongPpt(candidate);
      attachDeck(song, {
        deck: loaded.deck,
        slideCount: loaded.slideCount,
        origin: 'download',
        sourceUrl: candidate.url,
        sourceHost: candidate.host ?? hostOf(candidate.url),
        fileName: loaded.fileName,
      });
      patchRow(song.id, { busy: undefined, pptCandidates: undefined, sheetCandidates: undefined });
    } catch (error) {
      patchRow(song.id, {
        busy: undefined,
        message: error instanceof Error ? error.message : '찬양 PPT를 받지 못했습니다.',
      });
    }
  };

  const downloadSheetCandidate = async (song: WednesdaySong, candidate: SheetImageCandidate) => {
    patchRow(song.id, { busy: 'downloading', message: undefined });
    try {
      const image = imageOf(await downloadSheetImage(candidate));
      attachImages(song, [image], false);
      patchRow(song.id, {
        busy: undefined,
        sheetCandidates: (rows[song.id]?.sheetCandidates ?? []).filter(
          (other) => other.url !== candidate.url,
        ),
      });
    } catch (error) {
      patchRow(song.id, {
        busy: undefined,
        message: error instanceof Error ? error.message : '악보 사진을 받지 못했습니다.',
      });
    }
  };

  /**
   * Look the song up and attach what comes back. Runs by itself once a title
   * is typed, and again on demand from the 다시 찾기 button.
   */
  const findAndAttach = async (song: WednesdaySong) => {
    const title = song.title.trim();
    if (!title) {
      showToast('곡 제목을 먼저 입력해 주세요.', 'error');
      return;
    }
    patchRow(song.id, {
      busy: 'searching',
      message: undefined,
      pptCandidates: undefined,
      sheetCandidates: undefined,
      searchedTitle: title,
    });

    const found = await autoAttachSong(title);
    if (found.kind === 'deck') {
      attachDeck(song, {
        deck: found.deck.deck,
        slideCount: found.deck.slideCount,
        origin: 'download',
        sourceUrl: found.candidate.url,
        sourceHost: found.candidate.host,
        fileName: found.deck.fileName,
      });
      patchRow(song.id, { busy: undefined });
      return;
    }
    if (found.kind === 'images') {
      attachImages(song, found.images.map(imageOf), true);
      patchRow(song.id, { busy: undefined, sheetCandidates: found.candidates });
      return;
    }
    patchRow(song.id, {
      busy: undefined,
      pptCandidates: found.pptCandidates,
      sheetCandidates: found.sheetCandidates,
      message:
        found.pptCandidates.length + found.sheetCandidates.length > 0
          ? '확실한 결과가 없어 찾은 것만 보여 드립니다. 맞는 것을 고르거나 파일을 올려 주세요.'
          : (found.message ?? '찬양 PPT도 악보 사진도 찾지 못했습니다. 직접 올려 주세요.'),
    });
  };

  // The automatic lookup: a song with a title and no slides gets searched for
  // on its own, once per title, and only while the proxy is reachable.
  const findRef = useRef(findAndAttach);
  findRef.current = findAndAttach;
  useEffect(() => {
    if (!hasSongPptProxy()) return;
    const pending = songs.find((song) => {
      const row = rows[song.id] ?? {};
      return (
        song.title.trim().length > 1 &&
        songSlideCount(song) === 0 &&
        !row.busy &&
        row.searchedTitle !== song.title.trim()
      );
    });
    if (!pending) return;
    // A pause, so a title is searched for once it is typed, not per keystroke.
    const timer = setTimeout(() => void findRef.current(pending), 900);
    return () => clearTimeout(timer);
  }, [songs, rows]);

  const upload = async (song: WednesdaySong, files: FileList | null) => {
    const picked = [...(files ?? [])];
    if (picked.length === 0) return;
    try {
      const deckFile = picked.find((file) => /\.pptx$/i.test(file.name));
      if (deckFile) {
        const loaded = await readUploadedSongDeck(deckFile);
        attachDeck(song, {
          deck: loaded.deck,
          slideCount: loaded.slideCount,
          origin: 'upload',
          fileName: loaded.fileName,
        });
      } else {
        const images = await readUploadedSheetImages(picked);
        attachImages(song, images.map(imageOf), false);
      }
      patchRow(song.id, { message: undefined, pptCandidates: undefined, sheetCandidates: undefined });
    } catch (error) {
      patchRow(song.id, {
        message: error instanceof Error ? error.message : '파일을 읽지 못했습니다.',
      });
    }
  };

  /**
   * Add a remembered song. Its stored address is carried over and, when the
   * proxy may fetch that host, the file is pulled straight away — otherwise
   * the card shows the link to open by hand.
   */
  const addFromLibrary = (entry: WednesdaySongEntry) => {
    const song: WednesdaySong = {
      ...blankWednesdaySong(entry.title),
      sourceUrl: entry.sourceUrl,
      sourceHost: entry.sourceHost,
    };
    onChange((current) => [...current, song]);
    setLibraryQuery('');
    if (entry.sourceUrl) void downloadDeckCandidate(song, { token: '', url: entry.sourceUrl });
  };

  return (
    <div className="wednesday-songs" data-testid="wednesday-songs">
      {songs.length === 0 && (
        <p className="empty-hint" data-testid="wednesday-songs-empty">
          이번 주 찬양을 추가하세요. 곡 제목만 적으면 인터넷에서 찬양 PPT나 악보 사진을 찾아 자동으로
          넣어 드립니다.
        </p>
      )}

      {songs.map((song, index) => {
        const row = rows[song.id] ?? {};
        const slideCount = songSlideCount(song);
        return (
          <section className="card wednesday-song" key={song.id} data-testid={`wednesday-song-${index}`}>
            <header className="wednesday-song-head">
              <span className="wednesday-song-index">{index + 1}</span>
              <input
                className="wednesday-song-title"
                type="text"
                value={song.title}
                placeholder="곡 제목 (예: 나의 반석이신 하나님)"
                aria-label={`${index + 1}번째 찬양 제목`}
                data-testid={`wednesday-song-title-${index}`}
                onChange={(event) => updateSong(song.id, { title: event.target.value })}
              />
              <div className="wednesday-song-tools">
                <button
                  type="button"
                  className="btn btn-icon"
                  aria-label="위로"
                  disabled={index === 0}
                  data-testid={`wednesday-song-up-${index}`}
                  onClick={() => moveSong(song.id, -1)}
                >
                  <Icon name="up" />
                </button>
                <button
                  type="button"
                  className="btn btn-icon"
                  aria-label="아래로"
                  disabled={index === songs.length - 1}
                  data-testid={`wednesday-song-down-${index}`}
                  onClick={() => moveSong(song.id, 1)}
                >
                  <Icon name="down" />
                </button>
                <button
                  type="button"
                  className="btn btn-icon"
                  aria-label="삭제"
                  data-testid={`wednesday-song-remove-${index}`}
                  onClick={() => removeSong(song.id)}
                >
                  <Icon name="trash" />
                </button>
              </div>
            </header>

            {row.busy && (
              <p className="empty-hint" data-testid={`wednesday-song-busy-${index}`}>
                {row.busy === 'searching' ? '인터넷에서 찾는 중…' : '받는 중…'}
              </p>
            )}

            {song.deck && (
              <p className="wednesday-song-file" data-testid={`wednesday-song-file-${index}`}>
                <Icon name="file" />
                <span>
                  {song.fileName ?? '찬양.pptx'} · 슬라이드 {slideCount}장
                  {song.origin === 'download' ? ' · 인터넷에서 받음' : ' · 직접 올림'}
                </span>
                {song.sourceUrl && (
                  <a href={song.sourceUrl} target="_blank" rel="noreferrer noopener">
                    출처 열기
                  </a>
                )}
              </p>
            )}

            {(song.images?.length ?? 0) > 0 && (
              <>
                <p className="wednesday-song-file" data-testid={`wednesday-song-sheets-${index}`}>
                  <Icon name="slide" />
                  <span>
                    악보 사진 {song.images!.length}장 · 슬라이드 {slideCount}장
                    {song.origin === 'download' ? ' · 인터넷에서 받음' : ' · 직접 올림'}
                  </span>
                </p>
                <ul className="wednesday-sheets" data-testid={`wednesday-song-sheet-list-${index}`}>
                  {song.images!.map((image, imageIndex) => (
                    <li key={image.id}>
                      <SheetThumbnail image={image} />
                      <span className="wednesday-sheet-name">
                        {imageIndex + 1}. {image.name}
                      </span>
                      <button
                        type="button"
                        className="btn btn-icon"
                        aria-label={`${imageIndex + 1}번째 악보 사진 삭제`}
                        data-testid={`wednesday-song-sheet-remove-${index}-${imageIndex}`}
                        onClick={() => removeImage(song, image.id)}
                      >
                        <Icon name="close" />
                      </button>
                    </li>
                  ))}
                </ul>
              </>
            )}

            {!row.busy && slideCount === 0 && (
              <p className="empty-hint">
                아직 슬라이드가 없습니다. 제목을 적으면 자동으로 찾고, 못 찾으면 직접 올리시면 됩니다.
              </p>
            )}

            <div className="wednesday-song-actions">
              {hasSongPptProxy() && (
                <button
                  type="button"
                  className="btn"
                  disabled={!!row.busy}
                  data-testid={`wednesday-song-search-${index}`}
                  onClick={() => void findAndAttach(song)}
                >
                  <Icon name="search" />
                  <span className="btn-label">{slideCount > 0 ? '다시 찾기' : '인터넷에서 찾기'}</span>
                </button>
              )}
              <button
                type="button"
                className="btn"
                data-testid={`wednesday-song-upload-${index}`}
                onClick={() => fileInputs.current[song.id]?.click()}
              >
                <Icon name="upload" />
                <span className="btn-label">PPT·악보 사진 올리기</span>
              </button>
              <input
                ref={(element) => {
                  fileInputs.current[song.id] = element;
                }}
                type="file"
                accept={SONG_FILE_ACCEPT}
                multiple
                hidden
                data-testid={`wednesday-song-input-${index}`}
                onChange={(event) => {
                  void upload(song, event.target.files);
                  event.target.value = '';
                }}
              />
            </div>

            {(row.pptCandidates?.length ?? 0) > 0 && (
              <ul className="wednesday-candidates" data-testid={`wednesday-song-candidates-${index}`}>
                {row.pptCandidates!.map((candidate) => (
                  <li key={candidate.token || candidate.url}>
                    <button
                      type="button"
                      className="btn btn-ghost"
                      disabled={!!row.busy}
                      onClick={() => void downloadDeckCandidate(song, candidate)}
                    >
                      <Icon name="download" />
                      <span className="btn-label">
                        {candidate.title || candidate.url} <em>{candidate.host}</em>
                        {candidate.direct ? ' · pptx' : ' · 게시글'}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}

            {(row.sheetCandidates?.length ?? 0) > 0 && (
              <ul
                className="wednesday-candidates"
                data-testid={`wednesday-song-sheet-candidates-${index}`}
              >
                {row.sheetCandidates!.map((candidate) => (
                  <li key={candidate.token || candidate.url}>
                    <button
                      type="button"
                      className="btn btn-ghost"
                      disabled={!!row.busy}
                      onClick={() => void downloadSheetCandidate(song, candidate)}
                    >
                      <Icon name="plus" />
                      <span className="btn-label">
                        악보 사진 추가: {candidate.title || candidate.url} <em>{candidate.host}</em>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}

            {row.message && (
              <p className="banner banner-error" data-testid={`wednesday-song-message-${index}`}>
                <Icon name="warning" />
                <span className="banner-text">{row.message}</span>
              </p>
            )}
          </section>
        );
      })}

      <div className="wednesday-song-add-row">
        <button type="button" className="btn btn-primary" data-testid="wednesday-song-add" onClick={addSong}>
          <Icon name="plus" />
          <span className="btn-label">찬양 추가</span>
        </button>
      </div>

      <section className="card wednesday-library" data-testid="wednesday-library">
        <h3>수요예배 찬양 라이브러리</h3>
        <p className="field-hint">
          지금까지 쓴 곡과 그 자료를 받은 주소를 기억해 둡니다. 파일은 보관하지 않으니, 링크를 열어 다시
          내려받거나 제목으로 다시 찾으시면 됩니다.
        </p>
        <input
          className="wednesday-song-title"
          type="text"
          value={libraryQuery}
          placeholder="저장된 곡 검색"
          aria-label="저장된 곡 검색"
          data-testid="wednesday-library-search"
          onChange={(event) => setLibraryQuery(event.target.value)}
        />
        {library.length === 0 ? (
          <p className="empty-hint">아직 저장된 곡이 없습니다. 곡을 한 번 넣으면 여기에 쌓입니다.</p>
        ) : (
          <ul className="wednesday-library-list">
            {libraryMatches.map((entry) => (
              <li key={entry.title}>
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => addFromLibrary(entry)}
                  data-testid={`wednesday-library-add-${entry.title}`}
                >
                  <Icon name="plus" />
                  <span className="btn-label">
                    {entry.title}
                    {entry.sourceHost && <em>{entry.sourceHost}</em>}
                  </span>
                </button>
                {entry.sourceUrl && (
                  <a href={entry.sourceUrl} target="_blank" rel="noreferrer noopener">
                    출처 열기
                  </a>
                )}
              </li>
            ))}
            {libraryMatches.length === 0 && <li className="empty-hint">검색 결과가 없습니다.</li>}
          </ul>
        )}
      </section>
    </div>
  );
}
