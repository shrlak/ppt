import { NavLink } from 'react-router-dom';

const NAV = [
  { to: '/', label: 'Dashboard', icon: '🏠', end: true },
  { to: '/songs', label: 'Song Library', icon: '🎵' },
  { to: '/setlists', label: 'Setlist Builder', icon: '📋' },
  { to: '/themes', label: 'Slide Themes', icon: '🎨' },
  { to: '/export', label: 'Export Preview', icon: '📤' },
  { to: '/settings', label: 'Settings', icon: '⚙️' },
];

export default function Sidebar() {
  return (
    <aside className="flex w-60 flex-none flex-col border-r border-slate-200 bg-white">
      <div className="px-5 py-6">
        <h1 className="text-sm font-bold leading-tight text-slate-900">
          Worship Setlist
          <span className="block font-normal text-slate-500">+ Lyrics Slide Generator</span>
        </h1>
      </div>
      <nav className="flex-1 space-y-1 px-3">
        {NAV.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.end}
            className={({ isActive }) =>
              `flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
                isActive
                  ? 'bg-blue-50 text-blue-700'
                  : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'
              }`
            }
          >
            <span aria-hidden>{item.icon}</span>
            {item.label}
          </NavLink>
        ))}
      </nav>
      <div className="px-5 py-4 text-xs text-slate-400">Local-first · no cloud</div>
    </aside>
  );
}
