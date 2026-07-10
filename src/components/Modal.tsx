import { useEffect } from 'react';
import type { ReactNode } from 'react';

interface Props {
  title?: string;
  /** Wider layout for score images */
  wide?: boolean;
  onClose: () => void;
  children: ReactNode;
}

export default function Modal({ title, wide, onClose, children }: Props) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true" onClick={onClose}>
      <div className={`modal${wide ? ' modal-wide' : ''}`} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          {title ? <h3>{title}</h3> : <span />}
          <button type="button" className="modal-close" aria-label="닫기" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}
