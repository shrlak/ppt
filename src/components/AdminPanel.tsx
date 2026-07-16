// Administrator panel: replace or restore the front/back slide decks that
// frame every generated presentation. Replacements persist in this browser
// (IndexedDB) and override the bundled files at generation time.
import { useEffect, useRef, useState } from 'react';
import Modal from './Modal';
import { clearCustomDeck, getCustomDeck, setCustomDeck, type DeckSlot, type StoredDeck } from '../lib/storage/deckStore';
import {
  DEFAULT_RECOGNITION_ORDER,
  loadRecognitionOrder,
  saveRecognitionOrder,
  type RecognitionEngine,
} from '../lib/ai/aiSettings';
import { showToast } from '../lib/utils/toast';

const ENGINE_LABELS: Record<string, string> = {
  gemini: 'Gemini',
  nvidia: 'NVIDIA',
  huggingface: 'Hugging Face',
};

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

// Soft gate to keep casual visitors out of deck administration. This is a
// static client-side site, so the check can't be real security — the decks
// it protects live in the visitor's own browser anyway.
const ADMIN_PASSWORD = 'kccpmedia1980';
const UNLOCK_KEY = 'kccp-admin-unlocked';

export default function AdminPanel({ onClose, onDeckChange }: Props) {
  const [unlocked, setUnlocked] = useState(() => {
    try {
      return sessionStorage.getItem(UNLOCK_KEY) === '1';
    } catch {
      return false;
    }
  });
  const [password, setPassword] = useState('');
  const [wrong, setWrong] = useState(false);

  function handleUnlock() {
    if (password === ADMIN_PASSWORD) {
      try {
        sessionStorage.setItem(UNLOCK_KEY, '1');
      } catch {
        // Session-only unlock still works without storage.
      }
      setUnlocked(true);
    } else {
      setWrong(true);
    }
  }

  if (!unlocked) {
    return (
      <Modal title="관리자 설정" onClose={onClose}>
        <form
          className="admin-lock"
          onSubmit={(e) => {
            e.preventDefault();
            handleUnlock();
          }}
        >
          <p className="admin-intro">관리자 설정에 접근하려면 비밀번호를 입력하세요.</p>
          <label htmlFor="admin-password">
            비밀번호
            <input
              id="admin-password"
              type="password"
              autoFocus
              autoComplete="current-password"
              data-testid="admin-password"
              value={password}
              onChange={(e) => {
                setPassword(e.target.value);
                setWrong(false);
              }}
            />
          </label>
          {wrong && (
            <p className="admin-lock-error" data-testid="admin-password-error">
              비밀번호가 올바르지 않습니다.
            </p>
          )}
          <button type="submit" className="btn btn-primary" data-testid="admin-unlock">
            확인
          </button>
        </form>
      </Modal>
    );
  }

  return (
    <Modal title="관리자 설정" onClose={onClose}>
      <p className="admin-intro">
        PPT의 front/back 슬라이드와 가사 인식 AI 순서를 관리합니다. 교체한 파일은 이 브라우저에
        저장되며, 언제든지 기본 파일로 복원할 수 있습니다. 공유 API 사용량은 헤더의 '사용량' 버튼에서
        확인할 수 있습니다.
      </p>
      {SLOTS.map(({ slot, label, description }) => (
        <DeckSlotRow key={slot} slot={slot} label={label} description={description} onDeckChange={onDeckChange} />
      ))}
      <RecognitionOrderSection />
    </Modal>
  );
}

function RecognitionOrderSection() {
  const [order, setOrder] = useState<RecognitionEngine[]>(() => loadRecognitionOrder());
  const isDefault = order.join() === DEFAULT_RECOGNITION_ORDER.join();

  function move(index: number, delta: -1 | 1) {
    const to = index + delta;
    if (to < 0 || to >= order.length) return;
    const next = order.slice();
    [next[index], next[to]] = [next[to], next[index]];
    saveRecognitionOrder(next);
    setOrder(next);
  }

  function reset() {
    saveRecognitionOrder(DEFAULT_RECOGNITION_ORDER);
    setOrder([...DEFAULT_RECOGNITION_ORDER]);
  }

  return (
    <section className="admin-deck admin-recognition" data-testid="admin-recognition-order">
      <div className="admin-deck-info">
        <h4>가사 인식 AI 순서</h4>
        <p>위에서부터 차례로 시도하고, 실패하면 다음 엔진으로 넘어갑니다.</p>
        <ol className="admin-engine-list">
          {order.map((engine, index) => (
            <li key={engine} className="admin-engine" data-testid={`admin-engine-${engine}`}>
              <span className="admin-engine-label">
                {index + 1}. {ENGINE_LABELS[engine] ?? engine}
              </span>
              <span className="admin-engine-actions">
                <button
                  type="button"
                  className="btn btn-chip"
                  aria-label={`${ENGINE_LABELS[engine] ?? engine} 순서 올리기`}
                  data-testid={`admin-engine-up-${engine}`}
                  disabled={index === 0}
                  onClick={() => move(index, -1)}
                >
                  ↑
                </button>
                <button
                  type="button"
                  className="btn btn-chip"
                  aria-label={`${ENGINE_LABELS[engine] ?? engine} 순서 내리기`}
                  data-testid={`admin-engine-down-${engine}`}
                  disabled={index === order.length - 1}
                  onClick={() => move(index, 1)}
                >
                  ↓
                </button>
              </span>
            </li>
          ))}
        </ol>
      </div>
      <div className="admin-deck-actions">
        {!isDefault && (
          <button type="button" className="btn" data-testid="admin-engine-reset" onClick={reset}>
            기본 순서로
          </button>
        )}
      </div>
    </section>
  );
}
