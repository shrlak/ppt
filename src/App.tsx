import { useCallback, useState } from 'react';
import LyricsGenerator from './components/LyricsGenerator';
import BibleSlideGenerator, { type BibleGeneratorState } from './components/BibleSlideGenerator';
import SermonUploadSection, { type SermonFile } from './components/SermonUploadSection';
import AnnouncementSection from './components/AnnouncementSection';
import type { Song } from './lib/types';
import { planAllSlides, unmatchedTokens } from './lib/slidePlanner';
import { buildPptx, suggestFileName } from './lib/pptxBuilder';
import { extractSlideSubset } from './lib/pptxSlices';
import { mergePptxDecks } from './lib/pptxMerge';
import { parseAnnouncements, buildAnnouncementDeck } from './lib/announcementBuilder';
import { loadTranslation } from './bible/bibleData';
import { parseVerseInput } from './bible/refParser';
import { buildVerseSlidePlan } from './bible/versePlanner';
import { buildBiblePptx } from './bible/pptxBuilder';

const BASE: string = import.meta.env.BASE_URL || '/';

// Fixed positions (1-based, presentation order) of the reusable slides
// pulled from public/service-template.pptx. See tests/pptxSlices.test.ts
// for how these were identified.
const SERVICE_SLIDES = {
  intro: [1, 2, 3, 4],
  prayer1: [17],
  prayer2: [31],
  announcementTitle: [32],
  announcementItemTemplate: 33,
};

