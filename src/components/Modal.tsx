import { useEffect, useId, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import Icon from './Icon';

interface Props {
  title?: string;
  /** Wider layout for score images */
  wide?: boolean;
  /** Near-fullscreen layout for the split conti/editor view */
  full?: boolean;
  onClose: () => void;
  children: ReactNode;
}

// Every close path (backdrop, the close button, Escape) plays the reverse of
// the open animation before actually unmounting, so the sheet/dialog always
// leaves the way it arrived instead of vanishing mid-motion.
//
// A dialog owns the keyboard while it is open: focus moves into it, Tab is
// kept inside it (the one place a focus trap is correct), and focus returns
// to whatever opened it on close — otherwise a keyboard user is dropped back
// at the top of the document with no idea where they were.
export default function Modal({ title, wide, full, onClose, children }: Props) {
  const [closing, setClosing] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const titleId = useId();

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const dialog = dialogRef.current;

    const focusable = () =>
      Array.from(
        dialog?.querySelectorAll<HTMLElement>(
          'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
        ) ?? [],
      ).filter((el) => el.offsetParent !== null || el === document.activeElement);

    // Move focus in on open — the first control if there is one, the dialog
    // itself otherwise, so the next Tab starts inside rather than behind it.
    (focusable()[0] ?? dialog)?.focus();

    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        setClosing(true);
        return;
      }
      if (e.key !== 'Tab') return;
      const items = focusable();
      if (items.length === 0) {
        e.preventDefault();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && (active === first || !dialog?.contains(active))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    }

    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      opener?.focus?.();
    };
  }, []);

  return (
    <div
      className={`modal-overlay${closing ? ' modal-overlay-closing' : ''}`}
      onClick={() => setClosing(true)}
    >
      <div
        ref={dialogRef}
        className={`modal${wide ? ' modal-wide' : ''}${full ? ' modal-full' : ''}${closing ? ' modal-closing' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label={title ? undefined : '대화 상자'}
        aria-labelledby={title ? titleId : undefined}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        onAnimationEnd={(e) => {
          if (closing && e.target === e.currentTarget) onClose();
        }}
      >
        <div className="modal-header">
          {title ? <h2 id={titleId}>{title}</h2> : <span />}
          <button type="button" className="modal-close" aria-label="닫기" onClick={() => setClosing(true)}>
            <Icon name="close" />
          </button>
        </div>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}
