import { Link } from 'react-router-dom';
import PageHeader from '../components/PageHeader';
import { demoSetlists, demoSongs, demoThemes } from '../lib/demoData';

const CARDS = [
  { to: '/songs', label: 'Songs', icon: '🎵', count: () => demoSongs.length },
  { to: '/setlists', label: 'Setlists', icon: '📋', count: () => demoSetlists.length },
  { to: '/themes', label: 'Slide Themes', icon: '🎨', count: () => demoThemes.length },
];

const PHASES = [
  { n: 1, label: 'Project + UI layout', done: true },
  { n: 2, label: 'SQLite database + song library CRUD', done: false },
  { n: 3, label: 'Setlist builder', done: false },
  { n: 4, label: 'Chord transposition', done: false },
  { n: 5, label: 'PowerPoint slide generation', done: false },
  { n: 6, label: 'Theme editor + export preview', done: false },
];

export default function Dashboard() {
  return (
    <>
      <PageHeader
        title="Dashboard"
        description="Plan worship setlists, manage songs, and generate lyric slides — all stored locally."
      />
      <div className="grid grid-cols-3 gap-4">
        {CARDS.map((c) => (
          <Link
            key={c.to}
            to={c.to}
            className="rounded-xl border border-slate-200 bg-white p-5 transition-shadow hover:shadow-md"
          >
            <div className="text-2xl">{c.icon}</div>
            <div className="mt-3 text-3xl font-bold">{c.count()}</div>
            <div className="text-sm text-slate-500">{c.label}</div>
          </Link>
        ))}
      </div>
      <div className="mt-8 rounded-xl border border-slate-200 bg-white p-6">
        <h3 className="font-semibold">Build progress</h3>
        <ul className="mt-4 space-y-2">
          {PHASES.map((p) => (
            <li key={p.n} className="flex items-center gap-3 text-sm">
              <span
                className={`flex h-5 w-5 flex-none items-center justify-center rounded-full text-[10px] font-bold ${
                  p.done ? 'bg-green-100 text-green-700' : 'bg-slate-100 text-slate-400'
                }`}
              >
                {p.done ? '✓' : p.n}
              </span>
              <span className={p.done ? '' : 'text-slate-500'}>
                Phase {p.n}: {p.label}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </>
  );
}
