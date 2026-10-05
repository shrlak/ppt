// The 찬양 step: this week's songs, in order, each with the slides that go
// into the deck.
//
// A song is a title plus its slides, and the slides come from either its 찬양
// PPT or its 악보 사진 (one slide per page). Typing the title is enough: the
// app searches, downloads and attaches what it is sure about by itself. When
// it is not sure it shows what it found instead of guessing, and the upload
// button is always there — a source behind a login (네이버 카페) can never be
// automated, and a photo taken on a phone is nobody's search result.
//
// The quickest way in is the 악보 사진 drop at the top: one song per photo,
// in file-name order, each titled from its photo and searched for at once.
// The photo stays the song's slide unless a 찬양 PPT with the 악보 turns up,
// and even then it can be put back with one click.
//
// Cards are put in order by dragging them by their handle (or with the
// arrows beside it, which keyboards and screen readers use).
import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import Icon from '../components/Icon';
import { fetchBundledLibrary, loadUserLibrary } from '../lib/storage/library';
import { showToast } from '../lib/utils/toast';
import { groupPhotosBySong, readPhotoTitles, titleFromFileName } from './photoTitles';
import { dropIndex, moveSongTo } from './songOrder';
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
import { isAttached, songSlideCount, type WednesdaySong, type WednesdaySongImage } from './types';
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
  /**
   * 'reading' while the title is read off the song's photo, 'searching' while
   * the app looks the song up by itself.
   */
  busy?: 'reading' | 'searching' | 'downloading';
  pptCandidates?: SongPptCandidate[];
  sheetCandidates?: SheetImageCandidate[];
  message?: string;
  /** Worth knowing, but nothing went wrong. */
  notice?: string;
  /** The title the automatic search last ran for, so it runs once per title. */
  searchedTitle?: string;
  /**
   * Put in from the 악보 사진 drop: searched for as soon as its title is
   * known, although it already has its photo for slides.
   */
  photoSearch?: boolean;
  /** The operator's own photos a found 찬양 PPT took the place of, to put back. */
  replacedPhotos?: WednesdaySongImage[];
}

/** What the 악보 사진 drop takes. */
const PHOTO_ACCEPT = '.png,.jpg,.jpeg';
const isPhotoFile = (file: File) => /\.(png|jpe?g)$/i.test(file.name);
/** File-name order, numbers by value: 2.jpg before 10.jpg, a messenger's timestamps in time order. */
const byFileName = (a: File, b: File) => a.name.localeCompare(b.name, 'ko', { numeric: true });

const BASE = import.meta.env.BASE_URL || '/';

