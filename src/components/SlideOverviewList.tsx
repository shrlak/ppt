// Left-hand slide list for the 편집기 (PPT editor) view — a PowerPoint-style
// slide pane showing every slide in final deck order. 찬양/광고 rows are
// clickable and scroll the right-hand editor to that exact slide; the rest
// (front/prayer/bible/sermon/back) are informational, since they come from
// fixed templates or other wizard steps rather than being edited here.
import type { DeckOverviewItem } from '../lib/utils/deckOverview';

const KIND_ICON: Record<DeckOverviewItem['kind'], string> = {
  front: '🖼',
  'lyrics-title': '🎵',
  lyrics: '📝',
  prayer: '🙏',
  bible: '📖',
  sermon: '🎙',
  announcement: '📢',
  back: '🖼',
};

interface Props {
  items: DeckOverviewItem[];
  onSelectSong: (songId: string) => void;
  onSelectAnnouncement: () => void;
}

export default function SlideOverviewList({ items, onSelectSong, onSelectAnnouncement }: Props) {
  return (
    <aside className="slide-overview" data-testid="slide-overview">
      <h2 className="slide-overview-title">슬라이드</h2>
      {items.length === 0 ? (
        <p className="empty-hint">콘티나 광고를 입력하면 여기에 슬라이드 목록이 표시됩니다.</p>
      ) : (
        <ol className="slide-overview-list">
          {items.map((item, index) => {
            const clickable = item.kind === 'lyrics-title' || item.kind === 'lyrics' || item.kind === 'announcement';
            const content = (
              <>
                <span className="slide-overview-number">{index + 1}</span>
                <span className="slide-overview-icon" aria-hidden="true">
                  {KIND_ICON[item.kind]}
                </span>
                <span className="slide-overview-text">
                  <span className="slide-overview-label">{item.label}</span>
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
                    onClick={() =>
                      item.kind === 'announcement' ? onSelectAnnouncement() : onSelectSong(item.songId!)
                    }
                  >
                    {content}
                  </button>
                ) : (
                  <div className="slide-overview-static">{content}</div>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </aside>
  );
}
