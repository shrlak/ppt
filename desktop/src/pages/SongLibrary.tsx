import { Link } from 'react-router-dom';
import PageHeader from '../components/PageHeader';
import { demoSongs } from '../lib/demoData';

export default function SongLibrary() {
  return (
    <>
      <PageHeader
        title="Song Library"
        description="Placeholder data for now — CRUD backed by SQLite lands in Phase 2."
        actions={
          <Link
            to="/songs/new"
            className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700"
          >
            + Add Song
          </Link>
        }
      />
      <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-4 py-3">Title</th>
              <th className="px-4 py-3">Artist / Source</th>
              <th className="px-4 py-3">Key</th>
              <th className="px-4 py-3">BPM</th>
              <th className="px-4 py-3">Tags</th>
              <th className="px-4 py-3"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {demoSongs.map((song) => (
              <tr key={song.id} className="hover:bg-slate-50">
                <td className="px-4 py-3 font-medium">{song.title}</td>
                <td className="px-4 py-3 text-slate-500">{song.artist}</td>
                <td className="px-4 py-3">{song.originalKey}</td>
                <td className="px-4 py-3">{song.bpm ?? '–'}</td>
                <td className="px-4 py-3">
                  <div className="flex flex-wrap gap-1">
                    {song.tags.map((t) => (
                      <span
                        key={t}
                        className="rounded-full bg-indigo-50 px-2 py-0.5 text-xs text-indigo-700"
                      >
                        {t}
                      </span>
                    ))}
                  </div>
                </td>
                <td className="px-4 py-3 text-right">
                  <Link to={`/songs/${song.id}/edit`} className="text-blue-600 hover:underline">
                    Edit
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
