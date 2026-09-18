// The 찬양 step: this week's songs, in order, each with the .pptx whose slides
// go into the deck.
//
// A song is a title plus a file. The title is typed (there is no 콘티 to read
// it off), and the file arrives either by searching the web through the proxy
// or by being uploaded after the operator downloaded it themselves — the
// search cannot reach sites that need a login, so the upload button always
// sits next to it.
import { useEffect, useMemo, useRef, useState } from 'react';
import Icon from '../components/Icon';
import { showToast } from '../lib/utils/toast';
import {
  downloadSongPpt,
  hasSongPptProxy,
  hostOf,
  readUploadedSongDeck,
  searchSongPpt,
  type SongPptCandidate,
} from './songSource';
import type { WednesdaySong } from './types';
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
  /** Called when a song's file is dropped, so the draft can forget it. */
  onForgetDeck?: (id: string) => void;
}

interface RowState {
  searching?: boolean;
  downloading?: boolean;
  candidates?: SongPptCandidate[];
  message?: string;
}

export function blankWednesdaySong(title = ''): WednesdaySong {
  return { id: crypto.randomUUID(), title };
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

  /** Remember the song and where its PPT came from, for the weeks after this one. */
  const remember = (song: WednesdaySong, patch: Partial<WednesdaySong>) => {
    const title = (patch.title ?? song.title).trim();
    if (!title) return;
    void saveSongEntry({
      title,
      sourceUrl: patch.sourceUrl,
      sourceHost: patch.sourceHost,
      slideCount: patch.slideCount,
    }).then(setLibrary);
  };

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
    if (entry.sourceUrl) void download(song, { token: '', url: entry.sourceUrl });
  };

  const search = async (song: WednesdaySong) => {
    if (!song.title.trim()) {
      showToast('곡 제목을 먼저 입력해 주세요.', 'error');
      return;
    }
    patchRow(song.id, { searching: true, candidates: undefined, message: undefined });
    const result = await searchSongPpt(song.title);
    patchRow(song.id, {
      searching: false,
      candidates: result.candidates,
      message:
        result.candidates.length > 0
          ? undefined
          : (result.message ??
            '찬양 PPT를 찾지 못했습니다. 직접 내려받아 파일을 올려 주세요.'),
    });
  };

  const download = async (song: WednesdaySong, candidate: Pick<SongPptCandidate, 'token' | 'url'> & Partial<SongPptCandidate>) => {
    patchRow(song.id, { downloading: true, message: undefined });
    try {
      const loaded = await downloadSongPpt(candidate);
      const patch = {
        deck: loaded.deck,
        slideCount: loaded.slideCount,
        origin: 'download' as const,
        sourceUrl: candidate.url,
        sourceHost: candidate.host ?? hostOf(candidate.url),
        fileName: loaded.fileName,
      };
      updateSong(song.id, patch);
      remember(song, patch);
      patchRow(song.id, { downloading: false, candidates: undefined });
    } catch (error) {
      patchRow(song.id, {
        downloading: false,
        message: error instanceof Error ? error.message : '찬양 PPT를 받지 못했습니다.',
      });
    }
  };

  const upload = async (song: WednesdaySong, file: File | undefined) => {
    if (!file) return;
    try {
      const loaded = await readUploadedSongDeck(file);
      const patch = {
        deck: loaded.deck,
        slideCount: loaded.slideCount,
        origin: 'upload' as const,
        fileName: loaded.fileName,
        // An uploaded file has no address to keep; a previously stored one
        // stays in the library untouched.
        sourceUrl: song.sourceUrl,
        sourceHost: song.sourceHost,
      };
      updateSong(song.id, patch);
      remember(song, patch);
      patchRow(song.id, { candidates: undefined, message: undefined });
    } catch (error) {
      patchRow(song.id, {
        message: error instanceof Error ? error.message : '파일을 읽지 못했습니다.',
      });
    }
  };

  return (
    <div className="wednesday-songs" data-testid="wednesday-songs">
      {songs.length === 0 && (
        <p className="empty-hint" data-testid="wednesday-songs-empty">
          이번 주 찬양을 추가하세요. 곡 제목을 적고 찬양 PPT를 받아 오면, 그 파일의 모든 슬라이드가
          찬양 제목 장 뒤에 그대로 들어갑니다.
        </p>
      )}

      {songs.map((song, index) => {
        const row = rows[song.id] ?? {};
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

            {song.deck ? (
              <p className="wednesday-song-file" data-testid={`wednesday-song-file-${index}`}>
                <Icon name="file" />
                <span>
                  {song.fileName ?? '찬양.pptx'} · 슬라이드 {song.slideCount}장
                  {song.origin === 'download' ? ' · 인터넷에서 받음' : ' · 직접 올림'}
                </span>
                {song.sourceUrl && (
                  <a href={song.sourceUrl} target="_blank" rel="noreferrer noopener">
                    출처 열기
                  </a>
                )}
              </p>
            ) : (
              <p className="empty-hint">아직 찬양 PPT가 없습니다. 찬양 제목 장만 들어갑니다.</p>
            )}

            <div className="wednesday-song-actions">
              {hasSongPptProxy() && (
                <button
                  type="button"
                  className="btn"
                  disabled={row.searching || row.downloading}
                  data-testid={`wednesday-song-search-${index}`}
                  onClick={() => void search(song)}
                >
                  <Icon name="search" />
                  <span className="btn-label">{row.searching ? '찾는 중…' : '인터넷에서 찾기'}</span>
                </button>
              )}
              <button
                type="button"
                className="btn"
                data-testid={`wednesday-song-upload-${index}`}
                onClick={() => fileInputs.current[song.id]?.click()}
              >
                <Icon name="upload" />
                <span className="btn-label">{song.deck ? '파일 바꾸기' : '파일 올리기'}</span>
              </button>
              <input
                ref={(element) => {
                  fileInputs.current[song.id] = element;
                }}
                type="file"
                accept=".pptx"
                hidden
                data-testid={`wednesday-song-input-${index}`}
                onChange={(event) => {
                  void upload(song, event.target.files?.[0]);
                  event.target.value = '';
                }}
              />
            </div>

            {row.candidates && row.candidates.length > 0 && (
              <ul className="wednesday-candidates" data-testid={`wednesday-song-candidates-${index}`}>
                {row.candidates.map((candidate) => (
                  <li key={candidate.token}>
                    <button
                      type="button"
                      className="btn btn-ghost"
                      disabled={row.downloading}
                      onClick={() => void download(song, candidate)}
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
          지금까지 쓴 곡과 그 PPT를 받은 주소를 기억해 둡니다. 파일은 보관하지 않으니, 링크를 열어 다시
          내려받아 올려 주세요.
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
