// Classifies files dropped into the unified "일괄 업로드" panel by extension
// and filename keywords, so a whole week's worth of files — the 콘티 PDF, the
// pastor's 설교 PPT, and any custom front/back/성경 말씀 templates — can be
// routed to the right place from a single drop instead of hunting through
// separate wizard steps and the 관리자 설정 modal.

export type UploadRole = 'conti' | 'sermon' | 'front' | 'back' | 'bible';

interface RoleKeyword {
  role: UploadRole;
  keywords: string[];
}

// Checked in order; the first match wins. Front/back checked before the
// generic 설교 fallback so a "표지" or "마무리" deck is never mistaken for a
// sermon just because it also isn't obviously a bible template.
const PPTX_KEYWORDS: RoleKeyword[] = [
  { role: 'bible', keywords: ['말씀', '성경', 'bible', 'verse', 'scripture'] },
  { role: 'front', keywords: ['표지', '시작', 'front', 'intro', 'opening'] },
  { role: 'back', keywords: ['마무리', '클로징', '종료', 'back', 'closing', 'ending', 'outro'] },
  { role: 'sermon', keywords: ['설교', '말씀말씀', 'sermon', 'message', 'preach', 'pastor'] },
];

/**
 * Guess which slot a dropped .pptx belongs in from its filename. Returns
 * null when no keyword matches — the caller should let the user assign the
 * role explicitly rather than guessing wrong silently.
 */
export function classifyPptxByName(fileName: string): UploadRole | null {
  const normalized = fileName.toLowerCase();
  for (const { role, keywords } of PPTX_KEYWORDS) {
    if (keywords.some((keyword) => normalized.includes(keyword))) return role;
  }
  return null;
}

export interface RoutedUpload {
  file: File;
  /** Best-guess role; 'sermon' is the fallback for an unrecognized .pptx name. */
  role: UploadRole;
  /** False when the role came from the unrecognized-name fallback, not a keyword match. */
  confident: boolean;
}

const ROLE_LABELS: Record<UploadRole, string> = {
  conti: '찬양 콘티',
  sermon: '설교 PPT',
  front: 'Front 템플릿',
  back: 'Back 템플릿',
  bible: '성경 말씀 템플릿',
};

export function uploadRoleLabel(role: UploadRole): string {
  return ROLE_LABELS[role];
}

/**
 * Classify a batch of dropped files in one pass. Only the FIRST .pdf becomes
 * the conti (a conti is one document); every .pptx gets its own row so nothing
 * is silently dropped when several templates are dropped together. Any other
 * file type is ignored.
 */
export function routeUploadBatch(files: File[]): RoutedUpload[] {
  const routed: RoutedUpload[] = [];
  let contiAssigned = false;
  for (const file of files) {
    const name = file.name.toLowerCase();
    if (name.endsWith('.pdf')) {
      if (contiAssigned) continue; // only one conti per batch
      contiAssigned = true;
      routed.push({ file, role: 'conti', confident: true });
      continue;
    }
    if (name.endsWith('.pptx')) {
      const guess = classifyPptxByName(file.name);
      routed.push({ file, role: guess ?? 'sermon', confident: guess !== null });
    }
  }
  return routed;
}
