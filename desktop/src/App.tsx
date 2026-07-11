import { Route, Routes } from 'react-router-dom';
import Layout from './components/Layout';
import Dashboard from './pages/Dashboard';
import SongLibrary from './pages/SongLibrary';
import SongEditor from './pages/SongEditor';
import SetlistBuilder from './pages/SetlistBuilder';
import ThemeEditor from './pages/ThemeEditor';
import ExportPreview from './pages/ExportPreview';
import Settings from './pages/Settings';

export default function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<Dashboard />} />
        <Route path="songs" element={<SongLibrary />} />
        <Route path="songs/new" element={<SongEditor />} />
        <Route path="songs/:id/edit" element={<SongEditor />} />
        <Route path="setlists" element={<SetlistBuilder />} />
        <Route path="themes" element={<ThemeEditor />} />
        <Route path="export" element={<ExportPreview />} />
        <Route path="settings" element={<Settings />} />
      </Route>
    </Routes>
  );
}
