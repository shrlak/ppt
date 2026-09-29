// 찬양 목록 — the 찬양집회 page's song list, on the left of every step.
//
// One row per song in conti order. Pressing a title takes the page to that
// song: its 영어 가사 card while that step is open, its 찬양 card otherwise.
// As the page scrolls, the row of the song at the top of the window is
// marked, so the list also says where on a long night of songs you are.
import { useEffect, useRef, useState } from 'react';
import type { Song } from '../lib/utils/types';

/** A card is the one being read while more of it than this shows below the window's top. */
const READ_EDGE_PX = 64;
/** How long the page must sit still after a jump before a scroll counts as the reader's own. */
const SETTLE_MS = 150;
/** The same, before the jump's scroll has even begun (its step may still be opening). */
const FIRST_SETTLE_MS = 600;

/**
 * The row just pressed. It stays marked while the page scrolls past the songs
 * above it, and when the song sits too near the bottom to reach the top — until
 * the reader scrolls on their own.
 */
interface Pin {
  prefix: string | null;
  /** Where the jump's scroll came to rest; null while it is still under way. */
  settledAt: number | null;
  timer: number;
}

function settleAfter(pin: Pin, ms: number): void {
  window.clearTimeout(pin.timer);
  pin.timer = window.setTimeout(() => {
    pin.settledAt = window.scrollY;
  }, ms);
}

interface Props {
  songs: Song[];
  /** English titles by song id, shown under the Korean one. */
  englishTitles: Record<string, string>;
  /**
   * The id prefix of the song cards on the open step (`${prefix}${song.id}`);
   * null while the open step shows no song cards.
   */
  anchorPrefix: string | null;
  onSelect: (songId: string) => void;
}

export default function PraiseSongList({ songs, englishTitles, anchorPrefix, onSelect }: Props) {
  const [current, setCurrent] = useState<string | null>(null);
  const listRef = useRef<HTMLElement>(null);
  const pinRef = useRef<Pin | null>(null);
  // The order is what the marker follows; a lyric typed into a song is not.
  const songIdsRef = useRef<string[]>([]);
  songIdsRef.current = songs.map((song) => song.id);
  const order = songIdsRef.current.join('\n');

  const unpin = () => {
    if (pinRef.current) window.clearTimeout(pinRef.current.timer);
    pinRef.current = null;
  };

  useEffect(() => {
    const pin = pinRef.current;
    // A jump may open another step; a step opened by hand ends the pin.
    if (pin && pin.settledAt === null) pin.prefix = anchorPrefix;
    else if (pin && pin.prefix !== anchorPrefix) unpin();
    if (!anchorPrefix || !order) {
      unpin();
      setCurrent(null);
      return;
    }

    let frame = 0;
    const measure = () => {
      frame = 0;
      if (pinRef.current) return;
      let found: string | null = null;
      for (const id of songIdsRef.current) {
        const card = document.getElementById(`${anchorPrefix}${id}`);
        if (!card) continue;
        const { top, bottom } = card.getBoundingClientRect();
        if (top >= window.innerHeight) break;
        if (bottom > READ_EDGE_PX) {
          found = id;
          break;
        }
      }
      setCurrent(found);
    };
    const schedule = () => {
      if (!frame) frame = window.requestAnimationFrame(measure);
    };
    const onScroll = () => {
      const pinned = pinRef.current;
      if (pinned) {
        if (pinned.settledAt === null) {
          settleAfter(pinned, SETTLE_MS);
          return;
        }
        if (Math.abs(window.scrollY - pinned.settledAt) < 2) return;
        unpin();
      }
      schedule();
    };
    // Wheel, touch, keys and clicks on the page are the reader taking over.
    const onInput = (event: Event) => {
      if (!pinRef.current) return;
      if (event.target instanceof Node && listRef.current?.contains(event.target)) return;
      unpin();
      schedule();
    };
    const onResize = () => {
      if (!pinRef.current) schedule();
    };
    const inputs = ['wheel', 'touchstart', 'keydown', 'pointerdown'] as const;

    measure();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onResize);
    for (const type of inputs) window.addEventListener(type, onInput, { passive: true });
    return () => {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onResize);
      for (const type of inputs) window.removeEventListener(type, onInput);
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, [anchorPrefix, order]);

  useEffect(() => () => {
    if (pinRef.current) window.clearTimeout(pinRef.current.timer);
  }, []);

  const select = (songId: string) => {
    unpin();
    const pin: Pin = { prefix: anchorPrefix, settledAt: null, timer: 0 };
    pinRef.current = pin;
    settleAfter(pin, FIRST_SETTLE_MS);
    setCurrent(songId);
    onSelect(songId);
  };

  return (
    <nav
      ref={listRef}
      className={`praise-song-list${songs.length === 0 ? ' is-empty' : ''}`}
      aria-label="찬양 목록"
      data-testid="praise-song-list"
    >
      <h2 className="praise-song-list-title">
        찬양 목록
        {songs.length > 0 && <span className="praise-song-list-count">{songs.length}곡</span>}
      </h2>
      {songs.length === 0 ? (
        <p className="empty-hint praise-song-list-empty">콘티를 올리거나 곡을 추가하면 여기에 찬양 순서가 나옵니다.</p>
      ) : (
        <ol className="praise-song-list-items">
          {songs.map((song, index) => {
            const title = song.title.trim() || '제목 없음';
            const english = englishTitles[song.id]?.trim() ?? '';
            return (
              <li key={song.id}>
                <button
                  type="button"
                  className="praise-song-list-item"
                  data-testid="praise-song-list-item"
                  aria-current={current === song.id ? 'true' : undefined}
                  title={english ? `${title} · ${english}` : title}
                  onClick={() => select(song.id)}
                >
                  <span className="praise-song-list-number" aria-hidden="true">
                    {index + 1}
                  </span>
                  <span className="praise-song-list-names">
                    <span className="praise-song-list-name">{title}</span>
                    {english && english !== title && (
                      <span className="praise-song-list-english" lang="en">
                        {english}
                      </span>
                    )}
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
      )}
    </nav>
  );
}
