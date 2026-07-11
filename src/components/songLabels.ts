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
