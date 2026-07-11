import { useState } from 'react';
import LyricsGenerator from './components/LyricsGenerator';
import BibleSlideGenerator from './components/BibleSlideGenerator';

type Tab = 'lyrics' | 'bible';

const TABS: { id: Tab; label: string; icon: string }[] = [
  { id: 'lyrics', label: '찬양 가사', icon: '🎵' },
  { id: 'bible', label: '성경 말씀', icon: '📖' },
];

export default function App() {
  const [tab, setTab] = useState<Tab>('lyrics');

  return (
    <div className="app">
      <header className="header">
        <h1>KCCP PPT Generator</h1>
        <p>찬양 가사와 성경 말씀 슬라이드를 자동으로 만들어 드립니다.</p>
      </header>

      <nav className="tabbar" role="tablist" aria-label="생성기 선택">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            data-testid={`tab-${t.id}`}
            className={`tab${tab === t.id ? ' active' : ''}`}
            onClick={() => setTab(t.id)}
          >
            <span aria-hidden>{t.icon}</span> {t.label}
          </button>
        ))}
      </nav>

      {tab === 'lyrics' ? <LyricsGenerator /> : <BibleSlideGenerator />}

      <p className="brand-footer">KCCP PPT Generator</p>
    </div>
  );
}
