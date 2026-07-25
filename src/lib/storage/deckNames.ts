// Name matching for the PPT 라이브러리, kept apart from pptLibrary.ts so it
// stays free of browser storage APIs and can be unit tested directly.

/** Two names collide when they differ only in case, spacing or a .pptx suffix. */
export function deckNameKey(name: string): string {
  return name.trim().replace(/\.pptx$/i, '').trim().toLowerCase();
}

/** Entries a save under `name` should overwrite, most recently saved first. */
export function decksWithSameName<T extends { id: string; name: string; savedAt: string }>(
  decks: T[],
  name: string,
  exceptId?: string,
): T[] {
  const key = deckNameKey(name);
  if (!key) return [];
  return decks
    .filter((deck) => deck.id !== exceptId && deckNameKey(deck.name) === key)
    .sort((a, b) => b.savedAt.localeCompare(a.savedAt));
}
