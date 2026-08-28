// Administrator panel: replace or restore the front/back slide decks that
// frame every generated presentation (stored in this browser via IndexedDB),
// plus the shared settings — concurrent model pool, the 공동체 고백송 printed
// in the back deck, and excluded titles — which are stored on the recognition
// proxy so every device sees the same configuration.
import { useCallback, useEffect, useRef, useState } from 'react';
import Modal from './Modal';
import { clearCustomDeck, getCustomDeck, setCustomDeck, type DeckSlot, type StoredDeck } from '../lib/storage/deckStore';
import {
  attemptKey,
  DEFAULT_CONFESSION_SONG,
  fetchSharedSettings,
  findModelInfo,
  hasSharedSettings,
  invalidateSharedSettings,
  loadLocalSharedSettings,
  pushSharedSettings,
  sanitizeExcludedTitles,
  saveLocalSharedSettings,
  type SharedRecognitionSettings,
  type ModelRole,
} from '../lib/ai/aiSettings';
import { lookupConfessionSong } from '../lib/utils/confessionSong';
import { fetchBundledLibrary, loadUserLibrary, mergeLibraries } from '../lib/storage/library';
import { showToast } from '../lib/utils/toast';
import { ADMIN_PASSWORD, ADMIN_UNLOCK_KEY } from '../lib/adminAuth';
import Icon from './Icon';
import LearningAdminSection from './LearningAdminSection';

