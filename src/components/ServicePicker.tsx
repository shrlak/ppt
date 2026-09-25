// The first screen of the PPT Generator: which kind of service is this deck
// for? Each kind is its own generator — the Sunday wizard lives on this page,
// 수요예배 on wednesday.html, 찬양집회 on praise.html and 수련회 on
// retreat.html. 주일예배 is the one built every week, so it gets the wide
// tile; the other three sit side by side under it.
import AppShell, { SERVICES, type ServiceId } from './AppShell';
import Icon from './Icon';

export type ServiceChoice = 'sunday';

const DETAILS: Record<ServiceId, { description: string; steps: string }> = {
  sunday: {
    description: '콘티 PDF 하나로 찬양·성경 말씀·설교·광고·추가 자료까지 한 번에 만듭니다.',
    steps: '6단계 · 매주 일요일',
  },
  wednesday: {
    description: '예배 정보와 찬양만 넣으면 수요예배 PPT와 썸네일을 함께 만듭니다.',
    steps: '3단계 · 매주 수요일',
  },
  praise: {
    description: '한글·영어 제목과 가사가 함께 들어간 찬양집회 PPT를 만듭니다. 자동 삭제되지 않습니다.',
    steps: '4단계',
  },
  retreat: {
    description: '수련회 콘티와 집회 순서로 집회마다 수련회 디자인의 PPT를 만듭니다. 자동 삭제되지 않습니다.',
    steps: '3단계',
  },
};

interface Props {
  onChoose: (choice: ServiceChoice) => void;
}

export default function ServicePicker({ onChoose }: Props) {
  return (
    <AppShell service={null}>
      <main id="main-content" className="launcher service-picker" data-testid="service-picker">
        <div className="launcher-intro">
          <p className="wizard-kicker">KCCP Media Team</p>
          <h1>어떤 PPT를 만들까요?</h1>
          <p>예배 종류를 고르면 필요한 단계만 차례로 안내합니다. 만든 PPT는 라이브러리에 자동으로 저장됩니다.</p>
        </div>
        <ul className="service-options">
          {SERVICES.map((service, index) => {
            const details = DETAILS[service.id];
            const body = (
              <>
                <span className="service-option-top">
                  <Icon name={service.icon} />
                  <span className="service-option-number" aria-hidden="true">
                    {String(index + 1).padStart(2, '0')}
                  </span>
                </span>
                <span className="service-option-text">
                  <span className="service-option-title">
                    {service.title}
                    <span className="service-option-english" lang="en">
                      {service.english}
                    </span>
                  </span>
                  <span className="service-option-description">{details.description}</span>
                </span>
                <span className="service-option-foot">
                  <span className="service-option-steps">{details.steps}</span>
                  <span className="service-option-go">
                    시작하기
                    <Icon name="next" />
                  </span>
                </span>
              </>
            );
            return (
              <li key={service.id} className={service.id === 'sunday' ? 'service-featured' : undefined}>
                {service.id === 'sunday' ? (
                  <button
                    type="button"
                    className="service-option"
                    data-testid="service-sunday"
                    onClick={() => onChoose('sunday')}
                  >
                    {body}
                  </button>
                ) : (
                  <a className="service-option" href={service.href} data-testid={`service-${service.id}`}>
                    {body}
                  </a>
                )}
              </li>
            );
          })}
        </ul>
      </main>
    </AppShell>
  );
}
