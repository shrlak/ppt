import { createHash } from 'node:crypto';

const serviceName = (s) => typeof s === 'string' && s.normalize('NFC').replace(/\s+/g, '') === '1025주일예배';
const essentialName = (s) => ['kccp흰색+로고', 'black', 'white', '별이있는밤하늘'].includes(String(s).normalize('NFC').replace(/\s+/g, '').toLowerCase());

/** Protect the whole service reference graph, not filenames of individual images. */
export function planCleanup(library, inventory) {
  const lib = library.data;
  if (!lib || !Array.isArray(lib.playlists) || !Array.isArray(lib.presentations) || !Array.isArray(lib.media) || !Array.isArray(inventory)) throw new Error('Invalid server inventory');
  const playlists = lib.playlists.filter((p) => serviceName(p.name));
  if (playlists.length !== 1) throw new Error('Expected exactly one 1025 주일예배 playlist; refusing deletion');
  const byId = new Map();
  for (const values of Object.values(lib)) if (Array.isArray(values)) for (const item of values) {
    if (item && typeof item.id === 'string') byId.set(item.id, item);
  }
  for (const item of playlists[0].items) if (item.kind !== 'header' && !lib.presentations.some((p) => p.id === item.presentationId)) throw new Error('Protected playlist has a missing presentation');
  const ids = new Set([...lib.media.map((m) => m.id), ...inventory.map((m) => m.id)]);
  if (inventory.some((m) => !/^[\w:-]{1,80}$/.test(m.id) || !Number.isSafeInteger(m.size) || m.size < 0)) throw new Error('Invalid media inventory');
  const keep = new Set();
  const visited = new Set();
  const protectedPresentationIds = new Set();
  function visit(value) {
    if (typeof value === 'string') {
      if (ids.has(value)) keep.add(value);
      if (!visited.has(value) && byId.has(value)) {
        visited.add(value);
        if (lib.presentations.some((p) => p.id === value)) protectedPresentationIds.add(value);
        visit(byId.get(value));
      }
    } else if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === 'object') Object.values(value).forEach(visit);
  }
  visit(playlists);
  visit(lib.presentations.filter((p) => serviceName(p.folder)));
  visit(lib.logoMediaId);
  for (const m of lib.media) if (essentialName(m.name)) visit(m.id);
  const remove = [...ids].filter((id) => !keep.has(id)).sort();
  const kept = [...keep].sort();
  const fingerprint = createHash('sha256').update(JSON.stringify({ library, inventory: [...inventory].sort((a, b) => a.id.localeCompare(b.id)), remove, kept })).digest('hex');
  return { fingerprint, remove, keep: kept, protectedPresentationIds: [...protectedPresentationIds], playlistId: playlists[0].id, bytesToDelete: inventory.filter((m) => remove.includes(m.id)).reduce((sum, m) => sum + m.size, 0) };
}

/** Strip deleted assets from older decks while retaining their text and slide order. */
export function withoutMedia(library, deletedIds) {
  const gone = new Set(deletedIds);
  function clean(value) {
    if (Array.isArray(value)) return value.map(clean).filter((x) => x !== undefined);
    if (!value || typeof value !== 'object') return value;
    if (gone.has(value.mediaId) && ['media', 'image', 'video'].includes(value.kind)) return undefined;
    const result = {};
    for (const [key, item] of Object.entries(value)) {
      if ((key === 'mediaId' || key === 'audioMediaId') && gone.has(item)) { result[key] = null; continue; }
      const next = clean(item);
      if (next !== undefined) result[key] = next;
      else if (key === 'background' && value.kind === 'background') result[key] = null;
    }
    return result;
  }
  return { ...clean(library), media: library.media.filter((m) => !gone.has(m.id)) };
}