const BASE: string = import.meta.env.BASE_URL || '/';

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
          <Icon name="upload" />
          {deck ? '다른 파일로 교체' : '파일 교체'}
        </button>
        {deck && (
          <button type="button" className="btn" disabled={busy} onClick={() => void handleReset()}>
            <Icon name="refresh" />
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
export default function AdminPanel({ onClose, onDeckChange }: Props) {
  const [unlocked, setUnlocked] = useState(() => {
    try {
      return sessionStorage.getItem(ADMIN_UNLOCK_KEY) === '1';
    } catch {
      return false;
    }
  });
  const [password, setPassword] = useState('');
  const [wrong, setWrong] = useState(false);

  function handleUnlock() {
    if (password === ADMIN_PASSWORD) {
      try {
        sessionStorage.setItem(ADMIN_UNLOCK_KEY, '1');
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
            <p className="admin-lock-error" data-testid="admin-password-error" role="alert">
              <Icon name="error" />
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
        저장되고, 동시 실행 모델 목록과 공동체 고백송, 제외 곡 목록은 공유 서버에 저장되어 모든
        기기에 동일하게 적용됩니다. 공유 API 사용량은 헤더의 '사용량' 버튼에서 확인할 수 있습니다.
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
  const [confessionText, setConfessionText] = useState(() => settings.confessionSong);
  // Deployment state rather than a setting: only the Worker's environment can
  // grant permission to read Bugs pages, so this is displayed, never toggled.
  const [bugsScrapingAllowed, setBugsScrapingAllowed] = useState(false);
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
        setConfessionText(shared.confessionSong);
        setBugsScrapingAllowed(!!(shared as { bugsScrapingAllowed?: boolean }).bugsScrapingAllowed);
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

  /**
   * Pin (or unpin) a model's role.
   *
   * Measured accuracy decides roles on its own; this exists for what
   * measurement cannot see yet, such as a provider announcing a deprecation.
   */
  const setRoleOverride = useCallback(
    (modelKey: string, role: ModelRole | null) => {
      const roleOverrides = { ...settings.roleOverrides };
      if (role) roleOverrides[modelKey] = role;
      else delete roleOverrides[modelKey];
      persist({ ...settings, roleOverrides });
    },
    [persist, settings],
  );

  function saveConfessionSong() {
    const confessionSong = confessionText.trim();
    setConfessionText(confessionSong);
    persist({ ...settings, confessionSong });
    showToast(
      confessionSong
        ? `공동체 고백송을 '${confessionSong}'으로 저장했습니다.`
        : '공동체 고백송을 비웠습니다 — back slides를 그대로 사용합니다.',
    );
  }

  function saveExcluded() {
    const excludedTitles = sanitizeExcludedTitles(excludedText.split('\n'));
    setExcludedText(excludedTitles.join('\n'));
    persist({ ...settings, excludedTitles });
    showToast('제외 곡 목록을 저장했습니다.');
  }

  return (
    <>
      <LearningAdminSection
        settings={settings}
        onRoleOverride={setRoleOverride}
        bugsScrapingAllowed={bugsScrapingAllowed}
      />
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
      <ConfessionSongSection
        savedTitle={settings.confessionSong}
        value={confessionText}
        onChange={setConfessionText}
        onSave={saveConfessionSong}
      />
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
            <Icon name="save" />
            제외 목록 저장
          </button>
        </div>
      </section>
    </>
  );
}

/**
 * Which song the back deck's 공동체 고백 slides print.
 *
 * Only the TITLE is stored (and shared with every device); the lyrics come
 * from the 곡 라이브러리, so the confession song is corrected and saved in the
 * 찬양 step like any other song rather than typed a second time here. The
 * status line below says what the generator will actually do with the title —
 * a title the library has no lyrics for leaves the back slides untouched, and
 * that is worth seeing here rather than discovering in a downloaded deck.
 */
function ConfessionSongSection({
  savedTitle,
  value,
  onChange,
  onSave,
}: {
  savedTitle: string;
  value: string;
  onChange: (value: string) => void;
  onSave: () => void;
}) {
  const [titles, setTitles] = useState<string[]>([]);
  const [status, setStatus] = useState('확인 중…');
  const [tone, setTone] = useState<'synced' | 'error' | 'local'>('local');

  useEffect(() => {
    let cancelled = false;
    void fetchBundledLibrary(BASE).then((bundled) => {
      if (!cancelled) setTitles(mergeLibraries(bundled, loadUserLibrary()).map((entry) => entry.title));
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    void lookupConfessionSong(BASE, savedTitle).then((found) => {
      if (cancelled) return;
      if (!found.title) {
        setTone('local');
        setStatus('비워 두면 back slides의 공동체 고백 슬라이드를 그대로 사용합니다.');
      } else if (found.song) {
        setTone('synced');
        setStatus(
          `'${found.title}' — 라이브러리 가사로 공동체 고백 슬라이드 ${found.slideCount}장을 만듭니다.`,
        );
      } else {
        setTone('error');
        setStatus(
          `라이브러리에 '${found.title}' 가사가 없어 back slides를 그대로 둡니다. 찬양 단계에서 이 곡을 라이브러리에 저장해 주세요.`,
        );
      }
    });
    return () => {
      cancelled = true;
    };
  }, [savedTitle]);

  return (
    <section className="admin-deck admin-recognition" data-testid="admin-confession-section">
      <div className="admin-deck-info">
        <h4>공동체 고백송</h4>
        <p>
          Back slides에서 <strong>공동체 고백</strong>이라고 적힌 슬라이드와 그 뒤의 가사 슬라이드를
          여기서 정한 곡으로 자동으로 바꿔 줍니다. 가사는 곡 라이브러리에서 가져오므로, 새 고백송은
          찬양 단계에서 한 번 저장해 두면 됩니다. 콘티에서도 이 곡은 일반 찬양 슬라이드에서
          빼고, 콘티에 이 곡 다음으로 적힌 찬양을 설교 후 찬양으로 잡습니다. 모든 기기에
          적용됩니다.
        </p>
        <input
          className="admin-excluded-input"
          data-testid="admin-confession-song"
          list="admin-confession-titles"
          placeholder={DEFAULT_CONFESSION_SONG}
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
        <datalist id="admin-confession-titles">
          {titles.map((title) => (
            <option key={title} value={title} />
          ))}
        </datalist>
        <p className={`admin-sync admin-sync-${tone}`} data-testid="admin-confession-status" role="status">
          {status}
        </p>
      </div>
      <div className="admin-deck-actions">
        <button type="button" className="btn" data-testid="admin-confession-save" onClick={onSave}>
          <Icon name="save" />
          고백송 저장
        </button>
      </div>
    </section>
  );
}
