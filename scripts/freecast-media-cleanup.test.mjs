import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planCleanup, withoutMedia } from './freecast-media-cleanup.mjs';

function fixture() {
  const data = {
    playlists: [{ id: 'pl', name: '1025 주일예배', items: [{ presentationId: 'front' }] }],
    presentations: [{ id: 'front', title: 'Front', slides: [{ elements: [{ kind: 'image', mediaId: 'keep' }], actions: [{ macroId: 'macro' }] }] }, { id: 'extra', folder: '1025 주일예배', timeline: { audioMediaId: 'audio' } }, { id: 'old', slides: [{ background: { kind: 'media', mediaId: 'delete' }, text: 'Keep lyrics', elements: [{ kind: 'image', mediaId: 'delete' }] }] }],
    macros: [{ id: 'macro', steps: [{ kind: 'audio', mediaId: 'macro-audio' }] }],
    media: ['keep', 'audio', 'macro-audio', 'delete', 'logo'].map((id) => ({ id, name: id })), logoMediaId: 'logo',
  };
  return { library: { version: 1, data }, inventory: data.media.map(({ id }) => ({ id, size: 20 })) };
}
test('protect complete service, folder, macros and logo; delete all others including orphans', () => {
  const { library, inventory } = fixture(); inventory.push({ id: 'orphan', size: 500 });
  const plan = planCleanup(library, inventory);
  assert.deepEqual(plan.keep, ['audio', 'keep', 'logo', 'macro-audio']);
  assert.deepEqual(plan.remove, ['delete', 'orphan']);
  assert.equal(plan.bytesToDelete, 520);
  const cleaned = withoutMedia(library.data, plan.remove);
  assert.deepEqual(cleaned.presentations.slice(0, 2), library.data.presentations.slice(0, 2));
  assert.deepEqual(cleaned.presentations[2].slides, [{ text: 'Keep lyrics', elements: [] }]);
  assert.equal(cleaned.media.length, 4);
  assert.equal(library.data.media.length, 5);
});
test('refuse missing/ambiguous service, incomplete playlist and corrupt sizes', () => {
  const { library, inventory } = fixture();
  assert.throws(() => planCleanup({ data: { ...library.data, playlists: [] } }, inventory));
  assert.throws(() => planCleanup({ data: { ...library.data, playlists: [...library.data.playlists, ...library.data.playlists] } }, inventory));
  assert.throws(() => planCleanup({ data: { ...library.data, presentations: [] } }, inventory));
  assert.throws(() => planCleanup(library, [{ id: 'keep', size: -1 }]));
});
test('fingerprint changes for edits and protects exact preset names', () => {
  const { library, inventory } = fixture();
  const before = planCleanup(library, inventory);
  library.data.media.push({ id: 'sky', name: '별이 있는 밤하늘' });
  const after = planCleanup(library, inventory);
  assert(after.keep.includes('sky'));
  assert.notEqual(before.fingerprint, after.fingerprint);
});
