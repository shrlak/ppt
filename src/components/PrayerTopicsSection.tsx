import { MAX_TOPICS_PER_SLIDE, parsePrayerTopics, planPrayerTopicPages } from '../lib/utils/prayerTopics';
import Icon from './Icon';

interface Props {
  value: string;
  onChange: (text: string) => void;
}

const PLACEHOLDER = `1. 회개와 마음의 정결
- 지난 한 주간 하나님보다 앞세웠던 생각과 욕심을 돌아보고 진심으로 회개하도록
- 정결하고 겸손한 마음으로 하나님 앞에 나아가도록

2. 예배를 위한 기도
- 모든 청년이 분주한 생각과 염려를 내려놓고 하나님께 마음을 집중하도록`;

/**
 * Paste the week's 기도제목 and they fill the 기도 준비 slide at the front of
 * the deck, shared out over as many copies of it as they need. The preview
 * lists each slide with the topics that land on it, exactly as the deck
 * will have them.
 */
export default function PrayerTopicsSection({ value, onChange }: Props) {
  const topics = value.trim() ? parsePrayerTopics(value) : [];
  const pages = planPrayerTopicPages(topics);

  return (
    <section className="card" data-testid="prayer-topics-section">
      <h3>기도제목</h3>
      <p className="tool-intro">
        맨 앞 기도 준비 슬라이드(&lsquo;지금은 기도로 예배를 준비하는 시간입니다.&rsquo;)에 들어갈 기도제목을
        붙여넣으세요 (선택). <code>1. 제목</code> 아래에 <code>- 내용</code>을 줄마다 적으면 제목은 굵게, 내용은
        글머리표로 들어갑니다. 한 장에 {MAX_TOPICS_PER_SLIDE}개까지 넣고, 4개면 2개씩 두 장으로 나눕니다. 글이 길어
        글자가 너무 작아지면 슬라이드를 더 늘립니다. 비워 두면 기도 준비 슬라이드는 지금 그대로입니다.
      </p>
      <textarea
        className="announcement-textarea"
        data-testid="prayer-topics-input"
        rows={12}
        aria-label="기도제목"
        placeholder={PLACEHOLDER}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      {value.trim() && (
        <div className="verse-preview" data-testid="prayer-topics-preview">
          {pages.length === 0 ? (
            <div className="verse-preview-item invalid">
              <Icon name="error" />
              <span>기도제목을 찾지 못했습니다. &quot;1. 제목&quot; 아래에 &quot;- 내용&quot;을 적어 주세요.</span>
            </div>
          ) : (
            <>
              <div className="verse-preview-item" data-testid="prayer-topics-summary">
                <Icon name="info" />
                <span>
                  기도제목 {topics.length}개 → 기도 준비 슬라이드 {pages.length}장
                </span>
              </div>
              {pages.map((page, index) => (
                <div key={index} className="verse-preview-item" data-testid="prayer-topics-page">
                  <Icon name="check" />
                  <span>
                    {index + 1}장 ({page.sz / 100}pt):{' '}
                    {page.blocks
                      .map((block, blockIndex) => {
                        const previous = blockIndex > 0 ? page.blocks[blockIndex - 1] : pages[index - 1]?.blocks.at(-1);
                        const continued = previous?.number === block.number;
                        return `${block.number}. ${block.title}${continued ? ' (이어서)' : ''}`;
                      })
                      .join(' · ')}
                  </span>
                </div>
              ))}
            </>
          )}
        </div>
      )}
    </section>
  );
}
