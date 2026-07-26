// 라이브러리: browse past generated decks, each saved together with the
// source files (conti PDF, 설교 PPT) that built it, so a specific week's
// material can be found and re-downloaded later without regenerating it.
import { useEffect, useState } from 'react';
import Modal from './Modal';
import {
  deleteSavedDeck,
  getSavedDeck,
  getSavedDeckFile,
  listSavedDecks,
  type PptLibrarySnapshot,
  type SavedDeck,
  type SavedDeckSummary,
  type SavedFile,
  type SavedFileKind,
} from '../lib/storage/pptLibrary';
import { showToast } from '../lib/utils/toast';

interface Props {
  onClose: () => void;
  /** Hands a fully loaded deck to the app, which reopens it in the 단계별 editor. */
  onEdit: (deck: SavedDeck) => void;
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
  deck: SavedDeckSummary;
  onEdit: (deck: SavedDeck) => void;
  onDeleted: (id: string) => void;
}) {
  const [deleting, setDeleting] = useState(false);
  const [loading, setLoading] = useState<SavedFileKind | 'edit' | null>(null);

  async function handleDownload(kind: SavedFileKind) {
    setLoading(kind);
    try {
      const file = await getSavedDeckFile(deck.id, kind);
      if (!file) throw new Error('저장된 원본 파일을 찾지 못했습니다.');
      downloadFile(file);
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), 'error');
    } finally {
      setLoading(null);
    }
  }

  async function handleEdit() {
    setLoading('edit');
    try {
      onEdit(await getSavedDeck(deck.id));
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), 'error');
    } finally {
      setLoading(null);
    }
  }

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
          {deck.syncPending ? ' · 동기화 대기' : ''}
        </p>
      </div>
      <div className="library-entry-actions">
        <button
          type="button"
          className="btn"
          disabled={loading !== null}
          onClick={() => void handleDownload('pptx')}
        >
          {loading === 'pptx' ? '불러오는 중…' : 'PPTX 다운로드'}
        </button>
        {deck.contiPdf && (
          <button
            type="button"
            className="btn btn-ghost"
            disabled={loading !== null}
            onClick={() => void handleDownload('contiPdf')}
          >
            {loading === 'contiPdf' ? '불러오는 중…' : '콘티 PDF'}
          </button>
        )}
        {deck.sermonPptx && (
          <button
            type="button"
            className="btn btn-ghost"
            disabled={loading !== null}
            onClick={() => void handleDownload('sermonPptx')}
          >
            {loading === 'sermonPptx' ? '불러오는 중…' : '설교 PPT'}
          </button>
        )}
        <button
          type="button"
          className="btn btn-ghost"
          data-testid="library-entry-edit"
          disabled={loading !== null}
          onClick={() => void handleEdit()}
        >
          {loading === 'edit' ? '불러오는 중…' : '편집'}
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

export default function PptLibraryPanel({ onClose, onEdit }: Props) {
  const [snapshot, setSnapshot] = useState<PptLibrarySnapshot | null>(null);

  useEffect(() => {
    let cancelled = false;
    const refresh = () => {
      void listSavedDecks().then((loaded) => {
        if (!cancelled) setSnapshot(loaded);
      });
    };
    refresh();
    window.addEventListener('focus', refresh);
    return () => {
      cancelled = true;
      window.removeEventListener('focus', refresh);
    };
  }, []);

  const decks = snapshot?.decks ?? null;

  return (
    <Modal title="PPT 라이브러리" onClose={onClose}>
      <p className="admin-intro">
        저장한 예배 PPT와 콘티 PDF·설교 PPT를 어느 기기에서나 다시 열고 다운로드할 수 있습니다.
        <strong> 편집</strong>을 누르면 저장할 때의 입력 내용 그대로 찬양·성경 말씀·설교·광고 단계가
        다시 열리고, 저장하면 같은 항목이 갱신됩니다.
      </p>
      {snapshot && (
        <p className={`admin-sync admin-sync-${snapshot.sync}`} data-testid="ppt-library-sync" role="status">
          {snapshot.sync === 'synced'
            ? '공유 서버에 저장됨 · 모든 기기와 동기화됩니다.'
            : snapshot.sync === 'pending'
              ? '일부 변경 사항이 이 기기에 안전하게 보관되어 있으며 서버 연결 시 자동으로 다시 동기화됩니다.'
              : '공유 서버 미연결 · 이 기기에만 저장됩니다.'}
        </p>
      )}
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
              onEdit={onEdit}
              onDeleted={(id) =>
                setSnapshot((current) =>
                  current ? { ...current, decks: current.decks.filter((candidate) => candidate.id !== id) } : current,
                )
              }
            />
          ))}
        </div>
      )}
    </Modal>
  );
}
