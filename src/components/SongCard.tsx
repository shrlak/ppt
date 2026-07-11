import { useEffect, useState } from 'react';
import type { Song } from '../lib/types';
import { formatOrder, parseOrder } from '../lib/orderParser';
import { planSlides, unmatchedTokens } from '../lib/slidePlanner';
import { nextAvailableLabel } from './songLabels';

/** Live status of auto-recognizing a song's score image. */
export interface RecogState {
  status: 'running' | 'done' | 'error';
  progress?: number;
  message?: string;
}

interface Props {
  song: Song;
  index: number;
  total: number;
  pageImage?: string;
  recog?: RecogState;
  onRecognize?: () => void;
  onChange: (song: Song) => void;
  onMove: (id: string, delta: -1 | 1) => void;
  onRemove: (id: string) => void;
  onSaveToLibrary: (song: Song) => void;
  onZoom: () => void;
  onTitleBlur: (title: string) => void;
}

const QUICK_LABELS = ['V1', 'V2', 'PC', 'C', 'B'];

export default function SongCard({
  song,
  index,
  total,
  pageImage,
  recog,
  onRecognize,
  onChange,
  onMove,
  onRemove,
  onSaveToLibrary,
  onZoom,
  onTitleBlur,
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

  return (
    <div className="song-card" data-testid="song-card">
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
        {pageImage ? (
          <div className="score-pane">
            <img src={pageImage} alt="악보 미리보기" onClick={onZoom} />
            <span className="score-hint">클릭하면 크게 보며 가사를 입력할 수 있어요 (p.{song.pageIndex})</span>
            {onRecognize && (
              <div className="recog-box" data-testid="recog-box">
                {recog?.status === 'running' ? (
                  <div className="recog-running">
                    <div className="spinner" />
                    <span>
                      가사 인식 중…
                      {typeof recog.progress === 'number' ? ` ${Math.round(recog.progress * 100)}%` : ''}
                    </span>
                  </div>
                ) : (
                  <>
                    <button className="btn btn-chip" data-testid="recognize-btn" onClick={onRecognize}>
                      {recog?.status === 'done' ? '↻ 다시 인식' : '✨ 가사 자동 인식'}
                    </button>
                    {recog?.status === 'error' && (
                      <span className="recog-error" title={recog.message}>
                        인식 실패 — 다시 시도하거나 직접 입력하세요.
                      </span>
                    )}
                    {recog?.status === 'done' && <span className="recog-done">✓ 인식 완료 · 확인해 주세요</span>}
                  </>
                )}
              </div>
            )}
          </div>
        ) : song.pageIndex != null ? (
          <div className="score-pane score-loading">악보 미리보기 준비 중… (p.{song.pageIndex})</div>
        ) : null}

        <div className="editor-pane">
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
                placeholder="가사를 한 줄씩 입력하세요"
                value={sec.lines.join('\n')}
                onChange={(e) => setSection(i, { text: e.target.value })}
              />
              <button className="btn btn-icon" title="파트 삭제" onClick={() => removeSection(i)}>
                ✕
              </button>
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
              <strong>{p.title || '제목'}</strong>
            ) : (
              p.lines?.map((l, j) => <div key={j}>{l}</div>)
            )}
          </div>
        ))}
        <span className="preview-count">{plans.length}장</span>
      </div>
    </div>
  );
}
