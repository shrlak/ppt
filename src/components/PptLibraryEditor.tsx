// Edits a single 라이브러리 entry in place: rename it, and/or drop or reorder
// slides in its saved .pptx. Reuses the same real-slide renderer the 편집기
// view uses for thumbnails (renderPptxSlides) and the same slice primitive
// the deck builder uses to pull fixed slides out of a template
// (extractSlideSubset), so the rebuilt file is exactly as trustworthy as a
// freshly generated one — validated with assertPptxIntegrity before saving.
import { useEffect, useState } from 'react';
import Modal from './Modal';
import SlideThumbnail from './SlideThumbnail';
import { assertPptxIntegrity } from '../lib/pptx/pptxPackage';
import { renderPptxSlides, revokeRenderedSlides, type RenderedSlide } from '../lib/pptx/pptxRenderer';
import { extractSlideSubset } from '../lib/pptx/pptxSlices';
import { updateSavedDeck, type SavedDeck } from '../lib/storage/pptLibrary';
import { showToast } from '../lib/utils/toast';

interface Props {
  deck: SavedDeck;
  onClose: () => void;
  onSaved: (deck: SavedDeck) => void;
}

const THUMB_WIDTH = 140;

export default function PptLibraryEditor({ deck, onClose, onSaved }: Props) {
  const [name, setName] = useState(deck.name);
  const [slides, setSlides] = useState<RenderedSlide[] | null>(null);
  // 1-based positions into `slides`, in the order the saved deck should end
  // up in — starts as identity ([1, 2, 3, ...]) and is reordered/shortened
  // by the controls below, never touching `slides` itself.
  const [order, setOrder] = useState<number[]>(() => Array.from({ length: deck.slideCount }, (_, i) => i + 1));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let rendered: RenderedSlide[] | null = null;
    void renderPptxSlides(deck.pptx.data)
      .then((result) => {
        if (cancelled) {
          revokeRenderedSlides(result);
          return;
        }
        rendered = result;
        setSlides(result);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
      if (rendered) revokeRenderedSlides(rendered);
    };
    // deck.id is stable for the life of this modal — the effect intentionally
    // doesn't re-run just because `deck` gets a new object identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deck.id]);

  function moveSlide(pos: number, delta: -1 | 1) {
    setOrder((previous) => {
      const target = pos + delta;
      if (target < 0 || target >= previous.length) return previous;
      const next = previous.slice();
      [next[pos], next[target]] = [next[target], next[pos]];
      return next;
    });
  }

  function removeSlide(pos: number) {
    setOrder((previous) => (previous.length <= 1 ? previous : previous.filter((_, i) => i !== pos)));
  }

  async function handleSave() {
    const trimmed = name.trim();
    if (!trimmed) {
      showToast('이름을 입력해 주세요.', 'error');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const normalizedName = trimmed.endsWith('.pptx') ? trimmed : `${trimmed}.pptx`;
      const isUnchangedOrder =
        order.length === deck.slideCount && order.every((slideNumber, i) => slideNumber === i + 1);

      let data = deck.pptx.data;
      let slideCount = deck.slideCount;
      if (!isUnchangedOrder) {
        const bytes = await extractSlideSubset(deck.pptx.data, order);
        await assertPptxIntegrity(bytes);
        data = bytes.buffer as ArrayBuffer;
        slideCount = order.length;
      }

      const updated: SavedDeck = { ...deck, name: normalizedName, pptx: { name: normalizedName, data }, slideCount };
      const saved = await updateSavedDeck(updated);
      showToast(
        saved.syncPending
          ? `'${normalizedName}'을(를) 수정했습니다. 서버 연결 시 다른 기기에도 자동으로 반영됩니다.`
          : `'${normalizedName}'을(를) 수정했습니다.`,
      );
      onSaved(saved);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal title="PPT 편집" wide onClose={onClose}>
      <label className="deck-editor-name" htmlFor="library-edit-name">
        이름
        <input
          id="library-edit-name"
          data-testid="library-edit-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </label>

      <div className="deck-editor-header">
        <p className="deck-editor-hint">
          슬라이드를 삭제하거나 순서를 바꿀 수 있습니다. 저장하면 라이브러리에 저장된 PPTX 파일이 바로
          바뀝니다.
        </p>
        <span className="deck-editor-count" data-testid="library-edit-slide-count">
          {order.length}장
        </span>
      </div>

      {error && <p className="banner banner-warn">{error}</p>}

      <ol className="deck-editor-list" data-testid="library-edit-slide-list">
        {order.map((slideNumber, pos) => (
          <li key={slideNumber} className="deck-editor-row" data-testid="library-edit-slide-row">
            <SlideThumbnail slide={slides?.[slideNumber - 1]} width={THUMB_WIDTH} />
            <span className="deck-editor-row-index">{pos + 1}</span>
            <div className="deck-editor-row-controls">
              <button
                type="button"
                className="btn btn-icon"
                aria-label="위로 이동"
                disabled={pos === 0}
                onClick={() => moveSlide(pos, -1)}
              >
                ▲
              </button>
              <button
                type="button"
                className="btn btn-icon"
                aria-label="아래로 이동"
                disabled={pos === order.length - 1}
                onClick={() => moveSlide(pos, 1)}
              >
                ▼
              </button>
              <button
                type="button"
                className="btn btn-icon btn-danger"
                aria-label="슬라이드 삭제"
                data-testid="library-edit-slide-remove"
                disabled={order.length <= 1}
                title={order.length <= 1 ? '최소 한 장은 남아 있어야 합니다.' : undefined}
                onClick={() => removeSlide(pos)}
              >
                ✕
              </button>
            </div>
          </li>
        ))}
        {slides === null && (
          <li className="deck-editor-loading" data-testid="library-edit-loading">
            슬라이드를 불러오는 중…
          </li>
        )}
      </ol>

      <div className="deck-editor-actions">
        <button
          type="button"
          className="btn btn-primary"
          data-testid="library-edit-save"
          disabled={saving}
          onClick={() => void handleSave()}
        >
          {saving ? '저장 중…' : '저장'}
        </button>
      </div>
    </Modal>
  );
}
