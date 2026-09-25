// The one frame every generator page sits in. A dark "cover" rail on the left
// holds the brand, the four services, this generator's steps and its tools;
// the working page sits on the right. On narrow screens the rail folds up
// into a block above the page. Keeping the frame in one place means the four
// generators can't drift apart in how they are navigated.
import type { ReactNode } from 'react';
import Icon, { type IconName } from './Icon';

const BASE: string = import.meta.env.BASE_URL || '/';

export type ServiceId = 'sunday' | 'wednesday' | 'praise' | 'retreat';

export interface ServiceInfo {
  id: ServiceId;
  title: string;
  english: string;
  icon: IconName;
  href: string;
}

export const SERVICES: readonly ServiceInfo[] = [
  { id: 'sunday', title: '주일예배', english: 'Sunday Service', icon: 'bible', href: `${BASE}index.html?service=sunday` },
  { id: 'wednesday', title: '수요예배', english: 'Wednesday Service', icon: 'calendar', href: `${BASE}wednesday.html` },
  { id: 'praise', title: '찬양집회', english: 'Praise Night', icon: 'music', href: `${BASE}praise.html` },
  { id: 'retreat', title: '수련회', english: 'Retreat', icon: 'tent', href: `${BASE}retreat.html` },
];

export interface ShellStep {
  id: string;
  label: string;
}

interface AppShellProps {
  /** The service this page builds; null on the front door. */
  service: ServiceId | null;
  /** The generator's steps, in order. Left out where there are none to walk (the front door, the 편집기 view). */
  steps?: readonly ShellStep[];
  activeStep?: number;
  onStepSelect?: (index: number) => void;
  /** Step buttons are `${testIdPrefix}-tab-${id}`. */
  testIdPrefix?: string;
  /** Tool buttons at the foot of the rail (라이브러리, 사용량, 관리자). */
  tools?: ReactNode;
  /** Controls at the end of the page's title bar. */
  actions?: ReactNode;
  /** Folds the rail down to its icons, for a view that needs the width. */
  compact?: boolean;
  /** Extra classes on the page column. */
  appClassName?: string;
  children: ReactNode;
}

export default function AppShell({
  service,
  steps,
  activeStep = 0,
  onStepSelect,
  testIdPrefix = 'wizard',
  tools,
  actions,
  compact = false,
  appClassName,
  children,
}: AppShellProps) {
  const current = SERVICES.find((item) => item.id === service) ?? null;

  return (
    <>
      <a className="skip-link" href="#main-content">
        본문으로 건너뛰기
      </a>
      <div className={`shell${compact ? ' shell-compact' : ''}`}>
        <aside className="shell-nav">
          <a className="shell-brand" href={`${BASE}index.html`}>
            <img className="shell-logo" src={`${BASE}logo.png`} alt="" />
            <span className="shell-brand-text">
              <span className="shell-brand-name">KCCP PPT Generator</span>
              <span className="shell-brand-sub">빛주사랑 대학청년부 Media Team</span>
            </span>
          </a>

          <nav className="shell-group shell-services" aria-label="예배 종류">
            <p className="shell-group-label" aria-hidden="true">
              예배 종류
            </p>
            <ul className="shell-list">
              <li>
                <a
                  className="shell-link"
                  href={`${BASE}index.html`}
                  aria-current={service === null ? 'page' : undefined}
                  data-testid="nav-home"
                >
                  <Icon name="home" />
                  <span className="shell-link-label">처음 화면</span>
                </a>
              </li>
              {SERVICES.map((item) => (
                <li key={item.id}>
                  <a
                    className="shell-link"
                    href={item.href}
                    aria-current={item.id === service ? 'page' : undefined}
                    data-testid={`nav-${item.id}`}
                  >
                    <Icon name={item.icon} />
                    <span className="shell-link-label">{item.title}</span>
                  </a>
                </li>
              ))}
            </ul>
          </nav>

          {steps && steps.length > 0 && (
            <div className="shell-group shell-steps">
              <p className="shell-group-label" aria-hidden="true">
                진행 단계
              </p>
              <ol className="wizard-progress" aria-label={`${current?.title ?? ''} PPT 생성 단계`.trim()}>
                {steps.map((step, index) => (
                  <li
                    key={step.id}
                    className={`wizard-step${index === activeStep ? ' current' : ''}${index < activeStep ? ' complete' : ''}`}
                  >
                    <button
                      type="button"
                      className="wizard-step-button"
                      data-testid={`${testIdPrefix}-tab-${step.id}`}
                      aria-current={index === activeStep ? 'step' : undefined}
                      onClick={() => onStepSelect?.(index)}
                    >
                      <span className="wizard-step-dot">{index < activeStep ? <Icon name="check" /> : index + 1}</span>
                      <span className="wizard-step-label">{step.label}</span>
                    </button>
                  </li>
                ))}
              </ol>
            </div>
          )}

          {tools && (
            <div className="shell-group shell-tools" role="group" aria-label="도구">
              <p className="shell-group-label" aria-hidden="true">
                도구
              </p>
              <div className="shell-tool-list">{tools}</div>
            </div>
          )}
        </aside>

        <div className="shell-main">
          <div className={`app${appClassName ? ` ${appClassName}` : ''}`}>
            {current && (
              <header className="shell-topbar">
                <div className="shell-title">
                  <Icon name={current.icon} />
                  <h1>{current.title} PPT</h1>
                  <span className="shell-title-english" lang="en">
                    {current.english}
                  </span>
                </div>
                {actions && <div className="shell-actions">{actions}</div>}
              </header>
            )}
            {children}
          </div>
        </div>
      </div>
    </>
  );
}

interface StepNavProps {
  steps: readonly ShellStep[];
  index: number;
  onMove: (index: number) => void;
  /** Buttons are `${testIdPrefix}-back-${id}` and `${testIdPrefix}-next-${id}`. */
  testIdPrefix: string;
}

/**
 * The action bar at the foot of every step. It sticks to the bottom of the
 * window, so the way on is always one tap away however long the step is.
 */
export function StepNav({ steps, index, onMove, testIdPrefix }: StepNavProps) {
  const current = steps[index];
  const next = steps[index + 1];
  return (
    <nav className="wizard-nav" aria-label="단계 이동">
      {index > 0 ? (
        <button
          type="button"
          className="btn"
          data-testid={`${testIdPrefix}-back-${current.id}`}
          onClick={() => onMove(index - 1)}
        >
          <Icon name="back" />
          이전
        </button>
      ) : (
        <span className="wizard-nav-spacer" />
      )}
      {/* The rail already says where you are to assistive tech; this is the
          same fact repeated where the eye is. */}
      <p className="wizard-nav-status" aria-hidden="true">
        <span className="wizard-nav-count">
          {index + 1} / {steps.length}
        </span>
        <span className="wizard-nav-label">{current.label}</span>
      </p>
      {next ? (
        <button
          type="button"
          className="btn btn-primary"
          data-testid={`${testIdPrefix}-next-${current.id}`}
          onClick={() => onMove(index + 1)}
        >
          다음: {next.label}
          <Icon name="next" />
        </button>
      ) : (
        <span className="wizard-nav-spacer" />
      )}
    </nav>
  );
}
