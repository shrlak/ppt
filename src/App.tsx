import { useCallback, useEffect, useRef, useState } from 'react';
import LyricsGenerator from './components/LyricsGenerator';
import BibleSlideGenerator, { type BibleGeneratorState } from './components/BibleSlideGenerator';
import SermonUploadSection, { type SermonFile } from './components/SermonUploadSection';
import AnnouncementSection from './components/AnnouncementSection';
import SlideOverviewList from './components/SlideOverviewList';
import PptLibraryPanel from './components/PptLibraryPanel';
import type { ContiInfo, Song } from './lib/utils/types';
import { expandDeckSegment, songOverviewItems, type DeckOverviewItem } from './lib/utils/deckOverview';
import { planAllSlides, unmatchedTokens } from './lib/utils/slidePlanner';
import { buildPptx, suggestFileName } from './lib/pptx/pptxBuilder';
import { extractSlideSubset } from './lib/pptx/pptxSlices';
import { mergePptxDecks } from './lib/pptx/pptxMerge';
import { parseAnnouncements, buildAnnouncementDeck } from './lib/utils/announcementBuilder';
import { loadTranslation } from './bible/bibleData';
import { normalizeContiScripture, parseVerseInput } from './bible/refParser';
import { buildVerseSlidePlan } from './bible/versePlanner';
import { buildBiblePptx } from './bible/pptxBuilder';
import { assertPptxIntegrity } from './lib/pptx/pptxPackage';
import { renderPptxSlides, revokeRenderedSlides, type RenderedSlide } from './lib/pptx/pptxRenderer';
import ToastHost from './components/ToastHost';
import AdminPanel from './components/AdminPanel';
import UsagePanel from './components/UsagePanel';
import { getCustomDeck, type DeckSlot, type StoredDeck } from './lib/storage/deckStore';
import { inspectDeckBytes, saveDeckToLibrary } from './lib/storage/pptLibrary';
import { showToast } from './lib/utils/toast';

// Debounce before the 편집기 view regenerates the whole deck + re-renders
// thumbnails after an edit — regeneration re-zips several .pptx pieces, so
// this avoids redoing that work on every keystroke.
const EDITOR_REGEN_DEBOUNCE_MS = 800;

const BASE: string = import.meta.env.BASE_URL || '/';

// Fixed positions (1-based, presentation order) of reusable prayer and
// announcement slides pulled from public/service-template.pptx.
const SERVICE_SLIDES = {
  prayer1: [17],
  prayer2: [31],
  announcementTitle: [32],
  announcementItemTemplate: 33,
};

const FRONT_SLIDE_COUNT = 4;
const BACK_SLIDE_COUNT = 21;

const WIZARD_STEPS = [
  { id: 'lyrics', label: '찬양' },
  { id: 'bible', label: '성경 말씀' },
  { id: 'sermon', label: '설교' },
  { id: 'announcement', label: '광고' },
  { id: 'download', label: '다운로드' },
] as const;

interface WizardNavigationProps {
  step: number;
  onMove: (step: number) => void;
}

function WizardNavigation({ step, onMove }: WizardNavigationProps) {
  const currentId = WIZARD_STEPS[step].id;
  const nextStep = WIZARD_STEPS[step + 1];

  return (
    <nav className="wizard-nav" aria-label="단계 이동">
      {step > 0 ? (
        <button
          className="btn"
          data-testid={`wizard-back-${currentId}`}
          onClick={() => onMove(step - 1)}
        >
          이전
        </button>
      ) : (
        <span />
      )}
      {nextStep && (
        <button
          className="btn btn-primary"
          data-testid={`wizard-next-${currentId}`}
          onClick={() => onMove(step + 1)}
        >
          다음: {nextStep.label}
        </button>
      )}
    </nav>
  );
}

