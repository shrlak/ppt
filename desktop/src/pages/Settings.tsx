import { useEffect, useState } from 'react';
import { getVersion } from '@tauri-apps/api/app';
import PageHeader from '../components/PageHeader';

export default function Settings() {
  const [version, setVersion] = useState<string | null>(null);

  useEffect(() => {
    // Confirms the Tauri IPC bridge works; shows "–" when running in a plain browser.
    getVersion()
      .then(setVersion)
      .catch(() => setVersion(null));
  }, []);

  return (
    <>
      <PageHeader title="Settings" description="App preferences and data management." />
      <div className="rounded-xl border border-slate-200 bg-white p-6 text-sm">
        <dl className="grid grid-cols-2 gap-4">
          <div>
            <dt className="text-slate-500">App version</dt>
            <dd className="mt-1 font-medium">{version ?? '– (browser mode)'}</dd>
          </div>
          <div>
            <dt className="text-slate-500">Database</dt>
            <dd className="mt-1 font-medium">SQLite (local) — connected in Phase 2</dd>
          </div>
          <div>
            <dt className="text-slate-500">Library import/export</dt>
            <dd className="mt-1 font-medium">JSON — Phase 5</dd>
          </div>
        </dl>
      </div>
    </>
  );
}
