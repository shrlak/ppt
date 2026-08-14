import { useRef, useState } from 'react';
import { inspectAdditionalUpload } from '../lib/additionalFiles/convert';
import { moveAdditionalFile } from '../lib/additionalFiles/files';
import { SUPPORTED_ADDITIONAL_ACCEPT, type AdditionalFile } from '../lib/additionalFiles/types';
import Icon from './Icon';

interface Props {
  value: AdditionalFile[];
  onChange: (files: AdditionalFile[]) => void;
}

const KIND_LABEL: Record<AdditionalFile['kind'], string> = {
  pdf: 'PDF',
  pptx: 'PPTX',
  png: 'PNG',
  jpeg: 'JPG',
};

export default function AdditionalFilesSection({ value, onChange }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [loading, setLoading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function addFiles(files: FileList | File[]) {
    if (files.length === 0 || loading) return;
    setLoading(true);
    setError(null);
    const inspected: AdditionalFile[] = [];
    try {
      for (const file of Array.from(files)) inspected.push(await inspectAdditionalUpload(file));
      onChange([...value, ...inspected]);
    } catch (uploadError) {
      if (inspected.length > 0) onChange([...value, ...inspected]);
      setError(uploadError instanceof Error ? uploadError.message : String(uploadError));
    } finally {
      setLoading(false);
    }
  }

  return (
    <section className="card additional-files-section" data-testid="additional-files-section">
      <h3>End 이후 추가 자료</h3>
      <p className="tool-intro">
        PDF, PPTX, PNG, JPG 파일을 올리면 Back/End 슬라이드의 마지막 다음에 아래 순서대로 붙습니다.
      </p>
      <button
        type="button"
        className={`dropzone${dragging ? ' dragover' : ''}`}
        onClick={() => inputRef.current?.click()}
        onDragEnter={() => setDragging(true)}
        onDragLeave={() => setDragging(false)}
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          void addFiles(event.dataTransfer.files);
        }}
      >
        <span className="dropzone-title">
          <Icon name="upload" />
          추가할 파일을 여기에 끌어다 놓거나 클릭하세요
        </span>
        <span className="dropzone-sub">PDF는 페이지별, 이미지는 파일별, PPTX는 원본 슬라이드별로 추가됩니다.</span>
      </button>
      <input
        ref={inputRef}
        type="file"
        multiple
        accept={SUPPORTED_ADDITIONAL_ACCEPT}
        className="visually-hidden-input"
        data-testid="additional-files-input"
        tabIndex={-1}
        onChange={(event) => {
          if (event.target.files) void addFiles(event.target.files);
          event.target.value = '';
        }}
      />

      {loading && (
        <p className="additional-files-status" role="status">
          <span className="spinner" aria-hidden="true" />
          파일을 확인하고 있습니다…
        </p>
      )}
      {error && (
        <p className="banner banner-error additional-files-error" role="alert">
          <Icon name="error" />
          <span className="banner-text">{error}</span>
        </p>
      )}

      {value.length > 0 && (
        <ol className="additional-file-list" aria-label="End 이후 파일 순서">
          {value.map((file, index) => (
            <li className="additional-file-row" data-testid="additional-file-row" key={file.id}>
              <span className="additional-file-position">END + {index + 1}</span>
              <span className="additional-file-icon">
                <Icon name="file" />
              </span>
              <span className="additional-file-info">
                <strong>{file.name}</strong>
                <span>
                  {KIND_LABEL[file.kind]} · {file.slideCount}장
                </span>
              </span>
              <span className="additional-file-controls">
                <button
                  type="button"
                  className="btn btn-icon"
                  data-testid="additional-file-up"
                  aria-label={`${file.name} 위로 이동`}
                  disabled={index === 0}
                  onClick={() => onChange(moveAdditionalFile(value, file.id, -1))}
                >
                  <Icon name="up" />
                </button>
                <button
                  type="button"
                  className="btn btn-icon"
                  data-testid="additional-file-down"
                  aria-label={`${file.name} 아래로 이동`}
                  disabled={index === value.length - 1}
                  onClick={() => onChange(moveAdditionalFile(value, file.id, 1))}
                >
                  <Icon name="down" />
                </button>
                <button
                  type="button"
                  className="btn btn-icon btn-danger"
                  data-testid="additional-file-delete"
                  aria-label={`${file.name} 삭제`}
                  onClick={() => onChange(value.filter((candidate) => candidate.id !== file.id))}
                >
                  <Icon name="trash" />
                </button>
              </span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