/** A card being dragged: which, how far it has moved, and where it would land. */
interface DragState {
  id: string;
  pointerId: number;
  from: number;
  /** Each card's vertical middle when the drag began, from the list's top. */
  middles: number[];
  /** The pointer's distance from the list's top when the drag began. */
  startY: number;
  offset: number;
  target: number;
  /** The dragged card's height and the gap after it: how far the others step aside. */
  room: number;
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
  const photoInput = useRef<HTMLInputElement | null>(null);
  const [photoDragging, setPhotoDragging] = useState(false);
  const [photoStatus, setPhotoStatus] = useState<string>();
  const listRef = useRef<HTMLDivElement | null>(null);
  const cardRefs = useRef<Record<string, HTMLElement | null>>({});
  const [drag, setDrag] = useState<DragState | null>(null);
  const dragRef = useRef<DragState | null>(null);

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
      return moveSongTo(current, id, next);
    });
  };

  // ---- dragging a card by its handle ----
  // Pointer events rather than HTML drag and drop, so a finger on a phone
  // drags as well as a mouse does. Positions are measured from the list's top,
  // which keeps them right when the page scrolls under the drag.
  const listTop = () => listRef.current?.getBoundingClientRect().top ?? 0;

  const startDrag = (event: ReactPointerEvent<HTMLButtonElement>, id: string, index: number) => {
    if (event.button !== 0 || songs.length < 2) return;
    event.preventDefault();
    const top = listTop();
    const middles = songs.map((song) => {
      const rect = cardRefs.current[song.id]?.getBoundingClientRect();
      return rect ? rect.top - top + rect.height / 2 : 0;
    });
    const gap = listRef.current ? parseFloat(getComputedStyle(listRef.current).rowGap) || 0 : 0;
    event.currentTarget.setPointerCapture(event.pointerId);
    const state: DragState = {
      id,
      pointerId: event.pointerId,
      from: index,
      middles,
      startY: event.clientY - top,
      offset: 0,
      target: index,
      room: (cardRefs.current[id]?.getBoundingClientRect().height ?? 0) + gap,
    };
    dragRef.current = state;
    setDrag(state);
  };

  const moveDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const state = dragRef.current;
    if (!state || event.pointerId !== state.pointerId) return;
    const offset = event.clientY - listTop() - state.startY;
    const next = { ...state, offset, target: dropIndex(state.middles, state.from, state.middles[state.from] + offset) };
    dragRef.current = next;
    setDrag(next);
    // Near the window's edge, the page follows the card.
    const edge = 72;
    if (event.clientY < edge) window.scrollBy(0, -16);
    else if (event.clientY > window.innerHeight - edge) window.scrollBy(0, 16);
  };

  const endDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const state = dragRef.current;
    if (!state || event.pointerId !== state.pointerId) return;
    dragRef.current = null;
    setDrag(null);
    if (state.target !== state.from) onChange((current) => moveSongTo(current, state.id, state.target));
  };

  // While a card is dragged, the pointer sweeping over the page must not
  // select its text.
  const dragging = drag !== null;
  useEffect(() => {
    if (!dragging) return;
    window.getSelection()?.removeAllRanges();
    document.documentElement.classList.add('reordering');
    return () => document.documentElement.classList.remove('reordering');
  }, [dragging]);

  /** How far a card is drawn from its place while another is dragged past it. */
  const dragShift = (id: string, index: number): number => {
    if (!drag) return 0;
    if (id === drag.id) return drag.offset;
    if (drag.from < index && index <= drag.target) return -drag.room;
    if (drag.target <= index && index < drag.from) return drag.room;
    return 0;
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

  /** The operator's own 악보 사진, when they are what the song shows now. */
  const ownPhotosOf = (song: WednesdaySong): WednesdaySongImage[] | undefined =>
    !song.deck && song.origin === 'upload' && (song.images?.length ?? 0) > 0 ? song.images : undefined;

  /**
   * After a 찬양 PPT takes the place of the operator's photos: keep the photos
   * to put back, and say so. A PPT replacing another PPT keeps the photos the
   * first one replaced.
   */
  const photoSwap = (song: WednesdaySong, ownPhotos: WednesdaySongImage[] | undefined): RowState => {
    const photos = ownPhotos ?? rows[song.id]?.replacedPhotos;
    return photos
      ? { replacedPhotos: photos, notice: '악보가 있는 찬양 PPT를 올린 사진 대신 넣었습니다.' }
      : { replacedPhotos: undefined, notice: undefined };
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
    const ownPhotos = ownPhotosOf(song);
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
      patchRow(song.id, {
        busy: undefined,
        pptCandidates: undefined,
        sheetCandidates: undefined,
        ...photoSwap(song, ownPhotos),
      });
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
      notice: undefined,
      pptCandidates: undefined,
      sheetCandidates: undefined,
      searchedTitle: title,
    });

    // The operator's own photo is only given up for a 찬양 PPT with the 악보,
    // never for someone else's photo of the page.
    const ownPhotos = ownPhotosOf(song);
    const found = await autoAttachSong(title, undefined, { sheets: !ownPhotos });
    if (found.kind === 'deck') {
      attachDeck(song, {
        deck: found.deck.deck,
        slideCount: found.deck.slideCount,
        origin: 'download',
        sourceUrl: found.candidate.url,
        sourceHost: found.candidate.host,
        fileName: found.deck.fileName,
      });
      patchRow(song.id, { busy: undefined, ...photoSwap(song, ownPhotos) });
      return;
    }
    if (ownPhotos) {
      const offered = found.kind === 'none' ? found.pptCandidates : [];
      patchRow(song.id, {
        busy: undefined,
        pptCandidates: offered,
        notice:
          offered.length > 0
            ? '확실한 찬양 PPT가 없어 올린 악보 사진을 그대로 씁니다. 찾은 PPT로 바꾸려면 아래에서 고르세요.'
            : '인터넷에서 찬양 PPT를 찾지 못해 올린 악보 사진을 그대로 씁니다.',
      });
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
  // on its own, once per title, and only while the proxy is reachable. So does
  // a song put in from its photo, as soon as its title is read (or typed).
  const findRef = useRef(findAndAttach);
  findRef.current = findAndAttach;
  useEffect(() => {
    if (!hasSongPptProxy()) return;
    const pending = songs.find((song) => {
      const row = rows[song.id] ?? {};
      return (
        song.title.trim().length > 1 &&
        (songSlideCount(song) === 0 || row.photoSearch) &&
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

  /** Put back the operator's own photos a found 찬양 PPT took the place of. */
  const restorePhotos = (song: WednesdaySong) => {
    const photos = rows[song.id]?.replacedPhotos;
    if (!photos) return;
    updateSong(song.id, {
      deck: undefined,
      slideCount: undefined,
      fileName: undefined,
      sourceUrl: undefined,
      sourceHost: undefined,
      images: photos,
      origin: 'upload',
    });
    // Back to the photo for good: changing the title later does not swap it again.
    patchRow(song.id, { replacedPhotos: undefined, photoSearch: false, notice: undefined });
  };

  /** Titles a reading may stand for: this list's library, and the 찬양 라이브러리's. */
  const knownTitles = async (): Promise<string[]> => {
    const lyrics = [...(await fetchBundledLibrary(BASE)), ...loadUserLibrary()];
    return [...library.map((entry) => entry.title), ...lyrics.map((entry) => entry.title)];
  };

  /**
   * One song per 악보 사진: each photo becomes a song's slide at once, its
   * title is read off the page, and the search starts as soon as it is known.
   * Two photos in a row read as the same song are its two pages.
   */
  const addPhotoSongs = async (files: FileList | File[] | null) => {
    const picked = [...(files ?? [])];
    const photos = picked.filter(isPhotoFile).sort(byFileName);
    if (photos.length === 0) {
      if (picked.length > 0) showToast('악보 사진은 PNG·JPG 파일만 올릴 수 있습니다.', 'error');
      return;
    }
    if (photos.length < picked.length) showToast('PNG·JPG가 아닌 파일은 빼고 넣었습니다.', 'warn');

    let loaded: LoadedSheetImage[];
    try {
      loaded = await readUploadedSheetImages(photos);
    } catch (error) {
      showToast(error instanceof Error ? error.message : '사진을 읽지 못했습니다.', 'error');
      return;
    }

    const created = loaded.map(
      (photo): WednesdaySong => ({ ...blankWednesdaySong(), images: [imageOf(photo)], origin: 'upload' }),
    );
    // Empty cards (no title, nothing attached) were waiting for exactly this.
    onChange((current) => [...current.filter((song) => song.title.trim() || isAttached(song)), ...created]);
    setRows((current) => ({
      ...current,
      ...Object.fromEntries(created.map((song) => [song.id, { busy: 'reading' as const, photoSearch: true }])),
    }));
    setPhotoStatus(`악보 사진 ${loaded.length}장에서 곡 제목을 읽는 중…`);

    const { titles, error } = await readPhotoTitles(loaded, await knownTitles().catch(() => []));
    const named = titles.map((title, index) => title ?? titleFromFileName(loaded[index].name));
    const groups = groupPhotosBySong(named);

    onChange((current) => {
      let next = current;
      for (const members of groups) {
        const [first, ...rest] = members.map((index) => created[index]);
        const title = named[members[0]] ?? '';
        const pages = rest.flatMap((song) => song.images ?? []);
        next = next
          .filter((song) => !rest.some((other) => other.id === song.id))
          .map((song) =>
            song.id === first.id
              ? { ...song, title: song.title.trim() ? song.title : title, images: [...(song.images ?? []), ...pages] }
              : song,
          );
      }
      return next;
    });
    setRows((current) => {
      const next = { ...current };
      for (const members of groups) {
        const [first, ...rest] = members.map((index) => created[index].id);
        for (const id of rest) delete next[id];
        next[first] = {
          ...next[first],
          busy: undefined,
          message: named[members[0]]
            ? undefined
            : '사진에서 곡 제목을 읽지 못했습니다. 제목을 적어 주시면 바로 찾아 드립니다.',
        };
      }
      return next;
    });
    setPhotoStatus(undefined);
    if (error && named.some((title) => !title)) showToast(`곡 제목을 읽지 못했습니다: ${error}`, 'warn');
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
      <section className="wednesday-photo-drop" data-testid="wednesday-photo-drop">
        <button
          type="button"
          className={`dropzone${photoDragging ? ' dragover' : ''}`}
          disabled={!!photoStatus}
          data-testid="wednesday-photo-dropzone"
          onClick={() => photoInput.current?.click()}
          onDragEnter={() => setPhotoDragging(true)}
          onDragLeave={() => setPhotoDragging(false)}
          onDragOver={(event) => {
            event.preventDefault();
            setPhotoDragging(true);
          }}
          onDrop={(event) => {
            event.preventDefault();
            setPhotoDragging(false);
            void addPhotoSongs(event.dataTransfer.files);
          }}
        >
          <span className="dropzone-title">
            <Icon name="upload" />
            악보 사진으로 곡 한꺼번에 넣기
          </span>
          <span className="dropzone-sub">
            이번 주 곡의 악보 사진을 한꺼번에 끌어다 놓거나 눌러서 고르세요. 사진 한 장이 곡 하나가 되고,
            사진에서 곡 제목을 읽어 채운 뒤 바로 인터넷에서 찬양 PPT를 찾습니다.
          </span>
        </button>
        <input
          ref={photoInput}
          type="file"
          accept={PHOTO_ACCEPT}
          multiple
          className="visually-hidden-input"
          tabIndex={-1}
          data-testid="wednesday-photo-input"
          onChange={(event) => {
            void addPhotoSongs(event.target.files);
            event.target.value = '';
          }}
        />
        {photoStatus && (
          <p className="additional-files-status" role="status" data-testid="wednesday-photo-status">
            <span className="spinner" aria-hidden="true" />
            {photoStatus}
          </p>
        )}
      </section>

      {songs.length === 0 && (
        <p className="empty-hint" data-testid="wednesday-songs-empty">
          이번 주 찬양을 추가하세요. 악보 사진을 위에 올리거나, 곡 제목만 적어도 인터넷에서 찬양 PPT나 악보
          사진을 찾아 자동으로 넣어 드립니다.
        </p>
      )}

      {songs.length > 1 && (
        <p className="field-hint wednesday-order-hint">
          곡 순서는 카드 왼쪽의 손잡이(⋮⋮)를 끌어서 바꾸거나, 오른쪽 위·아래 버튼으로 바꿀 수 있습니다.
        </p>
      )}

      <div className="wednesday-song-cards" ref={listRef}>
        {songs.map((song, index) => {
          const row = rows[song.id] ?? {};
          const slideCount = songSlideCount(song);
          const shift = dragShift(song.id, index);
          const lifted = drag?.id === song.id;
          return (
            <section
              className={`card wednesday-song${lifted ? ' dragging' : ''}${drag && !lifted ? ' making-room' : ''}`}
              key={song.id}
              ref={(element) => {
                cardRefs.current[song.id] = element;
              }}
              style={shift ? { transform: `translateY(${shift}px)` } : undefined}
              data-testid={`wednesday-song-${index}`}
            >
              <header className="wednesday-song-head">
                <button
                  type="button"
                  className="btn btn-icon wednesday-song-grip"
                  aria-label={`${index + 1}번째 곡 순서 바꾸기 (끌어서 옮기기)`}
                  title="끌어서 순서 바꾸기"
                  disabled={songs.length < 2}
                  data-testid={`wednesday-song-grip-${index}`}
                  onPointerDown={(event) => startDrag(event, song.id, index)}
                  onPointerMove={moveDrag}
                  onPointerUp={endDrag}
                  onPointerCancel={endDrag}
                  onKeyDown={(event) => {
                    // The handle moves its card with the arrow keys too.
                    if (event.key === 'ArrowUp' && index > 0) {
                      event.preventDefault();
                      moveSong(song.id, -1);
                    } else if (event.key === 'ArrowDown' && index < songs.length - 1) {
                      event.preventDefault();
                      moveSong(song.id, 1);
                    }
                  }}
                >
                  <Icon name="grip" />
                </button>
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
                  {row.busy === 'reading'
                    ? '사진에서 곡 제목을 읽는 중…'
                    : row.busy === 'searching'
                      ? '인터넷에서 찾는 중…'
                      : '받는 중…'}
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
                  {/* Google's results come first, in Google's order (see inSearchOrder),
                      each marked with where Google listed it and a link to look first. */}
                  {row.pptCandidates!.map((candidate) => (
                    <li key={candidate.token || candidate.url}>
                      {candidate.google != null && (
                        <span className="chip wednesday-candidate-rank" title="구글 검색에서 나온 순서">
                          구글 {candidate.google}위
                        </span>
                      )}
                      <button
                        type="button"
                        className="btn btn-ghost"
                        disabled={!!row.busy}
                        title={candidate.title || candidate.url}
                        onClick={() => void downloadDeckCandidate(song, candidate)}
                      >
                        <Icon name="download" />
                        <span className="btn-label">
                          {candidate.title || candidate.url} <em>{candidate.host}</em>
                          {candidate.direct ? ' · pptx' : ' · 게시글'}
                        </span>
                      </button>
                      <a href={candidate.url} target="_blank" rel="noreferrer noopener">
                        열기
                      </a>
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

              {row.notice && (
                <p className="banner banner-notice" data-testid={`wednesday-song-notice-${index}`}>
                  <Icon name="info" />
                  <span className="banner-text">{row.notice}</span>
                  {row.replacedPhotos && (
                    <button
                      type="button"
                      data-testid={`wednesday-song-restore-photos-${index}`}
                      onClick={() => restorePhotos(song)}
                    >
                      올린 사진으로 되돌리기
                    </button>
                  )}
                </p>
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
      </div>

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
