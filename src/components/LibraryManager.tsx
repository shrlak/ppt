import { useRef } from 'react';
import type { LibraryEntry } from '../lib/types';

interface Props {
  library: LibraryEntry[];
  onDelete: (title: string) => void;
  onImport: (entries: LibraryEntry[]) => void;
}

export default function LibraryManager({ library, onDelete, onImport }: Props) {
  const fileRef = useRef<HTMLInputElement>(null);

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
          {library.map((e) => (
            <tr key={e.title}>
              <td>{e.title}</td>
              <td>{e.key ?? '-'}</td>
              <td>{e.sections.map((s) => s.label).join(', ')}</td>
              <td>
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
        </tbody>
      </table>
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
