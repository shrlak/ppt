import { useParams } from 'react-router-dom';
import PageHeader from '../components/PageHeader';
import { demoSongs } from '../lib/demoData';
import { KEYS, SECTION_TYPES, SONG_TAGS } from '../types';

/**
 * Add/Edit Song form. Phase 1 renders the full form layout with demo values;
 * saving is wired to SQLite in Phase 2.
 */
export default function SongEditor() {
  const { id } = useParams();
  const song = demoSongs.find((s) => s.id === id);

  return (
    <>
      <PageHeader
        title={song ? `Edit: ${song.title}` : 'Add Song'}
        description="Sections hold lyrics with optional inline [G]bracket chords."
        actions={
          <button
            className="cursor-not-allowed rounded-lg bg-slate-200 px-4 py-2 text-sm font-semibold text-slate-500"
            title="Saving arrives with the SQLite store in Phase 2"
            disabled
          >
            Save (Phase 2)
          </button>
        }
      />
      <div className="space-y-6">
        <div className="grid grid-cols-2 gap-4 rounded-xl border border-slate-200 bg-white p-6">
          <label className="block text-sm">
            <span className="font-medium">Title</span>
            <input
              className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2"
              defaultValue={song?.title ?? ''}
              placeholder="Song title"
            />
          </label>
          <label className="block text-sm">
            <span className="font-medium">Artist / Source</span>
            <input
              className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2"
              defaultValue={song?.artist ?? ''}
              placeholder="Artist, album, or hymnal"
            />
          </label>
          <label className="block text-sm">
            <span className="font-medium">Original Key</span>
            <select
              className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2"
              defaultValue={song?.originalKey ?? 'C'}
            >
              {KEYS.map((k) => (
                <option key={k}>{k}</option>
              ))}
            </select>
          </label>
          <label className="block text-sm">
            <span className="font-medium">BPM</span>
            <input
              type="number"
              className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2"
              defaultValue={song?.bpm ?? ''}
              placeholder="e.g. 72"
            />
          </label>
          <label className="block text-sm">
            <span className="font-medium">CCLI # (optional)</span>
            <input
              className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2"
              defaultValue={song?.ccli ?? ''}
            />
          </label>
          <div className="text-sm">
            <span className="font-medium">Tags</span>
            <div className="mt-2 flex flex-wrap gap-2">
              {SONG_TAGS.map((t) => (
                <label
                  key={t}
                  className="flex items-center gap-1.5 rounded-full border border-slate-300 px-3 py-1 text-xs"
                >
                  <input type="checkbox" defaultChecked={song?.tags.includes(t)} /> {t}
                </label>
              ))}
            </div>
          </div>
          <label className="col-span-2 block text-sm">
            <span className="font-medium">Notes for worship leader</span>
            <textarea
              className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2"
              rows={2}
              defaultValue={song?.notes ?? ''}
            />
          </label>
        </div>

        <div className="rounded-xl border border-slate-200 bg-white p-6">
          <div className="flex items-center justify-between">
            <h3 className="font-semibold">Lyrics by section</h3>
            <div className="flex flex-wrap gap-1">
              {SECTION_TYPES.map((t) => (
                <button
                  key={t}
                  className="rounded-full border border-slate-300 px-3 py-1 text-xs hover:bg-slate-50"
                >
                  + {t}
                </button>
              ))}
            </div>
          </div>
          <div className="mt-4 space-y-4">
            {(song?.sections ?? []).map((sec) => (
              <div key={sec.id} className="rounded-lg border border-slate-200 p-4">
                <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
                  {sec.type}
                </div>
                <textarea
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-sm"
                  rows={Math.max(2, sec.content.split('\n').length)}
                  defaultValue={sec.content}
                  placeholder="Lyrics… chords inline like [G]Amazing grace"
                />
              </div>
            ))}
            {(song?.sections ?? []).length === 0 && (
              <p className="text-sm text-slate-500">No sections yet — add one above.</p>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
