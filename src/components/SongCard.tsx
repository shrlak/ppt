import { useEffect, useState } from 'react';
import type { Song } from '../lib/utils/types';
import { formatOrder, parseOrder } from '../lib/utils/orderParser';
import { planSlides, unmatchedTokens } from '../lib/utils/slidePlanner';
import { progressPercent, type RecognitionPhase } from '../lib/ai/recognitionProgress';
import { nextAvailableLabel } from './songLabels';

/** Live status of auto-recognizing a song's score image. */
export interface RecogState {
  status: 'running' | 'done' | 'error';
  /** Overall pipeline progress, 0–1. Rendered as a percentage + bar. */
  progress?: number;
  message?: string;
  /** Current stage of the staged batch recognition flow. */
  phase?: RecognitionPhase;
  /** Engine that produced the result, or 'library' when recognition was skipped. */
  engine?: string;
}

const ENGINE_LABELS: Record<string, string> = {
  gemini: 'Gemini',
  // Legacy engine ID: all current entries in this lane are OpenRouter free models.
  nvidia: 'OpenRouter',
  huggingface: 'Hugging Face',
  library: '라이브러리',
};

const PHASE_LABELS: Record<RecognitionPhase, string> = {
  render: '악보 이미지 준비 중',
  titles: '전체 곡 제목 확인 중',
  lyrics: '전체 가사 일괄 인식 중',
  rescue: '남은 곡 다시 인식 중',
};

interface Props {
  song: Song;
  index: number;
  total: number;
  pageImage?: string;
  recog?: RecogState;
  onRecognize?: () => void;
  onCancelRecognize?: () => void;
  onChange: (song: Song) => void;
  onMove: (id: string, delta: -1 | 1) => void;
  onRemove: (id: string) => void;
  onSaveToLibrary: (song: Song) => void;
  onZoom: () => void;
  onTitleBlur: (title: string) => void;
  /**
   * Render only the header + lyric editor + slide preview (no score pane) —
   * used as the right side of the split-screen conti view, where the score
   * is already showing on the left.
   */
  editorOnly?: boolean;
}

// A single "V" quick-add button rather than separate "V1"/"V2" ones: most
// songs' first verse doesn't need a number, and findSection() in
// slidePlanner.ts already treats a plain "V" section as V1 for order
// matching, so nothing forces a song to have exactly two verses either.
const QUICK_LABELS = ['V', 'PC', 'C', 'B'];

