import { useMemo, useRef, useState } from 'react';
import type { LibraryEntry } from '../lib/utils/types';
import { normalizeTitle } from '../lib/storage/library';

interface Props {
  library: LibraryEntry[];
  onDelete: (title: string) => void;
  onImport: (entries: LibraryEntry[]) => void;
  /** When provided, each row can be added straight to this week's setlist. */
  onAdd?: (entry: LibraryEntry) => void;
}

/** Flatten an entry's title + every lyric line into one searchable, normalized blob. */
function searchIndex(entry: LibraryEntry): string {
  const lyrics = entry.sections.flatMap((s) => s.lines).join(' ');
  return normalizeTitle(`${entry.title} ${entry.key ?? ''} ${lyrics}`);
}

export default function LibraryManager({ library, onDelete, onImport, onAdd }: Props) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');

  const results = useMemo(() => {
    const q = normalizeTitle(query);
    if (!q) return library;
    // Match on title or lyrics, but float title hits to the top so the song a
    // user is naming appears first, ahead of songs that merely quote the word.
    const titleHits: LibraryEntry[] = [];
    const lyricHits: LibraryEntry[] = [];
    for (const e of library) {
      if (normalizeTitle(e.title).includes(q)) titleHits.push(e);
      else if (searchIndex(e).includes(q)) lyricHits.push(e);
    }
    return [...titleHits, ...lyricHits];
  }, [library, query]);

  function exportJson() {
    const blob = new Blob([JSON.stringify(library, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = '찬양 라이브러리.json';
    a.click();
    URL.revokeObjectURL(url);
  }

  async function importJson(file: File) {
    try {
      const data = JSON.parse(await file.text()) as LibraryEntry[];
      if (Array.isArray(data)) onImport(data);
    } catch {
      window.alert('JSON 파일을 읽지 못했습니다.');
    }
  }

  return (
    <div className="library-manager">
      <div className="library-search">
        <span className="library-search-icon" aria-hidden>
          🔎
        </span>
        <input
          className="library-search-input"
          data-testid="library-search"
          type="search"
          placeholder="제목이나 가사로 찬양 검색…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          autoFocus
        />
        {query && (
          <button className="library-search-clear" aria-label="검색어 지우기" onClick={() => setQuery('')}>
            ✕
          </button>
        )}
      </div>
      <p className="library-count" data-testid="library-count">
        {query ? `검색 결과 ${results.length}곡` : `전체 ${library.length}곡`}
      </p>

      <div className="library-scroll">
        <table>
          <thead>
            <tr>
              <th>제목</th>
              <th>키</th>
              <th>파트</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {results.map((e) => (
              <tr key={e.title} data-testid="library-row">
                <td className="library-title">{e.title}</td>
                <td>{e.key ?? '-'}</td>
                <td className="library-parts">{e.sections.map((s) => s.label).join(', ') || '-'}</td>
                <td className="library-row-actions">
                  {onAdd && (
                    <button
                      className="btn btn-chip"
                      data-testid="library-add-btn"
                      title="이번 콘티 목록에 추가"
                      onClick={() => onAdd(e)}
                    >
                      ＋ 추가
                    </button>
                  )}
                  <button
                    className="btn btn-icon btn-danger"
                    title="내 저장본 삭제 (기본 곡은 초기 상태로 돌아갑니다)"
                    onClick={() => {
                      if (window.confirm(`'${e.title}' 저장본을 삭제할까요?`)) onDelete(e.title);
                    }}
                  >
                    🗑
                  </button>
                </td>
              </tr>
            ))}
            {results.length === 0 && (
              <tr>
                <td colSpan={4} className="library-empty">
                  '{query}' 와(과) 일치하는 찬양이 없습니다.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="library-actions">
        <button className="btn" onClick={exportJson}>
          ⬇ JSON 내보내기
        </button>
        <button className="btn" onClick={() => fileRef.current?.click()}>
          ⬆ JSON 가져오기
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="application/json,.json"
          className="visually-hidden-input"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void importJson(f);
            e.target.value = '';
          }}
        />
      </div>
    </div>
  );
}
