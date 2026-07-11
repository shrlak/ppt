import { useRef } from 'react';

export interface SermonFile {
  name: string;
  data: ArrayBuffer;
}

interface Props {
  value: SermonFile | null;
  onChange: (file: SermonFile | null) => void;
}

/** Lets the pastor's own sermon slides (a separate .pptx) be spliced into the combined deck, right after the 말씀 slides. */
export default function SermonUploadSection({ value, onChange }: Props) {
  const fileInputRef = useRef<HTMLInputElement>(null);

  async function handleUpload(file: File) {
    if (!file.name.endsWith('.pptx')) return;
    onChange({ name: file.name, data: await file.arrayBuffer() });
  }

  return (
    <section className="card">
      <h2>설교 PPT 업로드</h2>
      <p className="tool-intro" style={{ margin: '0 0 14px' }}>
        말씀 슬라이드 다음에 그대로 삽입됩니다. 목사님께 받은 설교 PPT 파일을 업로드하세요 (선택).
      </p>
      {value ? (
        <div className="template-row">
          <span className="input-hint">업로드됨: {value.name}</span>
          <button className="btn" onClick={() => fileInputRef.current?.click()}>
            변경
          </button>
          <button className="btn btn-ghost" onClick={() => onChange(null)}>
            제거
          </button>
        </div>
      ) : (
        <div
          className="dropzone"
          data-testid="sermon-dropzone"
          onClick={() => fileInputRef.current?.click()}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            const file = e.dataTransfer.files[0];
            if (file) void handleUpload(file);
          }}
        >
          <p className="dropzone-title">📄 설교 PPT 파일을 여기에 끌어다 놓거나 클릭하세요</p>
          <p className="dropzone-sub">업로드하지 않으면 이 순서를 건너뜁니다.</p>
        </div>
      )}
      <input
        ref={fileInputRef}
        type="file"
        accept=".pptx"
        data-testid="sermon-input"
        className="visually-hidden-input"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void handleUpload(file);
          e.target.value = '';
        }}
      />
    </section>
  );
}
