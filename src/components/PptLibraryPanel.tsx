// 라이브러리: browse past generated decks, each saved together with the
// source files (conti PDF, 설교 PPT) that built it, so a specific week's
// material can be found and re-downloaded later without regenerating it.
import { useEffect, useState } from 'react';
import Modal from './Modal';
import PptLibraryEditor from './PptLibraryEditor';
import { deleteSavedDeck, listSavedDecks, type SavedDeck, type SavedFile } from '../lib/storage/pptLibrary';
import { showToast } from '../lib/utils/toast';

interface Props {
  onClose: () => void;
}

function downloadFile(file: SavedFile) {
  const blob = new Blob([file.data]);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = file.name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function LibraryEntryCard({
  deck,
  onEdit,
  onDeleted,
}: {
  deck: SavedDeck;
  onEdit: (deck: SavedDeck) => void;
  onDeleted: (id: string) => void;
}) {
  const [deleting, setDeleting] = useState(false);

  async function handleDelete() {
    if (!window.confirm(`'${deck.name}'을(를) 라이브러리에서 삭제할까요?`)) return;
    setDeleting(true);
    try {
      await deleteSavedDeck(deck.id);
      onDeleted(deck.id);
      showToast(`'${deck.name}'을(를) 라이브러리에서 삭제했습니다.`);
    } catch (e) {
      showToast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setDeleting(false);
    }
  }

  return (
    <article className="library-entry" data-testid="library-entry">
      <div className="library-entry-info">
        <strong className="library-entry-name">{deck.name}</strong>
        <p className="library-entry-meta">
          {new Date(deck.savedAt).toLocaleString('ko-KR')} · {deck.slideCount}장
          {deck.songTitles.length > 0 ? ` · ${deck.songTitles.join(', ')}` : ''}
        </p>
      </div>
      <div className="library-entry-actions">
        <button type="button" className="btn" onClick={() => downloadFile(deck.pptx)}>
          PPTX 다운로드
        </button>
        {deck.contiPdf && (
          <button type="button" className="btn btn-ghost" onClick={() => downloadFile(deck.contiPdf!)}>
            콘티 PDF
          </button>
        )}
        {deck.sermonPptx && (
          <button type="button" className="btn btn-ghost" onClick={() => downloadFile(deck.sermonPptx!)}>
            설교 PPT
          </button>
        )}
        <button type="button" className="btn btn-ghost" data-testid="library-entry-edit" onClick={() => onEdit(deck)}>
          편집
        </button>
        <button
          type="button"
          className="btn btn-ghost"
          data-testid="library-entry-delete"
          disabled={deleting}
          onClick={() => void handleDelete()}
        >
          삭제
        </button>
      </div>
    </article>
  );
}

export default function PptLibraryPanel({ onClose }: Props) {
  const [decks, setDecks] = useState<SavedDeck[] | null>(null);
  const [editingDeck, setEditingDeck] = useState<SavedDeck | null>(null);

  useEffect(() => {
    let cancelled = false;
    void listSavedDecks().then((loaded) => {
      if (!cancelled) setDecks(loaded);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  function handleSaved(updated: SavedDeck) {
    setDecks((current) => (current ?? []).map((d) => (d.id === updated.id ? updated : d)));
  }

  return (
    <>
      <Modal title="PPT 라이브러리" onClose={onClose}>
        <p className="admin-intro">
          저장한 예배 PPT와 그 콘티 PDF·설교 PPT를 이 브라우저에서 다시 찾아볼 수 있습니다. 다운로드
          단계의 &apos;라이브러리에 저장&apos; 버튼으로 지금 만든 PPT를 추가하세요.
        </p>
        {decks === null ? (
          <p className="empty-hint">불러오는 중…</p>
        ) : decks.length === 0 ? (
          <p className="empty-hint" data-testid="library-empty">
            아직 저장된 PPT가 없습니다.
          </p>
        ) : (
          <div className="library-list" data-testid="library-list">
            {decks.map((deck) => (
              <LibraryEntryCard
                key={deck.id}
                deck={deck}
                onEdit={setEditingDeck}
                onDeleted={(id) => setDecks((current) => (current ?? []).filter((d) => d.id !== id))}
              />
            ))}
          </div>
        )}
      </Modal>
      {editingDeck && (
        <PptLibraryEditor
          key={editingDeck.id}
          deck={editingDeck}
          onClose={() => setEditingDeck(null)}
          onSaved={handleSaved}
        />
      )}
    </>
  );
}
