import { useEffect, useState } from 'react';
import { dismissToast, subscribeToasts, type Toast } from '../lib/utils/toast';

/** Renders whatever's pushed via showToast() as a stack in the bottom-left corner. */
export default function ToastHost() {
  const [toasts, setToasts] = useState<Toast[]>([]);

  useEffect(() => subscribeToasts(setToasts), []);

  if (toasts.length === 0) return null;

  return (
    <div className="toast-stack" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast-${t.kind}`}>
          <span>{t.message}</span>
          <button onClick={() => dismissToast(t.id)} aria-label="닫기">
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}