export default function SongCard({
  song,
  index,
  total,
  pageImage,
  recog,
  onRecognize,
  onCancelRecognize,
  onChange,
  onMove,
  onRemove,
  onSaveToLibrary,
  onZoom,
  onTitleBlur,
  editorOnly = false,
}: Props) {
  const [orderText, setOrderText] = useState(formatOrder(song.order));
  const [saved, setSaved] = useState(false);

  // Sync when the song's order is replaced from outside (library fill, upload).
  useEffect(() => {
    setOrderText(formatOrder(song.order));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [song.id, song.order.join('|')]);

  const missing = new Set(unmatchedTokens(song));
  const plans = planSlides(song);

  function setSection(i: number, patch: Partial<{ label: string; text: string }>) {
    const sections = song.sections.map((s, idx) => {
      if (idx !== i) return s;
      return {
        label: patch.label ?? s.label,
        lines: patch.text !== undefined ? patch.text.split('\n') : s.lines,
      };
    });
    onChange({ ...song, sections });
  }

  function addSection(label: string) {
    const finalLabel = label ? nextAvailableLabel(song.sections.map((s) => s.label), label) : '';
    onChange({ ...song, sections: [...song.sections, { label: finalLabel, lines: [] }] });
  }

  function removeSection(i: number) {
    onChange({ ...song, sections: song.sections.filter((_, idx) => idx !== i) });
  }

  function moveSection(i: number, delta: -1 | 1) {
    const j = i + delta;
    if (j < 0 || j >= song.sections.length) return;
    const sections = [...song.sections];
    [sections[i], sections[j]] = [sections[j], sections[i]];
    onChange({ ...song, sections });
  }

  // Recognition status + trigger, rendered inside the score pane normally
  // and directly above the editor in the split-screen (editorOnly) view.
  const recogBox = onRecognize && (
    <div className="recog-box" data-testid="recog-box">
      {recog?.status === 'running' ? (
        <div className="recog-running" data-testid="recog-running">
          <div className="recog-running-row">
            <div className="spinner" />
            <span>
              {recog.phase ? `${PHASE_LABELS[recog.phase]}…` : '가사 인식 중…'}
              {typeof recog.progress === 'number' && (
                <strong className="recog-percent" data-testid="recog-percent">
                  {' '}
                  {progressPercent(recog.progress)}%
                </strong>
              )}
            </span>
            {onCancelRecognize && (
              <button
                type="button"
                className="btn btn-chip"
                data-testid="recognize-stop"
                onClick={onCancelRecognize}
              >
                중지
              </button>
            )}
          </div>
          <div
            className="recog-progress"
            role="progressbar"
            aria-label="가사 인식 진행률"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={progressPercent(recog.progress)}
          >
            <span style={{ width: `${progressPercent(recog.progress)}%` }} />
          </div>
        </div>
      ) : (
        <>
          <button className="btn btn-chip" data-testid="recognize-btn" onClick={onRecognize}>
            {recog?.status === 'done' ? '↻ 다시 인식' : '✨ 가사 자동 인식'}
          </button>
          {recog?.status === 'error' && (
            <span className="recog-error">
              인식 실패 — 다시 시도하거나 직접 입력하세요.
              {recog.message && <span className="recog-error-detail">{recog.message}</span>}
            </span>
          )}
          {recog?.status === 'done' && (
            <span className="recog-done">
              {recog.engine === 'library'
                ? '✓ 라이브러리의 저장된 가사를 불러왔습니다'
                : `✓ ${recog.engine ? `${ENGINE_LABELS[recog.engine] ?? recog.engine}로 ` : ''}인식 완료 · 확인해 주세요`}
            </span>
          )}
        </>
      )}
    </div>
  );

  return (
    <div
      className={`song-card${editorOnly ? ' song-card-editor-only' : ''}`}
      data-testid={editorOnly ? 'song-card-editor' : 'song-card'}
    >
      <div className="song-card-head">
        <span className="song-number">{index + 1}</span>
        <input
          className="song-title"
          data-testid="song-title-input"
          placeholder="찬양 제목"
          value={song.title}
          onChange={(e) => onChange({ ...song, title: e.target.value })}
          onBlur={(e) => onTitleBlur(e.target.value)}
        />
        <input
          className="song-key"
          placeholder="키"
          title="곡 키 (예: E, F, G)"
          value={song.key ?? ''}
          onChange={(e) => onChange({ ...song, key: e.target.value || undefined })}
        />
        <div className="song-actions">
          <button className="btn btn-icon" disabled={index === 0} onClick={() => onMove(song.id, -1)} title="위로">
            ↑
          </button>
          <button
            className="btn btn-icon"
            disabled={index === total - 1}
            onClick={() => onMove(song.id, 1)}
            title="아래로"
          >
            ↓
          </button>
          <button
            className="btn btn-icon btn-danger"
            title="삭제"
            onClick={() => {
              if (window.confirm(`'${song.title || '제목 없음'}' 곡을 삭제할까요?`)) onRemove(song.id);
            }}
          >
            🗑
          </button>
        </div>
      </div>
      {song.description && <p className="song-desc">{song.description}</p>}

      <div className="song-body">
        {editorOnly ? null : pageImage ? (
          <div className="score-pane">
            <img src={pageImage} alt="악보 미리보기" onClick={onZoom} />
            <span className="score-hint">클릭하면 콘티 전체를 보며 가사를 편집할 수 있어요 (p.{song.pageIndex})</span>
            {recogBox}
          </div>
        ) : song.pageIndex != null ? (
          <div className="score-pane score-loading">악보 미리보기 준비 중… (p.{song.pageIndex})</div>
        ) : null}

        <div className="editor-pane">
          {editorOnly && recogBox}
          {song.sections.map((sec, i) => (
            <div className="section-row" key={i}>
              <input
                className="section-label"
                value={sec.label}
                placeholder="파트"
                title="파트 이름을 자유롭게 입력할 수 있습니다 (예: V3, PC2, C3, Bridge2 등)"
                onChange={(e) => setSection(i, { label: e.target.value.toUpperCase() })}
              />
              <textarea
                data-testid="section-textarea"
                rows={Math.max(2, sec.lines.length)}
                placeholder="가사를 한 줄씩 입력하세요 (빈 줄 = 슬라이드 나누기)"
                title="빈 줄을 넣으면 그 앞의 가사와 뒤의 가사가 서로 다른 슬라이드로 나뉩니다"
                value={sec.lines.join('\n')}
                onChange={(e) => setSection(i, { text: e.target.value })}
              />
              <div className="section-controls">
                <button
                  className="btn btn-icon"
                  disabled={i === 0}
                  title="파트를 위로 이동"
                  onClick={() => moveSection(i, -1)}
                >
                  ↑
                </button>
                <button
                  className="btn btn-icon"
                  disabled={i === song.sections.length - 1}
                  title="파트를 아래로 이동"
                  onClick={() => moveSection(i, 1)}
                >
                  ↓
                </button>
                <button className="btn btn-icon" title="파트 삭제" onClick={() => removeSection(i)}>
                  ✕
                </button>
              </div>
            </div>
          ))}
          <div className="quick-add">
            파트 추가:
            {QUICK_LABELS.map((l) => (
              <button key={l} className="btn btn-chip" onClick={() => addSection(l)}>
                {l}
              </button>
            ))}
            <button className="btn btn-chip" onClick={() => addSection('')}>
              직접 입력
            </button>
          </div>

          <label className="order-row">
            순서
            <input
              data-testid="order-input"
              value={orderText}
              placeholder="예: I-V1-V2-PC-C-C"
              onChange={(e) => {
                setOrderText(e.target.value);
                onChange({ ...song, order: parseOrder(e.target.value) });
              }}
            />
          </label>
          <div className="order-chips">
            {song.order.map((t, i) => (
              <span
                key={i}
                className={`chip ${t === 'I' ? 'chip-i' : missing.has(t) ? 'chip-missing' : 'chip-ok'}`}
                title={t === 'I' ? '간주/제목 슬라이드' : missing.has(t) ? '해당 파트가 없습니다' : undefined}
              >
                {t}
              </span>
            ))}
          </div>

          <div className="song-footer">
            <label>
              슬라이드당 줄 수
              <select
                value={song.linesPerSlide}
                onChange={(e) => onChange({ ...song, linesPerSlide: Number(e.target.value) })}
              >
                {[2, 3, 4, 5, 6].map((n) => (
                  <option key={n} value={n}>
                    {n}줄
                  </option>
                ))}
              </select>
            </label>
            <button
              className="btn"
              onClick={() => {
                onSaveToLibrary(song);
                setSaved(true);
                setTimeout(() => setSaved(false), 1500);
              }}
            >
              {saved ? '✓ 저장됨' : '💾 라이브러리에 저장'}
            </button>
          </div>
        </div>
      </div>

      <div className="preview-strip">
        {plans.map((p, i) => (
          <div key={i} className={`mini-slide ${p.kind}`}>
            {p.kind === 'title' ? (
              <strong className="mini-slide-title">{p.title || '제목'}</strong>
            ) : (
              <>
                <span className="mini-slide-label">{p.title}</span>
                <div className="mini-slide-lines">
                  {p.lines?.map((l, j) => (
                    <div key={j}>{l}</div>
                  ))}
                </div>
              </>
            )}
          </div>
        ))}
        <span className="preview-count">{plans.length}장</span>
      </div>
    </div>
  );
}
