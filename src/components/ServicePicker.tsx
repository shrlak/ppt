// The first screen of the PPT Generator: which kind of service is this deck
// for? Each kind is its own generator — the Sunday wizard lives on this page,
// 찬양집회 on praise.html and 수련회 on retreat.html.
import Icon, { type IconName } from './Icon';

const BASE: string = import.meta.env.BASE_URL || '/';

export type ServiceChoice = 'sunday';

interface Option {
  id: 'sunday' | 'praise' | 'retreat';
  title: string;
  english: string;
  description: string;
  icon: IconName;
}

const OPTIONS: Option[] = [
  {
    id: 'sunday',
    title: '주일예배',
    english: 'Sunday Service',
    description: '콘티 PDF로 찬양·성경 말씀·설교·광고까지 한 번에 만듭니다.',
    icon: 'bible',
  },
  {
    id: 'praise',
    title: '찬양집회',
    english: 'Praise Night',
    description: '콘티를 올리면 한글·영어 제목과 가사가 함께 들어간 PPT를 만듭니다. 자동 삭제되지 않습니다.',
    icon: 'music',
  },
  {
    id: 'retreat',
    title: '수련회',
    english: 'Retreat',
    description: '수련회 콘티와 집회 순서로 집회마다 수련회 디자인의 PPT를 만듭니다. 자동 삭제되지 않습니다.',
    icon: 'steps',
  },
];

interface Props {
  onChoose: (choice: ServiceChoice) => void;
}

export default function ServicePicker({ onChoose }: Props) {
  return (
    <>
      <header className="header">
        <div className="header-inner">
          <div className="header-brand">
            <img
              className="header-logo"
              src={`${BASE}logo.png`}
              alt="KCCP 빛주사랑 대학청년부 Media Team 로고"
            />
            <div className="header-text">
              <h1>KCCP PPT Generator</h1>
              <p>만들 PPT의 예배 종류를 고르세요.</p>
            </div>
          </div>
        </div>
      </header>
      <main id="main-content" className="app service-picker" data-testid="service-picker">
        <h2>어떤 PPT를 만들까요?</h2>
        <ul className="service-options">
          {OPTIONS.map((option, index) => {
            const body = (
              <>
                <span className="service-option-number" aria-hidden="true">
                  {String(index + 1).padStart(2, '0')}
                </span>
                <Icon name={option.icon} />
                <span className="service-option-text">
                  <span className="service-option-title">
                    {option.title}
                    <span className="service-option-english">{option.english}</span>
                  </span>
                  <span className="service-option-description">{option.description}</span>
                </span>
              </>
            );
            return (
              <li key={option.id}>
                {option.id === 'sunday' ? (
                  <button
                    type="button"
                    className="service-option"
                    data-testid="service-sunday"
                    onClick={() => onChoose('sunday')}
                  >
                    {body}
                  </button>
                ) : (
                  <a className="service-option" href={`${BASE}${option.id}.html`} data-testid={`service-${option.id}`}>
                    {body}
                  </a>
                )}
              </li>
            );
          })}
        </ul>
        <p className="service-picker-footnote">
          수요예배 PPT는{' '}
          <a href={`${BASE}wednesday.html`} data-testid="service-wednesday">
            수요예배 생성기
          </a>
          에서 만들 수 있습니다.
        </p>
      </main>
    </>
  );
}
