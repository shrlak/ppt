function strings(value, out = new Set()) {
  if (typeof value === 'string') out.add(value);
  else if (Array.isArray(value)) value.forEach((v) => strings(v, out));
  else if (value && typeof value === 'object') Object.values(value).forEach((v) => strings(v, out));
  return out;
}

/** Cascade deck deletion only for assets not used anywhere in the new library. */
export function reconcileDeletedMedia(previous, next) {
  if (!Array.isArray(previous?.presentations) || !Array.isArray(previous?.media) || !Array.isArray(next?.presentations) || !Array.isArray(next?.media)) return { data: next, deletedIds: [] };
  const keptDecks = new Set(next.presentations.map((p) => p.id));
  const candidates = strings(previous.presentations.filter((p) => !keptDecks.has(p.id)));
  const used = strings({ ...next, media: [] });
  const deletedIds = previous.media.filter((m) => candidates.has(m.id) && !used.has(m.id)).map((m) => m.id);
  const gone = new Set(deletedIds);
  const media = next.media.filter((m) => !gone.has(m.id));
  const present = new Set(media.map((m) => m.id));
  // Another device may have attached an asset while its original deck was being removed.
  for (const m of previous.media) if (used.has(m.id) && !present.has(m.id)) { media.push(m); present.add(m.id); }
  return { data: { ...next, media }, deletedIds };
}