export default function App() {
  const [activeStep, setActiveStep] = useState(0);
  // Which way the active wizard step just moved, so the incoming panel can
  // sweep in from the matching side instead of a single fixed direction.
  const [direction, setDirection] = useState<'forward' | 'back'>('forward');
  const [viewMode, setViewMode] = useState<'wizard' | 'editor'>('wizard');
  const [scrolled, setScrolled] = useState(false);
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
  const [contiFile, setContiFile] = useState<{ name: string; data: ArrayBuffer } | null>(null);
  const [announcementText, setAnnouncementText] = useState('');
  const [generating, setGenerating] = useState(false);
  const [savingToLibrary, setSavingToLibrary] = useState(false);
  const [adminOpen, setAdminOpen] = useState(false);
  const [usageOpen, setUsageOpen] = useState(false);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [customDecks, setCustomDecks] = useState<Record<DeckSlot, StoredDeck | null>>({
    front: null,
    back: null,
  });
  const [contiBibleAutoFill, setContiBibleAutoFill] = useState({
    version: 0,
    verseInput: '',
    sermonTitle: '',
  });
  const [editorDeck, setEditorDeck] = useState<{ overview: DeckOverviewItem[]; slides: RenderedSlide[] } | null>(null);
  const [editorLoading, setEditorLoading] = useState(false);
  const [editorError, setEditorError] = useState<string | null>(null);
  const editorSlidesRef = useRef<RenderedSlide[]>([]);

  const handleSongsChange = useCallback((next: Song[]) => setSongs(next), []);
  const handleDateDetected = useCallback((date: string | undefined) => setContiDate(date), []);
  const handleBibleStateChange = useCallback((state: BibleGeneratorState) => setBibleState(state), []);
  const handleContiInfoDetected = useCallback((info: ContiInfo) => {
    setContiBibleAutoFill((previous) => ({
      version: previous.version + 1,
      verseInput: normalizeContiScripture(info.scripture ?? ''),
      sermonTitle: info.sermonTitle ?? '',
    }));
  }, []);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([getCustomDeck('front'), getCustomDeck('back')]).then(([front, back]) => {
      if (!cancelled) setCustomDecks({ front, back });
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleDeckChange = useCallback((slot: DeckSlot, deck: StoredDeck | null) => {
    setCustomDecks((previous) => ({ ...previous, [slot]: deck }));
  }, []);

  const bibleRefs = bibleState.verseInput.trim() ? parseVerseInput(bibleState.verseInput).refs : [];
  const announcementItems = announcementText.trim() ? parseAnnouncements(announcementText) : [];
  const fileName = suggestFileName(contiDate);

  // 편집기 view: 찬양 가사, 성경 말씀(설교 제목·본문), 설교 PPT 업로드, and 광고 all stay
  // the SAME mounted LyricsGenerator/BibleSlideGenerator/SermonUploadSection/
  // AnnouncementSection instances used by the wizard steps (just made
  // simultaneously visible instead of one-at-a-time) — never a second copy,
  // so there is nothing to keep in sync.
  const isPanelActive = useCallback(
    (stepId: (typeof WIZARD_STEPS)[number]['id']) =>
      viewMode === 'editor'
        ? stepId === 'lyrics' || stepId === 'bible' || stepId === 'sermon' || stepId === 'announcement'
        : WIZARD_STEPS[activeStep].id === stepId,
    [viewMode, activeStep],
  );
  function scrollToSong(songId: string) {
    document.getElementById(`song-editor-${songId}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  function scrollToBible() {
    const el = document.querySelector<HTMLInputElement>('[data-testid="bible-verse-input"]');
    el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el?.focus();
  }
  function scrollToAnnouncement() {
    const el = document.querySelector<HTMLTextAreaElement>('[data-testid="announcement-input"]');
    el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el?.focus();
  }
  function scrollToSermon() {
    document.querySelector('[data-testid="sermon-upload-section"]')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  const lyricsSlideCount = planAllSlides(songs).length;
  const hasAnyContent = songs.length > 0 || bibleRefs.length > 0 || sermonFile !== null || announcementItems.length > 0;

  /**
   * Build the complete merged deck, plus its real per-slide overview (in the
   * exact same order the pieces are merged, using the real slide count of
   * each piece via inspectDeckBytes — never an estimate) so the 편집기 view's
   * left panel stays aligned 1:1 with what renderPptxSlides() will show.
   * Shared by the download button, the 라이브러리 save action, and 편집기 view.
   */
  async function buildMergedDeck(): Promise<{ merged: Uint8Array; overview: DeckOverviewItem[] }> {
    const [serviceTemplate, frontSlides, backSlides] = await Promise.all([
      fetch(`${BASE}service-template.pptx`).then((r) => {
        if (!r.ok) throw new Error('서비스 템플릿 파일을 불러오지 못했습니다.');
        return r.arrayBuffer();
      }),
      // Administrator-replaced decks (관리자 설정) take precedence over the bundled files.
      customDecks.front
        ? Promise.resolve(customDecks.front.data)
        : fetch(`${BASE}front-slides.pptx`).then((r) => {
            if (!r.ok) throw new Error('Front slides 파일을 불러오지 못했습니다.');
            return r.arrayBuffer();
          }),
      customDecks.back
        ? Promise.resolve(customDecks.back.data)
        : fetch(`${BASE}back-slides.pptx`).then((r) => {
            if (!r.ok) throw new Error('Back slides 파일을 불러오지 못했습니다.');
            return r.arrayBuffer();
          }),
    ]);

    const overview: DeckOverviewItem[] = [];
    let merged: Uint8Array = new Uint8Array(frontSlides);
    const frontCount = (await inspectDeckBytes(frontSlides)).slideCount;
    overview.push(
      ...expandDeckSegment({ kind: 'front', count: frontCount, labelAt: (i, count) => `Front ${i + 1}/${count}` }),
    );

    if (songs.length > 0) {
      const lyricsTemplate = await fetch(`${BASE}template.pptx`).then((r) => {
        if (!r.ok) throw new Error('찬양 템플릿 파일을 불러오지 못했습니다.');
        return r.arrayBuffer();
      });
      merged = await mergePptxDecks(merged, await buildPptx(lyricsTemplate, songs), 'STORE');
      overview.push(...songs.flatMap((s) => songOverviewItems(s)));
    }

    merged = await mergePptxDecks(merged, await extractSlideSubset(serviceTemplate, SERVICE_SLIDES.prayer1), 'STORE');
    overview.push(...expandDeckSegment({ kind: 'prayer', count: SERVICE_SLIDES.prayer1.length, labelAt: () => '기도' }));

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
      const bibleDeck = await buildBiblePptx(bibleTemplate, plan);
      merged = await mergePptxDecks(merged, bibleDeck, 'STORE');
      const bibleCount = (await inspectDeckBytes(bibleDeck.buffer as ArrayBuffer)).slideCount;
      overview.push(
        ...expandDeckSegment({ kind: 'bible', count: bibleCount, labelAt: (i, count) => `말씀 ${i + 1}/${count}` }),
      );
    }

    if (sermonFile) {
      merged = await mergePptxDecks(merged, sermonFile.data, 'STORE');
      const sermonCount = (await inspectDeckBytes(sermonFile.data)).slideCount;
      overview.push(
        ...expandDeckSegment({
          kind: 'sermon',
          count: sermonCount,
          labelAt: (i, count) => `설교 ${i + 1}/${count}`,
          subtitleAt: () => sermonFile.name,
        }),
      );
    }

    merged = await mergePptxDecks(merged, await extractSlideSubset(serviceTemplate, SERVICE_SLIDES.prayer2), 'STORE');
    overview.push(...expandDeckSegment({ kind: 'prayer', count: SERVICE_SLIDES.prayer2.length, labelAt: () => '기도' }));

    if (announcementItems.length > 0) {
      merged = await mergePptxDecks(merged, await extractSlideSubset(serviceTemplate, SERVICE_SLIDES.announcementTitle), 'STORE');
      overview.push(
        ...expandDeckSegment({ kind: 'divider', count: SERVICE_SLIDES.announcementTitle.length, labelAt: () => '광고' }),
      );
      merged = await mergePptxDecks(
        merged,
        await buildAnnouncementDeck(serviceTemplate, SERVICE_SLIDES.announcementItemTemplate, announcementItems),
        'STORE',
      );
      overview.push(
        ...announcementItems.map((item, i) => ({
          id: `announcement-${i}`,
          kind: 'announcement' as const,
          label: item.title.trim() || `광고 ${i + 1}`,
          subtitle: item.bodyLines[0],
        })),
      );
    }

    // The full closing deck is mandatory and always follows announcements.
    merged = await mergePptxDecks(merged, backSlides);
    const backCount = (await inspectDeckBytes(backSlides)).slideCount;
    overview.push(...expandDeckSegment({ kind: 'back', count: backCount, labelAt: (i, count) => `Back ${i + 1}/${count}` }));

    await assertPptxIntegrity(merged);
    return { merged, overview };
  }

  function downloadDeck(merged: Uint8Array) {
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
  }

  async function generate() {
    if (!hasAnyContent) {
      showToast('찬양, 성경 말씀, 설교, 광고 중 최소 하나 이상 입력해 주세요.', 'error');
      return;
    }
    setGenerating(true);
    try {
      const { merged } = await buildMergedDeck();
      downloadDeck(merged);
    } catch (e) {
      showToast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setGenerating(false);
    }
  }

  async function saveCurrentToLibrary() {
    if (!hasAnyContent) {
      showToast('찬양, 성경 말씀, 설교, 광고 중 최소 하나 이상 입력해 주세요.', 'error');
      return;
    }
    setSavingToLibrary(true);
    try {
      const { merged } = await buildMergedDeck();
      const { slideCount } = await inspectDeckBytes(merged.buffer as ArrayBuffer);
      const savedName = fileName.endsWith('.pptx') ? fileName : `${fileName}.pptx`;
      await saveDeckToLibrary({
        name: savedName,
        pptx: { name: savedName, data: merged.buffer as ArrayBuffer },
        contiPdf: contiFile,
        sermonPptx: sermonFile ? { name: sermonFile.name, data: sermonFile.data } : null,
        slideCount,
        songTitles: songs.map((s) => s.title.trim()).filter(Boolean),
      });
      showToast(`'${savedName}'을(를) 라이브러리에 저장했습니다.`);
    } catch (e) {
      showToast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setSavingToLibrary(false);
    }
  }

  // 편집기 view: regenerate the full deck and re-render real slide thumbnails
  // after edits settle, so the left panel always shows exactly what the
  // download will contain (never a text approximation of it).
  useEffect(() => {
    if (viewMode !== 'editor') return;
    if (!hasAnyContent) {
      setEditorDeck((previous) => {
        if (previous) revokeRenderedSlides(previous.slides);
        return null;
      });
      editorSlidesRef.current = [];
      setEditorError(null);
      setEditorLoading(false);
      return;
    }
    let cancelled = false;
    setEditorLoading(true);
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const { merged, overview } = await buildMergedDeck();
          const slides = await renderPptxSlides(merged);
          if (cancelled) {
            revokeRenderedSlides(slides);
            return;
          }
          setEditorDeck((previous) => {
            if (previous) revokeRenderedSlides(previous.slides);
            return { overview, slides };
          });
          editorSlidesRef.current = slides;
          setEditorError(null);
        } catch (e) {
          if (!cancelled) setEditorError(e instanceof Error ? e.message : String(e));
        } finally {
          if (!cancelled) setEditorLoading(false);
        }
      })();
    }, EDITOR_REGEN_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewMode, songs, bibleState, sermonFile, announcementText, customDecks, hasAnyContent]);

  // Release any still-live thumbnail object URLs when the app itself unmounts.
  useEffect(() => () => revokeRenderedSlides(editorSlidesRef.current), []);

  const allWarnings = songs
    .map((s) => ({ title: s.title, tokens: unmatchedTokens(s) }))
    .filter((w) => w.tokens.length > 0);

  // Front/back + 2 prayer slides always count; the announcement title only
  // appears when there is matching content.
  const fixedSlideCount =
    (customDecks.front?.slideCount ?? FRONT_SLIDE_COUNT) +
    (customDecks.back?.slideCount ?? BACK_SLIDE_COUNT) +
    SERVICE_SLIDES.prayer1.length +
    SERVICE_SLIDES.prayer2.length +
    (announcementItems.length > 0 ? SERVICE_SLIDES.announcementTitle.length : 0);
  // Bible slide count isn't known until generation (it depends on how many
  // verses each reference expands to, which needs the full translation
  // data loaded) — shown as a "+" lower bound instead of a false-precise number.
  const totalSlideCount = fixedSlideCount + lyricsSlideCount + announcementItems.length;

  function moveToStep(step: number) {
    setDirection(step >= activeStep ? 'forward' : 'back');
    setActiveStep(step);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  return (
    <>
      <header className={`header${scrolled ? ' header-scrolled' : ''}`}>
        <div className="header-inner">
          <div className="header-brand">
            <img
              className="header-logo"
              src={`${BASE}favicon.svg`}
              alt="Korean Central Church of Pittsburgh 대학·청년부 로고"
            />
            <div className="header-text">
              <h1>KCCP PPT Generator</h1>
              <p>필요한 내용을 단계별로 입력하고, 하나의 예배 PPT로 다운로드하세요.</p>
            </div>
          </div>
          <div className="header-actions">
            <button
              type="button"
              className="btn"
              data-testid="view-mode-toggle"
              title={viewMode === 'wizard' ? '편집기 보기' : '단계별 보기'}
              onClick={() => setViewMode((mode) => (mode === 'wizard' ? 'editor' : 'wizard'))}
            >
              {viewMode === 'wizard' ? '🖥 편집기 보기' : '📝 단계별 보기'}
            </button>
            <button
              type="button"
              className="btn library-open"
              data-testid="library-open"
              title="PPT 라이브러리"
              onClick={() => setLibraryOpen(true)}
            >
              📚 라이브러리
            </button>
            <button
              type="button"
              className="btn usage-open"
              data-testid="usage-open"
              title="AI 사용량"
              onClick={() => setUsageOpen(true)}
            >
              📊 사용량
            </button>
            <button
              type="button"
              className="btn admin-open"
              data-testid="admin-open"
              title="관리자 설정"
              onClick={() => setAdminOpen(true)}
            >
              ⚙ 관리자
            </button>
          </div>
        </div>
      </header>

      {adminOpen && <AdminPanel onClose={() => setAdminOpen(false)} onDeckChange={handleDeckChange} />}
      {usageOpen && <UsagePanel onClose={() => setUsageOpen(false)} />}
      {libraryOpen && <PptLibraryPanel onClose={() => setLibraryOpen(false)} />}

      <div className={`app${viewMode === 'editor' ? ' app-editor-mode' : ''}`}>
        {viewMode === 'wizard' && (
          <ol
            className="wizard-progress"
            aria-label="PPT 생성 단계"
            style={{ '--active-index': activeStep } as React.CSSProperties}
          >
            {WIZARD_STEPS.map((step, index) => (
              <li
                key={step.id}
                className={`wizard-step${index === activeStep ? ' current' : ''}${index < activeStep ? ' complete' : ''}`}
              >
                <button
                  type="button"
                  className="wizard-step-button"
                  data-testid={`wizard-tab-${step.id}`}
                  aria-current={index === activeStep ? 'step' : undefined}
                  onClick={() => moveToStep(index)}
                >
                  <span className="wizard-step-dot">{index < activeStep ? '✓' : index + 1}</span>
                  <span className="wizard-step-label">{step.label}</span>
                </button>
              </li>
            ))}
          </ol>
        )}

        <div className="app-body">
          {viewMode === 'editor' && (
            <SlideOverviewList
              overview={editorDeck?.overview ?? []}
              slides={editorDeck?.slides ?? null}
              loading={editorLoading}
              error={editorError}
              onSelectSong={scrollToSong}
              onSelectBible={scrollToBible}
              onSelectSermon={scrollToSermon}
              onSelectAnnouncement={scrollToAnnouncement}
              onDownload={() => void generate()}
              onSaveToLibrary={() => void saveCurrentToLibrary()}
              downloading={generating}
              savingToLibrary={savingToLibrary}
            />
          )}
          <main data-direction={direction}>
            <section
              className={`wizard-panel${isPanelActive('lyrics') ? ' active' : ''}`}
              aria-hidden={!isPanelActive('lyrics')}
              data-testid="wizard-panel-lyrics"
            >
              <div className="wizard-page-header">
                <p className="wizard-kicker">1 / 5</p>
                <h2>찬양</h2>
                <p>찬양 콘티를 올리고 각 곡의 가사와 순서를 확인하세요.</p>
              </div>
              <LyricsGenerator
                onSongsChange={handleSongsChange}
                onDateDetected={handleDateDetected}
                onContiInfoDetected={handleContiInfoDetected}
                onContiFileLoaded={setContiFile}
              />
              {viewMode === 'wizard' && <WizardNavigation step={0} onMove={moveToStep} />}
            </section>

            <section
              className={`wizard-panel${isPanelActive('bible') ? ' active' : ''}`}
              aria-hidden={!isPanelActive('bible')}
              data-testid="wizard-panel-bible"
            >
              <div className="wizard-page-header">
                <p className="wizard-kicker">2 / 5</p>
                <h2>성경 말씀</h2>
                <p>콘티에서 읽은 본문과 설교 제목을 확인하고 번역본을 선택하세요.</p>
              </div>
              <BibleSlideGenerator
                onStateChange={handleBibleStateChange}
                autoFillVersion={contiBibleAutoFill.version}
                autoVerseInput={contiBibleAutoFill.verseInput}
                autoSermonTitle={contiBibleAutoFill.sermonTitle}
              />
              {viewMode === 'wizard' && <WizardNavigation step={1} onMove={moveToStep} />}
            </section>

            <section
              className={`wizard-panel${isPanelActive('sermon') ? ' active' : ''}`}
              aria-hidden={!isPanelActive('sermon')}
              data-testid="wizard-panel-sermon"
            >
              <div className="wizard-page-header">
                <p className="wizard-kicker">3 / 5</p>
                <h2>설교</h2>
                <p>목사님의 설교 PPT가 있다면 업로드하세요. 없으면 바로 다음 단계로 이동해도 됩니다.</p>
              </div>
              <SermonUploadSection value={sermonFile} onChange={setSermonFile} />
              {viewMode === 'wizard' && <WizardNavigation step={2} onMove={moveToStep} />}
            </section>

            <section
              className={`wizard-panel${isPanelActive('announcement') ? ' active' : ''}`}
              aria-hidden={!isPanelActive('announcement')}
              data-testid="wizard-panel-announcement"
            >
              <div className="wizard-page-header">
                <p className="wizard-kicker">4 / 5</p>
                <h2>광고</h2>
                <p>예배 광고를 입력하세요. 입력한 항목만 광고 슬라이드로 추가됩니다.</p>
              </div>
              <AnnouncementSection value={announcementText} onChange={setAnnouncementText} />
              {viewMode === 'wizard' && <WizardNavigation step={3} onMove={moveToStep} />}
            </section>

            <section
              className={`wizard-panel${isPanelActive('download') ? ' active' : ''}`}
              aria-hidden={!isPanelActive('download')}
              data-testid="wizard-panel-download"
            >
              <div className="wizard-page-header">
                <p className="wizard-kicker">5 / 5</p>
                <h2>확인 및 다운로드</h2>
                <p>입력한 내용을 확인한 뒤 하나의 PPTX 파일로 다운로드하세요.</p>
              </div>
              <section className="card download-card">
                {allWarnings.length > 0 && (
                  <div className="banner banner-warn">
                    일부 순서 토큰에 해당하는 가사가 없어 건너뜁니다:{' '}
                    {allWarnings.map((w) => `${w.title || '(제목 없음)'}: ${w.tokens.join(', ')}`).join(' · ')}
                  </div>
                )}
                <p className="deck-order">
                  Front slides → 찬양 → 기도 → 말씀 → 설교 → 기도 → 광고 → Back slides
                </p>
                <div className="generate-row">
                  <label htmlFor="filename-input">
                    자동 파일명
                    <input id="filename-input" data-testid="filename-input" value={fileName} readOnly />
                    <span className="input-hint">콘티 날짜가 속한 주의 일요일을 MMDD 형식으로 사용합니다.</span>
                  </label>
                  <div className="slide-count" data-testid="slide-count">
                    총 {totalSlideCount}장{bibleRefs.length > 0 ? ' 이상' : ''} · 찬양 {songs.length}곡 · 말씀{' '}
                    {bibleRefs.length}구절
                    {sermonFile ? ' · 설교 첨부' : ''}
                    {announcementItems.length > 0 ? ` · 광고 ${announcementItems.length}건` : ''}
                  </div>
                  <button
                    className="btn btn-primary btn-download"
                    data-testid="generate-pptx"
                    disabled={generating}
                    onClick={() => void generate()}
                  >
                    {generating ? '생성 중…' : 'PPTX 생성 및 다운로드'}
                  </button>
                  <button
                    className="btn"
                    data-testid="save-to-library"
                    disabled={savingToLibrary}
                    onClick={() => void saveCurrentToLibrary()}
                  >
                    {savingToLibrary ? '저장 중…' : '📚 라이브러리에 저장'}
                  </button>
                </div>
              </section>
              <WizardNavigation step={4} onMove={moveToStep} />
            </section>
          </main>
        </div>

        <p className="brand-footer">KCCP PPT Generator · {contiDate ?? ''}</p>
        <ToastHost />
      </div>
    </>
  );
}
