// Unified "일괄 업로드" panel: drop the week's whole file set — the 찬양
//콘티 PDF, the pastor's 설교 PPT, and any custom front/back/성경 말씀
// templates — in ONE action, and each file is routed to the right place by
// filename instead of hunting through separate wizard steps and the
// 관리자 설정 modal. Inspired by phyto.live / acts2-phyto, where a whole
// gathering's content and template are set up together before editing
// begins; adapted here to this app's no-account, client-only architecture
// (a plain multi-file drop instead of an uploaded "gathering").
import { useRef, useState } from 'react';
import {
  routeUploadBatch,
  uploadRoleLabel,
  type RoutedUpload,
  type UploadRole,
} from '../lib/utils/uploadRouter';
import { showToast } from '../lib/utils/toast';

const ASSIGNABLE_ROLES: UploadRole[] = ['sermon', 'front', 'back', 'bible'];

export interface UnifiedUploadHandlers {
  onConti: (file: File) => void;
  onSermon: (file: File) => void;
  onFrontTemplate: (file: File) => void;
  onBackTemplate: (file: File) => void;
  onBibleTemplate: (file: File) => void;
}

interface Props {
  handlers: UnifiedUploadHandlers;
}

function applyRole(handlers: UnifiedUploadHandlers, upload: RoutedUpload): void {
  switch (upload.role) {
    case 'conti':
      handlers.onConti(upload.file);
      break;
    case 'sermon':
      handlers.onSermon(upload.file);
      break;
    case 'front':
      handlers.onFrontTemplate(upload.file);
      break;
    case 'back':
      handlers.onBackTemplate(upload.file);
      break;
    case 'bible':
      handlers.onBibleTemplate(upload.file);
      break;
  }
}

export default function UnifiedUploadPanel({ handlers }: Props) {
  const [dragOver, setDragOver] = useState(false);
  const [open, setOpen] = useState(true);
  const [routed, setRouted] = useState<RoutedUpload[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);

  function processFiles(fileList: FileList | File[]) {
    const files = Array.from(fileList);
    const batch = routeUploadBatch(files);
    if (batch.length === 0) {
      showToast('콘티(.pdf)나 템플릿(.pptx) 파일을 올려주세요.', 'error');
      return;
    }
    for (const upload of batch) applyRole(handlers, upload);
    setRouted(batch);
    // Collapse to a tidy summary once everything was classified confidently;
    // stay open when something needs a manual role check, so the reassignment
    // list is immediately visible instead of requiring an extra click.
    const needsReview = batch.some((upload) => !upload.confident);
    setOpen(needsReview);
    const summary = batch.map((upload) => uploadRoleLabel(upload.role)).join(', ');
    showToast(`${batch.length}개 파일을 업로드했습니다: ${summary}`);
  }

  function reassign(index: number, role: UploadRole) {
    setRouted((current) => {
      const next = current.map((upload, i) => (i === index ? { ...upload, role, confident: true } : upload));
      applyRole(handlers, next[index]);
      showToast(`'${next[index].file.name}'을(를) ${uploadRoleLabel(role)}(으)로 다시 지정했습니다.`);
      return next;
    });
  }

  if (!open) {
    return (
      <section className="card unified-upload unified-upload-collapsed" data-testid="unified-upload-summary">
        <div className="unified-upload-summary-row">
          <p className="unified-upload-summary-text">
            일괄 업로드됨: {routed.map((upload) => `${uploadRoleLabel(upload.role)} (${upload.file.name})`).join(' · ')}
          </p>
          <button type="button" className="btn btn-ghost" data-testid="unified-upload-reopen" onClick={() => setOpen(true)}>
            다시 업로드
          </button>
        </div>
      </section>
    );
  }

  return (
    <section className="card unified-upload" data-testid="unified-upload-panel">
      <h2>📦 콘티와 템플릿을 한 번에 업로드</h2>
      <p className="tool-intro" style={{ margin: '0 0 14px' }}>
        찬양 콘티 PDF, 설교 PPT, 표지·마무리·성경 말씀 템플릿을 한꺼번에 끌어다 놓으세요. 파일 이름으로
        자동 구분해서 각자 맞는 자리에 채워 드립니다 (아래에서 다시 지정할 수 있어요).
      </p>
      <div
        className={`dropzone${dragOver ? ' dragover' : ''}`}
        data-testid="unified-upload-dropzone"
        onClick={() => inputRef.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          if (e.dataTransfer.files.length > 0) processFiles(e.dataTransfer.files);
        }}
      >
        <p className="dropzone-title">📄📊 콘티 PDF + 템플릿 PPTX 파일을 한 번에 끌어다 놓거나 클릭하세요</p>
        <p className="dropzone-sub">
          예: 콘티.pdf, 설교.pptx, 표지템플릿.pptx, 마무리템플릿.pptx, 말씀템플릿.pptx — 여러 개를 한 번에
          선택할 수 있습니다.
        </p>
      </div>
      <input
        ref={inputRef}
        type="file"
        multiple
        accept=".pdf,.pptx"
        data-testid="unified-upload-input"
        className="visually-hidden-input"
        onChange={(e) => {
          if (e.target.files && e.target.files.length > 0) processFiles(e.target.files);
          e.target.value = '';
        }}
      />
      {routed.length > 0 && (
        <ul className="unified-upload-list" data-testid="unified-upload-list">
          {routed.map((upload, index) => (
            <li key={`${upload.file.name}-${index}`} className="unified-upload-row">
              <span className="unified-upload-name">{upload.file.name}</span>
              {upload.role === 'conti' ? (
                <span className="chip chip-ok">{uploadRoleLabel('conti')}</span>
              ) : (
                <label className="unified-upload-role">
                  {!upload.confident && <span className="chip chip-warn">확인 필요</span>}
                  <select
                    value={upload.role}
                    data-testid={`unified-upload-role-${index}`}
                    onChange={(e) => reassign(index, e.target.value as UploadRole)}
                  >
                    {ASSIGNABLE_ROLES.map((role) => (
                      <option key={role} value={role}>
                        {uploadRoleLabel(role)}
                      </option>
                    ))}
                  </select>
                </label>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
