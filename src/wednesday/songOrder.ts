// Reordering the week's songs by dragging a card, kept apart from the card so
// the arithmetic can be checked without a browser.

/** The list with the item `id` moved to position `target` (0-based, among the others). */
export function moveSongTo<T extends { id: string }>(items: readonly T[], id: string, target: number): T[] {
  const from = items.findIndex((item) => item.id === id);
  if (from === -1) return [...items];
  const rest = items.filter((item) => item.id !== id);
  const at = Math.max(0, Math.min(target, rest.length));
  if (at === from) return [...items];
  return [...rest.slice(0, at), items[from], ...rest.slice(at)];
}

/**
 * Where a card being dragged would land: after every other card whose middle
 * it has passed. `middles` are the cards' vertical middles where they lay when
 * the drag began, `from` is the dragged card's index, and `center` is where
 * its middle is now — all in the same coordinates.
 */
export function dropIndex(middles: readonly number[], from: number, center: number): number {
  let target = 0;
  middles.forEach((middle, index) => {
    if (index !== from && middle < center) target += 1;
  });
  return target;
}
