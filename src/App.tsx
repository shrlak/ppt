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
import AutoSaveIndicator from './components/AutoSaveIndicator';
import { getCustomDeck, type DeckSlot, type StoredDeck } from './lib/storage/deckStore';
import { inspectDeckBytes, saveDeckToLibrary, type SavedDeck, type SavedDeckResult } from './lib/storage/pptLibrary';
import { decodeDeckSource, encodeDeckSource } from './lib/storage/deckSource';
import {
  AUTO_SAVE_BUSY_POLL_MS,
  AUTO_SAVE_DEBOUNCE_MS,
  AUTO_SAVE_RETRY_MS,
  deckFingerprint,
  type AutoSaveStatus,
} from './lib/storage/deckAutoSave';
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
  // The 라이브러리 entry currently open for editing. Saving writes back to this
  // exact entry (by id, so a rename still updates it instead of adding a copy).
  const [editingDeck, setEditingDeck] = useState<{ id: string; name: string } | null>(null);
  // Set when the deck name is typed in or restored, replacing the date-derived
  // suggestion until it is cleared.
  const [nameOverride, setNameOverride] = useState<string | null>(null);
  // Inputs pushed back into the 찬양/성경 말씀 steps when a saved deck is
  // reopened. Those steps own their state, so a version bump is what tells
  // them a restore happened (the same idiom the 콘티 auto-fill above uses).
  const [restore, setRestore] = useState<{
    version: number;
    songs: Song[] | null;
    conti: { name: string; data: ArrayBuffer } | null;
    bible: Omit<BibleGeneratorState, 'customTemplate'> | null;
  }>({ version: 0, songs: null, conti: null, bible: null });
  const [editorDeck, setEditorDeck] = useState<{ overview: DeckOverviewItem[]; slides: RenderedSlide[] } | null>(null);
  const [editorLoading, setEditorLoading] = useState(false);
  const [editorError, setEditorError] = useState<string | null>(null);
  const editorSlidesRef = useRef<RenderedSlide[]>([]);

  const [autoSaveStatus, setAutoSaveStatus] = useState<AutoSaveStatus>({ state: 'idle' });
  // Fingerprint of the inputs the 라이브러리 already holds; auto-save skips any
  // edit that leaves it unchanged (see deckAutoSave.ts).
  const savedFingerprintRef = useRef<string | null>(null);
  // The entry auto-save keeps writing to, so a later rename updates that entry
  // instead of leaving the pre-rename copy behind. 편집 sets it too; 새 항목으로
  // 저장 clears it.
  const autoSaveTargetRef = useRef<string | null>(null);
  // Set while a saved deck is being restored: the first settled fingerprint
  // after that is what the entry already holds, so it is adopted rather than
  // written straight back.
  const adoptFingerprintRef = useRef(false);
  // One save at a time — a manual save and an auto-save must never build and
  // upload the same deck concurrently.
  const savingRef = useRef(false);
  const autoSaveRetryRef = useRef(0);
  // The fingerprint whose auto-save already failed and was retried once.
  const autoSaveFailedRef = useRef<string | null>(null);
  // Bumped to re-arm the auto-save timer after a failure.
  const [autoSaveRetry, setAutoSaveRetry] = useState(0);

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
  const fileName = nameOverride ?? suggestFileName(contiDate);

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

  // Recomputed every render, but cheap next to rebuilding the deck: it is what
  // tells auto-save whether this render actually changed the generated file.
  const fingerprint = deckFingerprint({
    name: fileName,
    contiDate,
    songs,
    bible: {
      verseInput: bibleState.verseInput,
      sermonTitle: bibleState.sermonTitle,
      translations: bibleState.translations,
      versesPerSlide: bibleState.versesPerSlide,
    },
    bibleTemplate: bibleState.customTemplate,
    announcementText,
    sermonFile,
    contiFile,
    frontDeck: customDecks.front,
    backDeck: customDecks.back,
  });

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

  const savedName = fileName.endsWith('.pptx') ? fileName : `${fileName}.pptx`;

  /**
   * Build the current deck and write it into the 라이브러리 under `savedName`,
   * archiving the conti PDF, the 설교 PPT and the wizard inputs alongside it.
   * Shared by the 라이브러리에 저장 buttons and by auto-save, so both always
   * store exactly the same thing.
   */
  async function writeToLibrary(replaceId?: string): Promise<SavedDeckResult> {
    const { merged } = await buildMergedDeck();
    const { slideCount } = await inspectDeckBytes(merged.buffer as ArrayBuffer);
    return saveDeckToLibrary(
      {
        name: savedName,
        pptx: { name: savedName, data: merged.buffer as ArrayBuffer },
        contiPdf: contiFile,
        sermonPptx: sermonFile ? { name: sermonFile.name, data: sermonFile.data } : null,
        // Archive the inputs too, so 편집 can reopen this deck in these steps.
        source: encodeDeckSource({
          contiDate,
          songs,
          bible: {
            verseInput: bibleState.verseInput,
            sermonTitle: bibleState.sermonTitle,
            translations: bibleState.translations,
            versesPerSlide: bibleState.versesPerSlide,
          },
          announcementText,
        }),
        slideCount,
        songTitles: songs.map((s) => s.title.trim()).filter(Boolean),
      },
      replaceId,
    );
  }

  async function saveCurrentToLibrary() {
    if (!hasAnyContent) {
      showToast('찬양, 성경 말씀, 설교, 광고 중 최소 하나 이상 입력해 주세요.', 'error');
      return;
    }
    if (savingRef.current) return;
    savingRef.current = true;
    setSavingToLibrary(true);
    try {
      const { deck: saved, replaced } = await writeToLibrary(editingDeck?.id);
      // A plain save stays unattached, so the next one still matches by name
      // and the file name keeps following the conti date. Only a deck opened
      // with 편집 is bound to an entry, and it keeps that binding across a rename.
      if (editingDeck) setEditingDeck({ id: saved.id, name: savedName });
      // Auto-save now owns this entry: it has the bytes this save just wrote,
      // so the next auto-save updates it instead of adding a second copy.
      autoSaveTargetRef.current = saved.id;
      savedFingerprintRef.current = fingerprint;
      adoptFingerprintRef.current = false;
      setAutoSaveStatus({
        state: 'saved',
        at: new Date().toISOString(),
        syncPending: Boolean(saved.syncPending),
      });
      const message = editingDeck
        ? `'${savedName}'을(를) 수정했습니다.`
        : replaced > 0
          ? `같은 이름의 기존 PPT를 덮어쓰고 '${savedName}'을(를) 라이브러리에 저장했습니다.`
          : `'${savedName}'을(를) 라이브러리에 저장했습니다.`;
      showToast(
        saved.syncPending
          ? `${message} 서버 연결 시 다른 기기에도 자동으로 동기화됩니다.`
          : message,
      );
    } catch (e) {
      showToast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      savingRef.current = false;
      setSavingToLibrary(false);
    }
  }

  /**
   * Write the current inputs into the 라이브러리 without a button press, once
   * an edit has settled. Unlike the manual save this reports through the
   * status line rather than a toast, and it always targets the entry this
   * session is already writing to (the 편집 entry, or whatever the last save
   * created) so a rename moves that entry instead of forking it.
   */
  async function autoSaveNow(current: string) {
    savingRef.current = true;
    setAutoSaveStatus({ state: 'saving' });
    setSavingToLibrary(true);
    try {
      const { deck: saved } = await writeToLibrary(editingDeck?.id ?? autoSaveTargetRef.current ?? undefined);
      savedFingerprintRef.current = current;
      autoSaveTargetRef.current = saved.id;
      autoSaveFailedRef.current = null;
      if (editingDeck && editingDeck.name !== savedName) setEditingDeck({ id: saved.id, name: savedName });
      setAutoSaveStatus({
        state: 'saved',
        at: new Date().toISOString(),
        syncPending: Boolean(saved.syncPending),
      });
    } catch (e) {
      setAutoSaveStatus({ state: 'error', message: e instanceof Error ? e.message : String(e) });
      // Retry these exact inputs once; after that the next edit is the trigger,
      // so a deck that cannot be built never rebuilds itself forever.
      if (autoSaveFailedRef.current !== current) {
        autoSaveFailedRef.current = current;
        window.clearTimeout(autoSaveRetryRef.current);
        autoSaveRetryRef.current = window.setTimeout(() => setAutoSaveRetry((n) => n + 1), AUTO_SAVE_RETRY_MS);
      }
    } finally {
      savingRef.current = false;
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

  /**
   * Auto-save: every edit that changes the deck is written back to the PPT
   * 라이브러리 once typing settles, so work is never lost to a closed tab and
   * the entry on every device stays current without pressing 저장. Same entry
   * throughout — this rewrites the deck it is already bound to rather than
   * piling up one entry per edit.
   */
  useEffect(() => {
    if (!hasAnyContent) return;
    if (fingerprint === savedFingerprintRef.current) return;
    setAutoSaveStatus((previous) => (previous.state === 'saving' ? previous : { state: 'pending' }));

    let cancelled = false;
    let timer = 0;
    const run = () => {
      if (cancelled) return;
      // Wait out a manual save (or the previous auto-save) rather than
      // building and uploading the same deck twice at once.
      if (savingRef.current) {
        timer = window.setTimeout(run, AUTO_SAVE_BUSY_POLL_MS);
        return;
      }
      if (adoptFingerprintRef.current) {
        // A deck just reopened from 라이브러리: what settled here is what the
        // entry already holds, so take it as the baseline and save nothing.
        adoptFingerprintRef.current = false;
        savedFingerprintRef.current = fingerprint;
        setAutoSaveStatus({ state: 'idle' });
        return;
      }
      void autoSaveNow(fingerprint);
    };
    timer = window.setTimeout(run, AUTO_SAVE_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fingerprint, hasAnyContent, autoSaveRetry]);

  // Drop a scheduled retry if the app goes away first.
  useEffect(() => () => window.clearTimeout(autoSaveRetryRef.current), []);

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

  /**
   * 라이브러리 → 편집: reopen a saved deck in the five wizard steps with the
   * inputs it was generated from, so it is edited the same way it was built
   * and re-saved over the same entry. Entries saved before inputs snapshots
   * existed still restore their archived 콘티 PDF and 설교 PPT — the 콘티 is
   * re-parsed by the 찬양 step exactly as a fresh upload would be.
   */
  function openSavedDeck(deck: SavedDeck) {
    const source = decodeDeckSource(deck.source);
    setLibraryOpen(false);
    setViewMode('wizard');
    setDirection('back');
    setActiveStep(0);
    window.scrollTo({ top: 0, behavior: 'smooth' });

    setEditingDeck({ id: deck.id, name: deck.name });
    setNameOverride(deck.name);
    // Auto-save writes back to this entry, and the restored inputs are already
    // what it holds — adopt them as the baseline instead of re-saving them.
    autoSaveTargetRef.current = deck.id;
    savedFingerprintRef.current = null;
    adoptFingerprintRef.current = true;
    autoSaveFailedRef.current = null;
    setAutoSaveStatus({ state: 'idle' });
    setContiFile(deck.contiPdf);
    setSermonFile(deck.sermonPptx);
    setAnnouncementText(source?.announcementText ?? '');
    setContiDate(source?.contiDate);
    setRestore((previous) => ({
      version: previous.version + 1,
      songs: source?.songs ?? null,
      // Only fall back to re-parsing the 콘티 when no song list was saved.
      conti: source ? null : deck.contiPdf,
      bible: source?.bible ?? null,
    }));

    showToast(
      source
        ? `'${deck.name}'을(를) 불러왔습니다. 내용을 수정하면 같은 항목이 자동으로 갱신됩니다.`
        : `'${deck.name}'은(는) 입력 내용이 함께 저장되기 전에 만들어져 콘티 PDF와 설교 PPT만 복원했습니다. 광고와 가사 수정은 다시 입력해 주세요.`,
      source ? 'notice' : 'warn',
    );
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
      {libraryOpen && <PptLibraryPanel onClose={() => setLibraryOpen(false)} onEdit={openSavedDeck} />}

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
              autoSaveStatus={autoSaveStatus}
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
                restoreVersion={restore.version}
                restoreSongs={restore.songs}
                restoreConti={restore.conti}
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
                restoreVersion={restore.version}
                restoreState={restore.bible}
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
                {editingDeck && (
                  <div className="banner" data-testid="editing-deck-banner">
                    라이브러리의 &lsquo;{editingDeck.name}&rsquo;을(를) 편집하고 있습니다. 저장하면 같은
                    항목이 갱신됩니다.{' '}
                    <button
                      type="button"
                      className="btn btn-ghost"
                      data-testid="editing-deck-detach"
                      onClick={() => {
                        // Release the name too, or the "new" entry would save
                        // straight back onto the one just detached from.
                        setEditingDeck(null);
                        setNameOverride(null);
                        // Auto-save must let go of the entry as well, so the
                        // next one creates the new item instead of renaming it.
                        autoSaveTargetRef.current = null;
                      }}
                    >
                      새 항목으로 저장
                    </button>
                  </div>
                )}
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
                    파일명
                    <input
                      id="filename-input"
                      data-testid="filename-input"
                      value={fileName}
                      onChange={(e) => setNameOverride(e.target.value)}
                    />
                    <span className="input-hint">
                      {nameOverride === null
                        ? '콘티 날짜가 속한 주의 일요일을 MMDD 형식으로 사용합니다.'
                        : '직접 입력한 이름을 사용합니다. 라이브러리에도 이 이름으로 저장됩니다.'}
                    </span>
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
                <AutoSaveIndicator status={autoSaveStatus} testId="auto-save-status" />
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
