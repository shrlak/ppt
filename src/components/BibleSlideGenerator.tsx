import { useEffect, useRef, useState } from 'react';
import { TRANSLATIONS } from '../bible/books';
import { parseVerseInput, displayRef } from '../bible/refParser';
import { showToast } from '../lib/utils/toast';

const KO_TRANSLATIONS = TRANSLATIONS.filter((t) => t.language === 'ko');
const EN_TRANSLATIONS = TRANSLATIONS.filter((t) => t.language === 'en');

export interface BibleGeneratorState {
  verseInput: string;
  sermonTitle: string;
  translations: string[];
  versesPerSlide: number;
  customTemplate: { name: string; data: ArrayBuffer } | null;
}

interface Props {
  /** Fired whenever any input changes, so the parent can build the combined deck. */
  onStateChange: (state: BibleGeneratorState) => void;
  autoFillVersion?: number;
  autoVerseInput?: string;
  autoSermonTitle?: string;
  /** Bump to apply a template dropped in the unified upload panel. */
  externalTemplateVersion?: number;
  externalTemplate?: { name: string; data: ArrayBuffer } | null;
}

export default function BibleSlideGenerator({
  onStateChange,
  autoFillVersion = 0,
  autoVerseInput = '',
  autoSermonTitle = '',
  externalTemplateVersion = 0,
  externalTemplate = null,
}: Props) {
  const [verseInput, setVerseInput] = useState('');
  const [sermonTitle, setSermonTitle] = useState('');
  const [koTranslation, setKoTranslation] = useState('nkrv');
  const [enTranslation, setEnTranslation] = useState<string | null>('esv');
  const [versesPerSlide, setVersesPerSlide] = useState(1);
  const [customTemplate, setCustomTemplate] = useState<{ name: string; data: ArrayBuffer } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const { invalidTokens } = verseInput.trim() ? parseVerseInput(verseInput) : { invalidTokens: [] as string[] };
  const previewTokens = verseInput.trim().split(/\s+/).filter(Boolean);
  const translations = enTranslation ? [koTranslation, enTranslation] : [koTranslation];

  useEffect(() => {
    if (autoFillVersion === 0) return;
    setVerseInput(autoVerseInput);
    setSermonTitle(autoSermonTitle);
    showToast('찬양 콘티의 본문과 설교 제목을 자동으로 채웠습니다.');
  }, [autoFillVersion, autoVerseInput, autoSermonTitle]);

  useEffect(() => {
    if (externalTemplateVersion === 0) return;
    setCustomTemplate(externalTemplate);
    if (externalTemplate) showToast(`'${externalTemplate.name}' 템플릿을 이번 세션에서 사용합니다.`);
  }, [externalTemplateVersion, externalTemplate]);

  useEffect(() => {
    onStateChange({ verseInput, sermonTitle, translations, versesPerSlide, customTemplate });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [verseInput, sermonTitle, translations.join(','), versesPerSlide, customTemplate, onStateChange]);

  async function handleTemplateUpload(file: File) {
    if (!file.name.endsWith('.pptx')) return;
    const data = await file.arrayBuffer();
    setCustomTemplate({ name: file.name, data });
    showToast(`'${file.name}' 템플릿을 이번 세션에서 사용합니다.`);
  }

  return (
    <div className="tool">
      <p className="tool-intro">성경 구절을 입력하면 말씀 슬라이드를 자동으로 만들어 드립니다.</p>

      <section className="card">
        <h2>
          <span className="step">1</span> 성경 구절
        </h2>
        <input
          className="verse-input"
          data-testid="bible-verse-input"
          type="text"
          placeholder="행1:8-10 요3:16 롬8:28"
          value={verseInput}
          onChange={(e) => setVerseInput(e.target.value)}
        />
        <p className="input-hint">공백으로 구분해서 여러 구절을 입력할 수 있습니다.</p>
        {previewTokens.length > 0 && (
          <div className="verse-preview" data-testid="bible-verse-preview">
            {previewTokens.map((t, i) => {
              const ok = !invalidTokens.includes(t);
              return (
                <div key={i} className={`verse-preview-item${ok ? '' : ' invalid'}`}>
                  {displayRef(t)}
                </div>
              );
            })}
          </div>
        )}
      </section>

      <section className="card">
        <h2>
          <span className="step">2</span> 설교 제목 &amp; 번역본
        </h2>
        <input
          className="verse-input"
          data-testid="bible-sermon-title-input"
          type="text"
          placeholder="설교 제목을 입력하세요 (선택)"
          value={sermonTitle}
          onChange={(e) => setSermonTitle(e.target.value)}
        />

        <div className="lang-group">
          <span className="lang-label">한국어</span>
          <div className="translations">
            {KO_TRANSLATIONS.map((t) => (
              <label key={t.id} className={`chip chip-radio${koTranslation === t.id ? ' active' : ''}`}>
                <input
                  type="radio"
                  name="ko-translation"
                  checked={koTranslation === t.id}
                  onChange={() => setKoTranslation(t.id)}
                />
                {t.name}
              </label>
            ))}
          </div>
        </div>
        <div className="lang-group">
          <span className="lang-label">English</span>
          <div className="translations">
            {EN_TRANSLATIONS.map((t) => (
              <label
                key={t.id}
                className={`chip chip-radio${enTranslation === t.id ? ' active' : ''}`}
                onClick={(e) => {
                  e.preventDefault();
                  setEnTranslation((prev) => (prev === t.id ? null : t.id));
                }}
              >
                <input type="radio" name="en-translation" checked={enTranslation === t.id} readOnly />
                {t.name}
              </label>
            ))}
          </div>
        </div>
      </section>

      <section className="card">
        <h2>
          <span className="step">3</span> 옵션
        </h2>
        <div className="option-row">
          <label htmlFor="bible-verses-per-slide">슬라이드당 절 수</label>
          <input
            id="bible-verses-per-slide"
            className="number-input"
            type="number"
            min={1}
            max={10}
            value={versesPerSlide}
            onChange={(e) => setVersesPerSlide(Math.max(1, parseInt(e.target.value, 10) || 1))}
          />
        </div>

        <div className="template-row">
          <span className="input-hint">
            {customTemplate ? `커스텀 템플릿: ${customTemplate.name}` : '기본 템플릿 사용 중'}
          </span>
          <button className="btn" onClick={() => fileInputRef.current?.click()}>
            {customTemplate ? '템플릿 변경' : '내 템플릿 업로드'}
          </button>
          {customTemplate && (
            <button className="btn btn-ghost" onClick={() => setCustomTemplate(null)}>
              기본으로 복원
            </button>
          )}
          <input
            ref={fileInputRef}
            type="file"
            accept=".pptx"
            data-testid="bible-template-input"
            className="visually-hidden-input"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void handleTemplateUpload(file);
              e.target.value = '';
            }}
          />
        </div>
      </section>
    </div>
  );
}
