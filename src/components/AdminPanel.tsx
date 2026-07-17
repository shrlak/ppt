// Administrator panel: replace or restore the front/back slide decks that
// frame every generated presentation (stored in this browser via IndexedDB),
// plus the shared recognition settings — concurrent model pool and excluded titles —
// which are stored on the recognition proxy so every device sees the same
// configuration.
import { useCallback, useEffect, useRef, useState } from 'react';
import Modal from './Modal';
import { clearCustomDeck, getCustomDeck, setCustomDeck, type DeckSlot, type StoredDeck } from '../lib/storage/deckStore';
import {
  attemptKey,
  fetchSharedSettings,
  findModelInfo,
  hasSharedSettings,
  invalidateSharedSettings,
  loadLocalSharedSettings,
  pushSharedSettings,
  sanitizeExcludedTitles,
  saveLocalSharedSettings,
  type SharedRecognitionSettings,
} from '../lib/ai/aiSettings';
import { showToast } from '../lib/utils/toast';

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
        PPT의 front/back 슬라이드와 가사 인식 설정을 관리합니다. 슬라이드 파일은 이 브라우저에
        저장되고, 동시 실행 모델 목록과 제외 곡 목록은 공유 서버에 저장되어 모든 기기에 동일하게
        적용됩니다. 공유 API 사용량은 헤더의 '사용량' 버튼에서 확인할 수 있습니다.
      </p>
      {SLOTS.map(({ slot, label, description }) => (
        <DeckSlotRow key={slot} slot={slot} label={label} description={description} onDeckChange={onDeckChange} />
      ))}
      <RecognitionSettingsSection />
    </Modal>
  );
}

function RecognitionSettingsSection() {
  const [settings, setSettings] = useState<SharedRecognitionSettings>(() => loadLocalSharedSettings());
  const [excludedText, setExcludedText] = useState(() => settings.excludedTitles.join('\n'));
  const [sync, setSync] = useState<{ state: 'loading' | 'saving' | 'synced' | 'local' | 'error'; message: string }>({
    state: hasSharedSettings() ? 'loading' : 'local',
    message: hasSharedSettings() ? '공유 설정 확인 중…' : '공유 프록시 미연결 — 이 브라우저에만 저장됩니다.',
  });
  // Once the admin edits anything, a late-arriving shared fetch must not
  // clobber their in-progress change.
  const editedRef = useRef(false);

  // Pull the shared copy when the panel opens, so this device edits the
  // order everyone is actually using.
  useEffect(() => {
    if (!hasSharedSettings()) return;
    let cancelled = false;
    void fetchSharedSettings().then((shared) => {
      if (cancelled || editedRef.current) return;
      if (shared) {
        setSettings(shared);
        setExcludedText(shared.excludedTitles.join('\n'));
        setSync({ state: 'synced', message: '모든 기기와 동기화되어 있습니다.' });
      } else {
        setSync({ state: 'error', message: '공유 설정을 불러오지 못해 이 브라우저의 값을 사용합니다.' });
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const persist = useCallback((next: SharedRecognitionSettings) => {
    editedRef.current = true;
    setSettings(next);
    saveLocalSharedSettings(next);
    invalidateSharedSettings();
    if (!hasSharedSettings()) {
      setSync({ state: 'local', message: '공유 프록시 미연결 — 이 브라우저에만 저장되었습니다.' });
      return;
    }
    setSync({ state: 'saving', message: '모든 기기에 적용하는 중…' });
    void pushSharedSettings(next, ADMIN_PASSWORD)
      .then(() => setSync({ state: 'synced', message: '저장됨 — 모든 기기에 적용됩니다.' }))
      .catch((error) =>
        setSync({
          state: 'error',
          message: `${error instanceof Error ? error.message : String(error)} (이 브라우저에는 저장됨)`,
        }),
      );
  }, []);

  function saveExcluded() {
    const excludedTitles = sanitizeExcludedTitles(excludedText.split('\n'));
    setExcludedText(excludedTitles.join('\n'));
    persist({ ...settings, excludedTitles });
    showToast('제외 곡 목록을 저장했습니다.');
  }

  return (
    <>
      <section className="admin-deck admin-recognition" data-testid="admin-recognition-order">
        <div className="admin-deck-info">
          <h4>가사 인식 동시 실행 모델</h4>
          <p>
            아래 모델을 매번 모두 동시에 실행하고, 결과를 함께 조합합니다. 각 페이지는 목록에서
            가장 위에 있는(가장 정확한) 모델의 결과를 쓰고, 그 모델이 놓친 제목·조성·진행 순서·가사는
            다른 모델의 결과로 채웁니다. 모든 공급자의 무료 요청 한도가 인식할 때마다 함께 사용됩니다.
          </p>
          <p className={`admin-sync admin-sync-${sync.state}`} data-testid="admin-settings-sync" role="status">
            {sync.message}
          </p>
          <ul className="admin-engine-list">
            {settings.attempts.map((attempt) => {
              const info = findModelInfo(attempt);
              const label = info?.label ?? `${attempt.engine} · ${attempt.model}`;
              return (
                <li key={attemptKey(attempt)} className="admin-engine" data-testid="admin-attempt">
                  <span className="admin-engine-label">
                    {label}
                    {info?.note && <em className="admin-engine-note">{info.note}</em>}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      </section>
      <section className="admin-deck admin-recognition" data-testid="admin-excluded-section">
        <div className="admin-deck-info">
          <h4>찬양 편집 제외 곡</h4>
          <p>
            한 줄에 하나씩 적으세요. 인식된 곡 제목이 이 목록과 일치하면 (공동체 고백송, 예배 전 준비
            찬양 등) 찬양 편집에 표시하지 않습니다. 모든 기기에 적용됩니다.
          </p>
          <textarea
            className="admin-excluded-input"
            data-testid="admin-excluded-titles"
            rows={Math.max(3, excludedText.split('\n').length)}
            placeholder={'공동체 고백송\n예배 전 준비 찬양'}
            value={excludedText}
            onChange={(event) => setExcludedText(event.target.value)}
          />
        </div>
        <div className="admin-deck-actions">
          <button type="button" className="btn" data-testid="admin-excluded-save" onClick={saveExcluded}>
            제외 목록 저장
          </button>
        </div>
      </section>
    </>
  );
}
