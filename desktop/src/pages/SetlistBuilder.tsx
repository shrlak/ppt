import PageHeader from '../components/PageHeader';
import EmptyState from '../components/EmptyState';
import { demoSetlists, demoSongs } from '../lib/demoData';

export default function SetlistBuilder() {
  const setlist = demoSetlists[0];
  return (
    <>
      <PageHeader
        title="Setlist Builder"
        description="Layout preview with demo data — drag & drop reordering, keys, and transitions land in Phase 3."
        actions={
          <button
            className="cursor-not-allowed rounded-lg bg-slate-200 px-4 py-2 text-sm font-semibold text-slate-500"
            disabled
          >
            + New Setlist (Phase 3)
          </button>
        }
      />
      <div className="rounded-xl border border-slate-200 bg-white p-6">
        <div className="flex items-baseline justify-between">
          <h3 className="font-semibold">
            {setlist.title} <span className="ml-2 text-sm font-normal text-slate-500">{setlist.date}</span>
          </h3>
        </div>
        <ol className="mt-4 space-y-2">
          {setlist.items.map((item) => {
            const song = item.songId ? demoSongs.find((s) => s.id === item.songId) : undefined;
            return (
              <li
                key={item.id}
                className="flex items-center gap-3 rounded-lg border border-slate-200 px-4 py-3 text-sm"
              >
                <span className="cursor-grab text-slate-300" title="Drag to reorder (Phase 3)">
                  ⠿
                </span>
                {item.kind === 'service' ? (
                  <span className="rounded-full bg-amber-50 px-3 py-0.5 text-xs font-medium text-amber-700">
                    {item.serviceSection}
                  </span>
                ) : (
                  <>
                    <span className="font-medium">{song?.title ?? '(missing song)'}</span>
                    <span className="rounded bg-slate-100 px-2 py-0.5 text-xs">
                      Key: {item.performanceKey}
                    </span>
                  </>
                )}
                {item.transitionNote && (
                  <span className="ml-auto text-xs text-slate-400">→ {item.transitionNote}</span>
                )}
              </li>
            );
          })}
        </ol>
      </div>
      <div className="mt-6">
        <EmptyState
          icon="🔀"
          title="Drag & drop, per-song keys, transitions"
          message="Create dated setlists, mix songs with service sections (Opening Prayer, Offering, Sermon…), reorder by dragging, and set each song's performance key."
          phase={3}
        />
      </div>
    </>
  );
}
