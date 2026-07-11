import { useRef, useState } from 'react';
import { TRANSLATIONS } from '../bible/books';
import { parseVerseInput, displayRef } from '../bible/refParser';
import { loadTranslation } from '../bible/bibleData';
import { buildVerseSlidePlan } from '../bible/versePlanner';
import { buildBiblePptx, suggestBibleFileName } from '../bible/pptxBuilder';

const BASE: string = import.meta.env.BASE_URL || '/';
const KO_TRANSLATIONS = TRANSLATIONS.filter((t) => t.language === 'ko');
const EN_TRANSLATIONS = TRANSLATIONS.filter((t) => t.language === 'en');

export default function BibleSlideGenerator() {
  const [verseInput, setVerseInput] = useState('');
  const [sermonTitle, setSermonTitle] = useState('');
  const [koTranslation, setKoTranslation] = useState('nkrv');
  const [enTranslation, setEnTranslation] = useState<string | null>('esv');
  const [versesPerSlide, setVersesPerSlide] = useState(1);
  const [customTemplate, setCustomTemplate] = useState<{ name: string; data: ArrayBuffer } | null>(null);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const { refs, invalidTokens } = verseInput.trim() ? parseVerseInput(verseInput) : { refs: [], invalidTokens: [] };
  const previewTokens = verseInput.trim().split(/\s+/).filter(Boolean);
  const translations = enTranslation ? [koTranslation, enTranslation] : [koTranslation];
  const canGenerate = verseInput.trim().length > 0 && refs.length > 0 && !generating;

  async function handleTemplateUpload(file: File) {
    if (!file.name.endsWith('.pptx')) return;
    const data = await file.arrayBuffer();
    setCustomTemplate({ name: file.name, data });
    setStatus(`'${file.name}' 템플릿을 이번 세션에서 사용합니다.`);
  }

  async function generate() {
    if (!canGenerate) return;
    setGenerating(true);
    setError(null);
    setStatus(null);
    try {
      const bibles = new Map();
      for (const id of translations) {
        bibles.set(id, await loadTranslation(BASE, id));
      }
      const plan = buildVerseSlidePlan(refs, translations, bibles, sermonTitle, versesPerSlide);

      const templateData = customTemplate
        ? customTemplate.data
        : await fetch(`${BASE}bible-template.pptx`).then((r) => {
            if (!r.ok) throw new Error('템플릿 파일을 불러오지 못했습니다.');
            return r.arrayBuffer();
          });

      const out = await buildBiblePptx(templateData, plan);
      const blob = new Blob([out.buffer as ArrayBuffer], {
        type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = suggestBibleFileName();
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setStatus('슬라이드 생성 완료!');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setGenerating(false);
    }
  }

  return (
    <div className="tool">
      <p className="tool-intro">성경 구절을 입력하면 말씀 슬라이드 PPT를 자동으로 만들어 드립니다.</p>

      {error && (
        <div className="banner banner-error" data-testid="bible-error-banner">
          <span>{error}</span>
          <button onClick={() => setError(null)}>✕</button>
        </div>
      )}
      {status && (
        <div className="banner banner-notice">
          <span>{status}</span>
          <button onClick={() => setStatus(null)}>✕</button>
        </div>
      )}

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
          onKeyDown={(e) => {
            if (e.key === 'Enter' && canGenerate) void generate();
          }}
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
          <span className="step">3</span> PPT 생성
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

        <button
          className="btn btn-primary btn-block"
          data-testid="bible-generate"
          disabled={!canGenerate}
          onClick={() => void generate()}
        >
          {generating ? '생성 중…' : '⬇ 슬라이드 생성'}
        </button>
      </section>
    </div>
  );
}
