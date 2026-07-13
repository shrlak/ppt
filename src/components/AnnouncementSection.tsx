import { parseAnnouncements } from '../lib/utils/announcementBuilder';

interface Props {
  value: string;
  onChange: (text: string) => void;
}

/** Paste a numbered announcement list ("1. <title>\n...body...") and it's auto-numbered and split into slides. */
export default function AnnouncementSection({ value, onChange }: Props) {
  const items = value.trim() ? parseAnnouncements(value) : [];

  return (
    <section className="card">
      <h2>광고</h2>
      <p className="tool-intro" style={{ margin: '0 0 14px' }}>
        공지 내용을 <code>1. &lt;제목&gt;</code> 형식으로 붙여넣으면 번호를 다시 매겨 항목별로
        슬라이드를 만들어 드립니다 (선택).
      </p>
      <textarea
        className="announcement-textarea"
        data-testid="announcement-input"
        rows={8}
        placeholder={'1. <새가족 환영>\n오늘 처음 오신 분들을 환영합니다!\n\n2. <여름수련회 안내>\n...'}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      {value.trim() && (
        <div className="verse-preview" data-testid="announcement-preview">
          {items.length === 0 ? (
            <div className="verse-preview-item invalid">
              번호가 매겨진 항목을 찾지 못했습니다. &quot;1. &lt;제목&gt;&quot; 형식으로 입력해 주세요.
            </div>
          ) : (
            items.map((item, i) => (
              <div key={i} className="verse-preview-item">
                {i + 1}. &lt;{item.title}&gt; ({item.bodyLines.length}줄)
              </div>
            ))
          )}
        </div>
      )}
    </section>
  );
}
