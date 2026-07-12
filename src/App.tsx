import { useCallback, useState } from 'react';
import LyricsGenerator from './components/LyricsGenerator';
import BibleSlideGenerator, { type BibleGeneratorState } from './components/BibleSlideGenerator';
import SermonUploadSection, { type SermonFile } from './components/SermonUploadSection';
import AnnouncementSection from './components/AnnouncementSection';
import type { ContiInfo, Song } from './lib/types';
import { planAllSlides, unmatchedTokens } from './lib/slidePlanner';
import { buildPptx, suggestFileName } from './lib/pptxBuilder';
import { extractSlideSubset } from './lib/pptxSlices';
import { mergePptxDecks } from './lib/pptxMerge';
import { parseAnnouncements, buildAnnouncementDeck } from './lib/announcementBuilder';
import { loadTranslation } from './bible/bibleData';
import { normalizeContiScripture, parseVerseInput } from './bible/refParser';
import { buildVerseSlidePlan } from './bible/versePlanner';
import { buildBiblePptx } from './bible/pptxBuilder';
import { assertPptxIntegrity } from './lib/pptxPackage';
import ToastHost from './components/ToastHost';
import { showToast } from './lib/toast';

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
  const [generating, setGenerating] = useState(false);
  const [contiBibleAutoFill, setContiBibleAutoFill] = useState({
    version: 0,
    verseInput: '',
    sermonTitle: '',
  });

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

  const bibleRefs = bibleState.verseInput.trim() ? parseVerseInput(bibleState.verseInput).refs : [];
  const announcementItems = announcementText.trim() ? parseAnnouncements(announcementText) : [];
  const fileName = suggestFileName(contiDate);

  const lyricsSlideCount = planAllSlides(songs).length;
  const hasAnyContent = songs.length > 0 || bibleRefs.length > 0 || sermonFile !== null || announcementItems.length > 0;

  async function generate() {
    if (!hasAnyContent) {
      showToast('찬양, 성경 말씀, 설교, 광고 중 최소 하나 이상 입력해 주세요.', 'error');
      return;
    }
    setGenerating(true);
    try {
      const [serviceTemplate, frontSlides, backSlides] = await Promise.all([
        fetch(`${BASE}service-template.pptx`).then((r) => {
          if (!r.ok) throw new Error('서비스 템플릿 파일을 불러오지 못했습니다.');
          return r.arrayBuffer();
        }),
        fetch(`${BASE}front-slides.pptx`).then((r) => {
          if (!r.ok) throw new Error('Front slides 파일을 불러오지 못했습니다.');
          return r.arrayBuffer();
        }),
        fetch(`${BASE}back-slides.pptx`).then((r) => {
          if (!r.ok) throw new Error('Back slides 파일을 불러오지 못했습니다.');
          return r.arrayBuffer();
        }),
      ]);

      let merged: Uint8Array = new Uint8Array(frontSlides);

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

      // The full closing deck is mandatory and always follows announcements.
      merged = await mergePptxDecks(merged, backSlides);
      await assertPptxIntegrity(merged);

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
      showToast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setGenerating(false);
    }
  }

  const allWarnings = songs
    .map((s) => ({ title: s.title, tokens: unmatchedTokens(s) }))
    .filter((w) => w.tokens.length > 0);

  // Front/back + 2 prayer slides always count; the announcement title only
  // appears when there is matching content.
  const fixedSlideCount =
    FRONT_SLIDE_COUNT +
    BACK_SLIDE_COUNT +
    SERVICE_SLIDES.prayer1.length +
    SERVICE_SLIDES.prayer2.length +
    (announcementItems.length > 0 ? SERVICE_SLIDES.announcementTitle.length : 0);
  // Bible slide count isn't known until generation (it depends on how many
  // verses each reference expands to, which needs the full translation
  // data loaded) — shown as a "+" lower bound instead of a false-precise number.
  const totalSlideCount = fixedSlideCount + lyricsSlideCount + announcementItems.length;

  function moveToStep(step: number) {
    setActiveStep(step);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  return (
    <div className="app">
      <header className="header">
        <h1>KCCP PPT Generator</h1>
        <p>필요한 내용을 단계별로 입력하고, 하나의 예배 PPT로 다운로드하세요.</p>
      </header>

      <ol className="wizard-progress" aria-label="PPT 생성 단계">
        {WIZARD_STEPS.map((step, index) => (
          <li
            key={step.id}
            className={`wizard-step${index === activeStep ? ' current' : ''}${index < activeStep ? ' complete' : ''}`}
            aria-current={index === activeStep ? 'step' : undefined}
          >
            <span className="wizard-step-dot">{index < activeStep ? '✓' : index + 1}</span>
            <span className="wizard-step-label">{step.label}</span>
          </li>
        ))}
      </ol>

      <main>
        <section
          className={`wizard-panel${activeStep === 0 ? ' active' : ''}`}
          aria-hidden={activeStep !== 0}
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
          />
          <WizardNavigation step={0} onMove={moveToStep} />
        </section>

        <section
          className={`wizard-panel${activeStep === 1 ? ' active' : ''}`}
          aria-hidden={activeStep !== 1}
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
          <WizardNavigation step={1} onMove={moveToStep} />
        </section>

        <section
          className={`wizard-panel${activeStep === 2 ? ' active' : ''}`}
          aria-hidden={activeStep !== 2}
          data-testid="wizard-panel-sermon"
        >
          <div className="wizard-page-header">
            <p className="wizard-kicker">3 / 5</p>
            <h2>설교</h2>
            <p>목사님의 설교 PPT가 있다면 업로드하세요. 없으면 바로 다음 단계로 이동해도 됩니다.</p>
          </div>
          <SermonUploadSection value={sermonFile} onChange={setSermonFile} />
          <WizardNavigation step={2} onMove={moveToStep} />
        </section>

        <section
          className={`wizard-panel${activeStep === 3 ? ' active' : ''}`}
          aria-hidden={activeStep !== 3}
          data-testid="wizard-panel-announcement"
        >
          <div className="wizard-page-header">
            <p className="wizard-kicker">4 / 5</p>
            <h2>광고</h2>
            <p>예배 광고를 입력하세요. 입력한 항목만 광고 슬라이드로 추가됩니다.</p>
          </div>
          <AnnouncementSection value={announcementText} onChange={setAnnouncementText} />
          <WizardNavigation step={3} onMove={moveToStep} />
        </section>

        <section
          className={`wizard-panel${activeStep === 4 ? ' active' : ''}`}
          aria-hidden={activeStep !== 4}
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
            </div>
          </section>
          <WizardNavigation step={4} onMove={moveToStep} />
        </section>
      </main>

      <p className="brand-footer">KCCP PPT Generator · {contiDate ?? ''}</p>
      <ToastHost />
    </div>
  );
}
