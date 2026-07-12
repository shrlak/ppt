import type { AiSettings, RecognitionEngine } from '../lib/aiSettings';

interface Props {
  settings: AiSettings;
  onChange: (settings: AiSettings) => void;
}

const PROXY_CONFIGURED = Boolean(import.meta.env.VITE_RECOGNITION_PROXY_URL?.trim());

const ENGINES: { id: RecognitionEngine; label: string; hint: string }[] = [
  {
    id: 'gemini',
    label: 'Gemini (무료 키)',
    hint: PROXY_CONFIGURED ? '정확도 높음 · 키 없이도 공유 서버로 동작' : '정확도 높음 · 무료 API 키 필요',
  },
  {
    id: 'huggingface',
    label: 'Hugging Face',
    hint: PROXY_CONFIGURED ? '좋은 성능 · 키 없이도 공유 서버로 동작' : '좋은 성능 · 무료 API 키 필요',
  },
  { id: 'tesseract', label: '브라우저 OCR', hint: '키 없이 오프라인 · 정확도 낮음' },
  { id: 'off', label: '끄기', hint: '자동 인식 안 함' },
];

/**
 * Settings for auto-recognizing lyrics from scanned score images. The Gemini key
 * is stored only in this browser and used to call Google directly.
 */
export default function AiSettingsPanel({ settings, onChange }: Props) {
  return (
    <div className="ai-settings">
      <p className="ai-settings-intro">
        새 찬양(라이브러리에 없는 곡)을 업로드하면 악보 이미지에서 제목·파트(절/후렴/프리코러스/브릿지)·
        순서를 자동으로 읽어 채워 드립니다. 결과는 언제든 직접 수정할 수 있습니다.
      </p>

      <div className="ai-engine-group" role="radiogroup" aria-label="자동 인식 엔진">
        {ENGINES.map((e) => (
          <label key={e.id} className={`ai-engine${settings.engine === e.id ? ' active' : ''}`}>
            <input
              type="radio"
              name="ai-engine"
              checked={settings.engine === e.id}
              onChange={() => onChange({ ...settings, engine: e.id })}
            />
            <span className="ai-engine-label">{e.label}</span>
            <span className="ai-engine-hint">{e.hint}</span>
          </label>
        ))}
      </div>

      {settings.engine === 'gemini' && (
        <div className="ai-gemini">
          <label className="ai-field">
            <span>Google AI Studio API 키{PROXY_CONFIGURED ? ' (선택)' : ''}</span>
            <input
              type="password"
              data-testid="gemini-key-input"
              placeholder={PROXY_CONFIGURED ? '비워두면 공유 서버 사용' : 'AIza...'}
              autoComplete="off"
              value={settings.geminiApiKey}
              onChange={(e) => onChange({ ...settings, geminiApiKey: e.target.value })}
            />
          </label>
          <label className="ai-field">
            <span>모델</span>
            <input
              type="text"
              value={settings.geminiModel}
              onChange={(e) => onChange({ ...settings, geminiModel: e.target.value })}
            />
          </label>
          <label className="ai-toggle">
            <input
              type="checkbox"
              data-testid="gemini-search-toggle"
              checked={settings.geminiUseSearch}
              onChange={(e) => onChange({ ...settings, geminiUseSearch: e.target.checked })}
            />
            <span>
              <strong>웹에서 띄어쓰기·맞춤법 교정</strong>
              <span className="ai-toggle-hint">
                곡 제목을 구글에서 검색해 <strong>띄어쓰기·맞춤법</strong>을 바로잡고 음절 하이픈(-)을
                자연스럽게 정리합니다. 가사 내용은 <strong>악보 그대로</strong> 유지해요 (조금 느려질 수 있어요).
              </span>
            </span>
          </label>
          <p className="input-hint">
            {PROXY_CONFIGURED && (
              <>
                키를 입력하지 않으면 공유 서버(관리자가 등록한 키)로 자동 인식됩니다 — 별도 설정 없이 바로
                사용할 수 있어요.{' '}
              </>
            )}
            무료 키는{' '}
            <a href="https://aistudio.google.com/apikey" target="_blank" rel="noreferrer">
              aistudio.google.com/apikey
            </a>{' '}
            에서 발급받을 수 있습니다. 주 1회 콘티 정도는 무료 한도 안에서 처리됩니다. 키를 직접 입력하면 이
            브라우저에만 저장되고 인식할 때 구글로 직접 전송됩니다.
          </p>
        </div>
      )}

      {settings.engine === 'huggingface' && (
        <div className="ai-huggingface">
          <label className="ai-field">
            <span>Hugging Face API 키{PROXY_CONFIGURED ? ' (선택)' : ''}</span>
            <input
              type="password"
              data-testid="huggingface-key-input"
              placeholder={PROXY_CONFIGURED ? '비워두면 공유 서버 사용' : 'hf_...'}
              autoComplete="off"
              value={settings.huggingfaceApiKey}
              onChange={(e) => onChange({ ...settings, huggingfaceApiKey: e.target.value })}
            />
          </label>
          <p className="input-hint">
            {PROXY_CONFIGURED && (
              <>
                키를 입력하지 않으면 공유 서버(관리자가 등록한 키)로 자동 인식됩니다 — 별도 설정 없이 바로
                사용할 수 있어요.{' '}
              </>
            )}
            무료 키는{' '}
            <a href="https://huggingface.co/settings/tokens" target="_blank" rel="noreferrer">
              huggingface.co/settings/tokens
            </a>{' '}
            에서 발급받을 수 있습니다. 키를 직접 입력하면 이 브라우저에만 저장되고 인식할 때 Hugging Face로
            직접 전송됩니다.
          </p>
        </div>
      )}

      {settings.engine === 'tesseract' && (
        <p className="input-hint">
          기기 안에서 무료로 동작하며 키가 필요 없습니다. 처음 실행할 때 한글 인식 데이터를 내려받아
          다소 느리고, 스캔 악보 특성상 정확도가 낮아 직접 보정이 필요할 수 있습니다.
        </p>
      )}

      {settings.engine !== 'off' && (
        <div className="ai-fallback">
          <label className="ai-field">
            <span>실패 시 차례로 시도할 엔진</span>
            <div className="fallback-engines">
              {ENGINES.filter((e) => e.id !== 'off').map((engine) => (
                <label key={engine.id} className="fallback-checkbox">
                  <input
                    type="checkbox"
                    checked={settings.fallbackEngines.includes(engine.id)}
                    disabled={engine.id === settings.engine}
                    onChange={(e) => {
                      const updated = e.target.checked
                        ? [...settings.fallbackEngines, engine.id]
                        : settings.fallbackEngines.filter((x) => x !== engine.id);
                      onChange({ ...settings, fallbackEngines: updated });
                    }}
                  />
                  <span>{engine.label}</span>
                </label>
              ))}
            </div>
          </label>
          <p className="input-hint">
            선택된 엔진이 실패하거나 API 한도를 초과하면 자동으로 다음 엔진을 시도합니다.
          </p>
        </div>
      )}
    </div>
  );
}
