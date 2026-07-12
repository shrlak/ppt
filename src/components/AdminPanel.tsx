// Administrator panel: replace or restore the front/back slide decks that
// frame every generated presentation. Replacements persist in this browser
// (IndexedDB) and override the bundled files at generation time.
import { useEffect, useRef, useState } from 'react';
import Modal from './Modal';
import { clearCustomDeck, getCustomDeck, setCustomDeck, type DeckSlot, type StoredDeck } from '../lib/deckStore';
import { showToast } from '../lib/toast';

interface Props {
  onClose: () => void;
  /** Notify the app when a slot's custom deck changes (null = back to bundled). */
  onDeckChange: (slot: DeckSlot, deck: StoredDeck | null) => void;
}

const SLOTS: { slot: DeckSlot; label: string; description: string }[] = [
  { slot: 'front', label: 'Front slides', description: '예배 시작 전 안내 슬라이드 (기본 4장)' },
  { slot: 'back', label: 'Back slides', description: '공동체 고백송과 마무리 슬라이드 (기본 21장)' },
];

function DeckSlotRow({
  slot,
  label,
  description,
  onDeckChange,
}: {
  slot: DeckSlot;
  label: string;
  description: string;
  onDeckChange: Props['onDeckChange'];
}) {
  const [deck, setDeck] = useState<StoredDeck | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;
    void getCustomDeck(slot).then((stored) => {
      if (!cancelled) {
        setDeck(stored);
        setLoading(false);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [slot]);

  async function handleUpload(file: File) {
    setBusy(true);
    try {
      const stored = await setCustomDeck(slot, file.name, await file.arrayBuffer());
      setDeck(stored);
      onDeckChange(slot, stored);
      showToast(`${label}를 '${file.name}' (${stored.slideCount}장)으로 교체했습니다.`);
    } catch (e) {
      showToast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  }

  async function handleReset() {
    setBusy(true);
    try {
      await clearCustomDeck(slot);
      setDeck(null);
      onDeckChange(slot, null);
      showToast(`${label}를 기본 파일로 복원했습니다.`);
    } catch (e) {
      showToast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="admin-deck" data-testid={`admin-deck-${slot}`}>
      <div className="admin-deck-info">
        <h4>{label}</h4>
        <p>{description}</p>
        <p className="admin-deck-status" data-testid={`admin-deck-status-${slot}`}>
          {loading
            ? '확인 중…'
            : deck
              ? `사용자 파일: ${deck.name} · ${deck.slideCount}장 · ${new Date(deck.updatedAt).toLocaleDateString('ko-KR')} 교체`
              : '기본 제공 파일 사용 중'}
        </p>
      </div>
      <div className="admin-deck-actions">
        <input
          ref={inputRef}
          type="file"
          accept=".pptx,application/vnd.openxmlformats-officedocument.presentationml.presentation"
          hidden
          data-testid={`admin-deck-input-${slot}`}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void handleUpload(file);
          }}
        />
        <button type="button" className="btn" disabled={busy} onClick={() => inputRef.current?.click()}>
          {deck ? '다른 파일로 교체' : '파일 교체'}
        </button>
        {deck && (
          <button type="button" className="btn" disabled={busy} onClick={() => void handleReset()}>
            기본값 복원
          </button>
        )}
      </div>
    </section>
  );
}

export default function AdminPanel({ onClose, onDeckChange }: Props) {
  return (
    <Modal title="관리자 설정" onClose={onClose}>
      <p className="admin-intro">
        생성되는 모든 PPT의 앞뒤를 감싸는 front/back 슬라이드 파일을 관리합니다. 교체한 파일은 이
        브라우저에만 저장되며, 언제든지 기본 파일로 복원할 수 있습니다.
      </p>
      {SLOTS.map(({ slot, label, description }) => (
        <DeckSlotRow key={slot} slot={slot} label={label} description={description} onDeckChange={onDeckChange} />
      ))}
    </Modal>
  );
}