export default function App() {
  const [songs, setSongs] = useState<Song[]>([]);
  const [contiDate, setContiDate] = useState<string | undefined>();
  const [bibleState, setBibleState] = useState<BibleGeneratorState>({
    verseInput: '',
    sermonTitle: '',
    translations: ['nkrv', 'esv'],
    versesPerSlide: 1,
    customTemplate: null,
  });
  const [sermonFile, setSermonFile] = useState<SermonFile | null>(null);
  const [announcementText, setAnnouncementText] = useState('');
  const [fileName, setFileName] = useState(suggestFileName());
  const [fileNameEdited, setFileNameEdited] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSongsChange = useCallback((next: Song[]) => setSongs(next), []);
  const handleDateDetected = useCallback(
    (date: string | undefined) => {
      setContiDate(date);
      if (!fileNameEdited) setFileName(suggestFileName(date));
    },
    [fileNameEdited],
  );
  const handleBibleStateChange = useCallback((state: BibleGeneratorState) => setBibleState(state), []);

  const bibleRefs = bibleState.verseInput.trim() ? parseVerseInput(bibleState.verseInput).refs : [];
  const announcementItems = announcementText.trim() ? parseAnnouncements(announcementText) : [];

  const lyricsSlideCount = planAllSlides(songs).length;
  const hasAnyContent = songs.length > 0 || bibleRefs.length > 0 || sermonFile !== null || announcementItems.length > 0;

  async function generate() {
    if (!hasAnyContent) {
      setError('찬양, 성경 말씀, 설교, 광고 중 최소 하나 이상 입력해 주세요.');
      return;
    }
    setGenerating(true);
    setError(null);
    try {
      const serviceTemplate = await fetch(`${BASE}service-template.pptx`).then((r) => {
        if (!r.ok) throw new Error('서비스 템플릿 파일을 불러오지 못했습니다.');
        return r.arrayBuffer();
      });

      let merged: Uint8Array = await extractSlideSubset(serviceTemplate, SERVICE_SLIDES.intro);

      if (songs.length > 0) {
        const lyricsTemplate = await fetch(`${BASE}template.pptx`).then((r) => {
          if (!r.ok) throw new Error('찬양 템플릿 파일을 불러오지 못했습니다.');
          return r.arrayBuffer();
        });
        merged = await mergePptxDecks(merged, await buildPptx(lyricsTemplate, songs));
      }

      merged = await mergePptxDecks(merged, await extractSlideSubset(serviceTemplate, SERVICE_SLIDES.prayer1));

      if (bibleRefs.length > 0) {
        const bibles = new Map();
        for (const id of bibleState.translations) {
          bibles.set(id, await loadTranslation(BASE, id));
        }
        const plan = buildVerseSlidePlan(bibleRefs, bibleState.translations, bibles, bibleState.sermonTitle, bibleState.versesPerSlide);
        const bibleTemplate = bibleState.customTemplate
          ? bibleState.customTemplate.data
          : await fetch(`${BASE}bible-template.pptx`).then((r) => {
              if (!r.ok) throw new Error('성경 템플릿 파일을 불러오지 못했습니다.');
              return r.arrayBuffer();
            });
        merged = await mergePptxDecks(merged, await buildBiblePptx(bibleTemplate, plan));
      }

      if (sermonFile) {
        merged = await mergePptxDecks(merged, sermonFile.data);
      }

      merged = await mergePptxDecks(merged, await extractSlideSubset(serviceTemplate, SERVICE_SLIDES.prayer2));

      if (announcementItems.length > 0) {
        merged = await mergePptxDecks(merged, await extractSlideSubset(serviceTemplate, SERVICE_SLIDES.announcementTitle));
        merged = await mergePptxDecks(
          merged,
          await buildAnnouncementDeck(serviceTemplate, SERVICE_SLIDES.announcementItemTemplate, announcementItems),
        );
      }

      const blob = new Blob([merged.buffer as ArrayBuffer], {
        type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName.endsWith('.pptx') ? fileName : `${fileName}.pptx`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setGenerating(false);
    }
  }

  const allWarnings = songs
    .map((s) => ({ title: s.title, tokens: unmatchedTokens(s) }))
    .filter((w) => w.tokens.length > 0);

  // Fixed slides (intro + 2 prayer slides) always count; 말씀/설교/광고 title
  // only appear when there's matching content.
  const fixedSlideCount =
    SERVICE_SLIDES.intro.length +
    SERVICE_SLIDES.prayer1.length +
    SERVICE_SLIDES.prayer2.length +
    (announcementItems.length > 0 ? SERVICE_SLIDES.announcementTitle.length : 0);
  // Bible slide count isn't known until generation (it depends on how many
  // verses each reference expands to, which needs the full translation
  // data loaded) — shown as a "+" lower bound instead of a false-precise number.
  const totalSlideCount = fixedSlideCount + lyricsSlideCount + announcementItems.length;

  return (
    <div className="app">
      <header className="header">
        <h1>KCCP PPT Generator</h1>
        <p>찬양·말씀·설교·광고를 한 번에 정리해 예배 슬라이드 한 개로 만들어 드립니다.</p>
      </header>

      {error && (
        <div className="banner banner-error" data-testid="error-banner">
          <span>{error}</span>
          <button onClick={() => setError(null)}>✕</button>
        </div>
      )}

      <h2 className="section-title">🎵 찬양</h2>
      <LyricsGenerator onSongsChange={handleSongsChange} onDateDetected={handleDateDetected} />

      <h2 className="section-title">📖 성경 말씀</h2>
      <BibleSlideGenerator onStateChange={handleBibleStateChange} />

      <h2 className="section-title">🎤 설교</h2>
      <SermonUploadSection value={sermonFile} onChange={setSermonFile} />

      <h2 className="section-title">📢 광고</h2>
      <AnnouncementSection value={announcementText} onChange={setAnnouncementText} />

      <h2 className="section-title">⬇ PPT 생성</h2>
      <section className="card">
        {allWarnings.length > 0 && (
          <div className="banner banner-warn">
            일부 순서 토큰에 해당하는 가사가 없어 건너뜁니다:{' '}
            {allWarnings.map((w) => `${w.title || '(제목 없음)'}: ${w.tokens.join(', ')}`).join(' · ')}
          </div>
        )}
        <p className="input-hint" style={{ marginBottom: 14 }}>
          순서: 표지·신앙고백 → 찬양 → 기도 → 말씀 → 설교 → 기도 → 광고
        </p>
        <div className="generate-row">
          <label>
            파일명
            <input
              data-testid="filename-input"
              value={fileName}
              onChange={(e) => {
                setFileName(e.target.value);
                setFileNameEdited(true);
              }}
            />
          </label>
          <div className="slide-count" data-testid="slide-count">
            총 {totalSlideCount}장{bibleRefs.length > 0 ? ' 이상' : ''}의 슬라이드 (찬양 {songs.length}곡 · 말씀{' '}
            {bibleRefs.length}구절
            {sermonFile ? ' · 설교 첨부' : ''}
            {announcementItems.length > 0 ? ` · 광고 ${announcementItems.length}건` : ''})
          </div>
          <button
            className="btn btn-primary"
            data-testid="generate-pptx"
            disabled={generating}
            onClick={() => void generate()}
          >
            {generating ? '생성 중…' : '⬇ PPTX 생성 및 다운로드'}
          </button>
        </div>
      </section>

      <p className="brand-footer">KCCP PPT Generator · {contiDate ?? ''}</p>
    </div>
  );
}
