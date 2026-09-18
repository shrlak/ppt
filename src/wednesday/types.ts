// The 수요예배 generator's inputs. Nothing here is read off a 콘티: the
// service details are typed in, and each song arrives as a whole .pptx whose
// slides are spliced in unchanged.

export interface WednesdayService {
  /** 예배 날짜 as YYYY-MM-DD (what <input type="date"> gives). */
  date: string;
  /** 설교 제목, on the 표지 and the 설교 구분 장. */
  sermonTitle: string;
  /** 설교자 성함, e.g. "고신석". */
  preacher: string;
  /** 설교자 직분, e.g. "목사". */
  preacherTitle: string;
  /** 성경 구절 범위 as typed: "시18:1-12" or "시편 18편 1-12절". */
  verseInput: string;
  /** How many verses share one 말씀 본문 slide. The service deck uses 3. */
  versesPerSlide: number;
}

export const DEFAULT_VERSES_PER_SLIDE = 3;

export function emptyWednesdayService(): WednesdayService {
  return {
    date: '',
    sermonTitle: '',
    preacher: '',
    preacherTitle: '목사',
    verseInput: '',
    versesPerSlide: DEFAULT_VERSES_PER_SLIDE,
  };
}

/** Where a song's .pptx came from, for the card's badge and the library. */
export type WednesdaySongOrigin = 'download' | 'upload';

export interface WednesdaySong {
  id: string;
  /** 곡 제목 as typed — it goes on the 찬양 제목 slide verbatim. */
  title: string;
  /**
   * The downloaded (or uploaded) 찬양 PPT. Every one of its slides is spliced
   * into the service deck, in its own order, right after the 찬양 제목 slide.
   * Empty until a file is attached, so a song can be listed by title first.
   */
  deck?: ArrayBuffer;
  /** Slides `deck` contributes, counted from the file itself. */
  slideCount?: number;
  origin?: WednesdaySongOrigin;
  /** Where the file was downloaded from — the only thing the library keeps. */
  sourceUrl?: string;
  sourceHost?: string;
  /** File name, shown on the card when the deck was uploaded by hand. */
  fileName?: string;
}

/** A song that can actually contribute slides. */
export interface AttachedWednesdaySong extends WednesdaySong {
  deck: ArrayBuffer;
  slideCount: number;
}

export function isAttached(song: WednesdaySong): song is AttachedWednesdaySong {
  return song.deck !== undefined && (song.slideCount ?? 0) > 0;
}
