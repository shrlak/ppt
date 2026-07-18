// Left-hand slide list for the 편집기 (PPT editor) view — a PowerPoint-style
// slide pane showing a real visual thumbnail of every slide in final deck
// order (from pptxRenderer.ts), not just a text label. 찬양/말씀/설교/광고 rows
// are clickable and scroll the right-hand editor to that exact section; the
// rest (front/prayer/back) are informational, since they come from fixed
// templates rather than being edited here. A toolbar above the list lets the
// whole deck be downloaded or saved to the 라이브러리 without leaving this view.
import type { DeckOverviewItem } from '../lib/utils/deckOverview';
import type { RenderedSlide } from '../lib/pptx/pptxRenderer';
import SlideThumbnail from './SlideThumbnail';

const KIND_ICON: Record<DeckOverviewItem['kind'], string> = {
  front: '🖼',
  'lyrics-title': '🎵',
  lyrics: '📝',
  prayer: '🙏',
  bible: '📖',
  sermon: '🎙',
  divider: '📌',
  announcement: '📢',
  back: '🖼',
};

const CLICKABLE_KINDS: ReadonlySet<DeckOverviewItem['kind']> = new Set(['lyrics-title', 'lyrics', 'bible', 'sermon', 'announcement']);

const THUMB_WIDTH = 248;

interface Props {
  overview: DeckOverviewItem[];
  slides: RenderedSlide[] | null;
  loading: boolean;
  error: string | null;
  onSelectSong: (songId: string) => void;
  onSelectBible: () => void;
  onSelectSermon: () => void;
  onSelectAnnouncement: () => void;
  onDownload: () => void;
  onSaveToLibrary: () => void;
  downloading: boolean;
  savingToLibrary: boolean;
}

export default function SlideOverviewList({
  overview,
  slides,
  loading,
  error,
  onSelectSong,
  onSelectBible,
  onSelectSermon,
  onSelectAnnouncement,
  onDownload,
  onSaveToLibrary,
  downloading,
  savingToLibrary,
}: Props) {
  return (
    <aside className="slide-overview" data-testid="slide-overview">
      <div className="slide-overview-header">
        <h2 className="slide-overview-title">슬라이드{slides ? ` (${slides.length})` : ''}</h2>
        <div className="slide-overview-actions">
          <button
            type="button"
            className="btn btn-primary"
            data-testid="editor-generate-pptx"
            disabled={downloading}
            onClick={onDownload}
          >
            {downloading ? '생성 중…' : '⬇ 다운로드'}
          </button>
          <button
            type="button"
            className="btn"
            data-testid="editor-save-to-library"
            disabled={savingToLibrary}
            onClick={onSaveToLibrary}
          >
            {savingToLibrary ? '저장 중…' : '📚 저장'}
          </button>
        </div>
      </div>
      {error && <p className="banner banner-warn slide-overview-error">{error}</p>}
      {overview.length === 0 && !loading ? (
        <p className="empty-hint">콘티나 광고를 입력하면 여기에 슬라이드 목록이 표시됩니다.</p>
      ) : (
        <ol className="slide-overview-list">
          {overview.map((item, index) => {
            const clickable = CLICKABLE_KINDS.has(item.kind);
            const body = (
              <>
                <SlideThumbnail slide={slides?.[index]} width={THUMB_WIDTH} />
                <span className="slide-overview-text">
                  <span className="slide-overview-text-top">
                    <span className="slide-overview-number">{index + 1}</span>
                    <span className="slide-overview-icon" aria-hidden="true">
                      {KIND_ICON[item.kind]}
                    </span>
                    <span className="slide-overview-label">{item.label}</span>
                  </span>
                  {item.subtitle && <span className="slide-overview-subtitle">{item.subtitle}</span>}
                </span>
              </>
            );
            return (
              <li
                key={item.id}
                className={`slide-overview-row${clickable ? ' clickable' : ''}`}
                data-testid={`slide-overview-row-${item.kind}`}
              >
                {clickable ? (
                  <button
                    type="button"
                    onClick={() => {
                      if (item.kind === 'announcement') onSelectAnnouncement();
                      else if (item.kind === 'bible') onSelectBible();
                      else if (item.kind === 'sermon') onSelectSermon();
                      else onSelectSong(item.songId!);
                    }}
                  >
                    {body}
                  </button>
                ) : (
                  <div className="slide-overview-static">{body}</div>
                )}
              </li>
            );
          })}
          {loading && (
            <li className="slide-overview-loading" data-testid="slide-overview-loading">
              슬라이드 생성 중…
            </li>
          )}
        </ol>
      )}
    </aside>
  );
}
