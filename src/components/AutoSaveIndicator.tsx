// Status line for the automatic 라이브러리 save. Auto-save runs quietly in the
// background, so this is the only place it reports itself — a toast per edit
// would be noise. Rendered next to both manual 저장 buttons (다운로드 단계 and
// the 편집기 toolbar), which is why the test id is a prop.
import { autoSaveLabel, type AutoSaveStatus } from '../lib/storage/deckAutoSave';

interface Props {
  status: AutoSaveStatus;
  testId: string;
}

export default function AutoSaveIndicator({ status, testId }: Props) {
  return (
    <p
      className={`auto-save-status auto-save-${status.state}`}
      data-testid={testId}
      data-state={status.state}
      role="status"
      aria-live="polite"
    >
      <span className="auto-save-dot" aria-hidden="true" />
      {autoSaveLabel(status)}
    </p>
  );
}
