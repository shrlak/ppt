import { useEffect, useState } from 'react';
import { dismissToast, subscribeToasts, type Toast } from '../lib/utils/toast';
import Icon, { type IconName } from './Icon';

type DisplayedToast = Toast & { leaving?: boolean };

// Colour alone never carries the outcome — each kind also gets its own icon
// alongside the wording.
const KIND_ICON: Record<Toast['kind'], IconName> = {
  notice: 'info',
  warn: 'warning',
  error: 'error',
};

/**
 * Renders whatever's pushed via showToast() as a stack in the bottom-left
 * corner. Keeps a toast mounted for its exit animation instead of dropping
 * it the instant it leaves the source list, so it fades/slides away rather
 * than vanishing mid-frame.
 */
export default function ToastHost() {
  const [displayed, setDisplayed] = useState<DisplayedToast[]>([]);

  useEffect(
    () =>
      subscribeToasts((next) => {
        setDisplayed((prev) => {
          const nextIds = new Set(next.map((t) => t.id));
          const stillLeaving = prev.filter((t) => t.leaving && !nextIds.has(t.id));
          const newlyLeaving = prev
            .filter((t) => !t.leaving && !nextIds.has(t.id))
            .map((t) => ({ ...t, leaving: true }));
          return [...stillLeaving, ...newlyLeaving, ...next];
        });
      }),
    [],
  );

  if (displayed.length === 0) return null;

  return (
    <div className="toast-stack" role="status" aria-live="polite">
      {displayed.map((t) => (
        <div
          key={t.id}
          className={`toast toast-${t.kind}${t.leaving ? ' toast-leaving' : ''}`}
          onAnimationEnd={() => {
            if (t.leaving) setDisplayed((prev) => prev.filter((d) => d.id !== t.id));
          }}
        >
          <Icon name={KIND_ICON[t.kind]} />
          <span className="toast-text">{t.message}</span>
          <button type="button" onClick={() => dismissToast(t.id)} aria-label="닫기">
            <Icon name="close" />
          </button>
        </div>
      ))}
    </div>
  );
}
