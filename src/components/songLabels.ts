/**
 * Pick the next free label for a quick-add click. A song can have many
 * verses/pre-choruses/choruses, so re-clicking the same button (or clicking
 * "V1" once "V1" already exists) should offer "V2", "V3", ... instead of a
 * duplicate label — the label text itself stays fully editable either way.
 */
export function nextAvailableLabel(existing: string[], base: string): string {
  const used = new Set(existing.map((l) => l.trim().toUpperCase()));
  const wantedUpper = base.toUpperCase();
  if (!used.has(wantedUpper)) return base;
  const stem = base.replace(/\d+$/, '');
  let n = 2;
  while (used.has(`${stem.toUpperCase()}${n}`)) n++;
  return `${stem}${n}`;
}

/** How sure the app is about a song's lyrics, in the words the card shows. */
export type SongTrustLabel = '확인 필요' | '웹 확인' | '검증됨';

export interface SongTrustBadge {
  label: SongTrustLabel;
  /** Explains the badge to a screen reader, and to anyone hovering it. */
  detail: string;
  /** Styling hook; the label text carries the same meaning without colour. */
  tone: 'warn' | 'info' | 'ok';
}

/**
 * Pick the badge for a song.
 *
 * The three states answer one question — can this be printed without looking
 * at it? A verified song can; a song waiting on a web choice cannot; a song
 * the models were unsure about needs eyes on it. The label text says which,
 * so the badge does not rely on colour alone.
 */
export function songTrustBadge(options: {
  verification?: 'draft' | 'verified' | 'edited';
  needsReview?: boolean;
  webDecision?: 'auto' | 'review' | 'none';
}): SongTrustBadge | null {
  if (options.verification === 'verified' || options.verification === 'edited') {
    return { label: '검증됨', detail: '저장된 가사입니다. 그대로 사용해도 됩니다.', tone: 'ok' };
  }
  if (options.webDecision === 'review') {
    return { label: '웹 확인', detail: '웹에서 비슷한 곡을 여러 개 찾았습니다. 맞는 가사를 골라 주세요.', tone: 'info' };
  }
  if (options.needsReview) {
    return { label: '확인 필요', detail: '모델들이 서로 다르게 읽은 부분이 있습니다. 악보와 비교해 확인해 주세요.', tone: 'warn' };
  }
  return null;
}

/** Percentage a candidate's match score is shown as. */
export function candidateScorePercent(score: number): number {
  return Math.round(Math.min(1, Math.max(0, score)) * 100);
}
