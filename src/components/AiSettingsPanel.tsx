import type { AiSettings, RecognitionEngine } from '../lib/aiSettings';

interface Props {
  settings: AiSettings;
  onChange: (settings: AiSettings) => void;
}

const ENGINES: { id: RecognitionEngine; label: string; hint: string }[] = [
  { id: 'gemini', label: 'Gemini (무료 키)', hint: '정확도 높음 · 무료 API 키 필요' },
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
            <span>Google AI Studio API 키</span>
            <input
              type="password"
              data-testid="gemini-key-input"
              placeholder="AIza..."
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
              <strong>웹에서 가사 교차검증</strong>
              <span className="ai-toggle-hint">
                곡 제목을 구글에서 검색해 실제 공식 가사와 대조·보정합니다 (조금 느려질 수 있어요).
              </span>
            </span>
          </label>
          <p className="input-hint">
            무료 키는{' '}
            <a href="https://aistudio.google.com/apikey" target="_blank" rel="noreferrer">
              aistudio.google.com/apikey
            </a>{' '}
            에서 발급받을 수 있습니다. 주 1회 콘티 정도는 무료 한도 안에서 처리됩니다. 키는 이
            브라우저에만 저장되고 인식할 때 구글로 직접 전송됩니다.
          </p>
        </div>
      )}

      {settings.engine === 'tesseract' && (
        <p className="input-hint">
          기기 안에서 무료로 동작하며 키가 필요 없습니다. 처음 실행할 때 한글 인식 데이터를 내려받아
          다소 느리고, 스캔 악보 특성상 정확도가 낮아 직접 보정이 필요할 수 있습니다.
        </p>
      )}
    </div>
  );
}
