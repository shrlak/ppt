// 수요예배 PPT 생성기 — its own page, because it shares almost nothing with
// the Sunday wizard: no 콘티, no lyrics recognition, no 광고, no 추가 자료.
// Three steps: 예배 정보 → 찬양 → 다운로드.
//
// The sermon is deliberately absent: the deck ends its 말씀 순서 with the 설교
// 구분 장, and the pastor's own slides are inserted after it by hand.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Icon, { type IconName } from '../components/Icon';
import ToastHost from '../components/ToastHost';
import AutoSaveIndicator from '../components/AutoSaveIndicator';
import { showToast } from '../lib/utils/toast';
import { type DeckOverviewItem } from '../lib/utils/deckOverview';
import { buildWednesdayDeck } from './deckBuilder';
import { buildWednesdayThumbnail, thumbnailFileName } from './thumbnail';
import { suggestWednesdayFileName } from './fields';
import { EMPTY_PASSAGE, parsePassageInput, resolvePassage, type ResolvedPassage } from './passage';
import WednesdaySongList, { type SongsUpdate } from './WednesdaySongList';
import {
  clearWednesdayDraft,
  forgetWednesdaySongDeck,
  loadWednesdayDraft,
  saveWednesdayDraft,
} from './draft';
import { emptyWednesdayService, isAttached, type WednesdayService, type WednesdaySong } from './types';
import {
  decodeWednesdaySongDecks,
  decodeWednesdaySource,
  encodeWednesdaySongDecks,
  encodeWednesdaySource,
  wednesdayFingerprint,
} from './source';
import { getSavedDeck, saveDeckToLibrary } from '../lib/storage/pptLibrary';
import {
  AUTO_SAVE_BUSY_POLL_MS,
  AUTO_SAVE_DEBOUNCE_MS,
  AUTO_SAVE_RETRY_MS,
  type AutoSaveStatus,
} from '../lib/storage/deckAutoSave';

const BASE = import.meta.env.BASE_URL || '/';
const DRAFT_DEBOUNCE_MS = 1200;
const PASSAGE_DEBOUNCE_MS = 600;

/** Which icon stands for each overview row's kind. */
function slideIcon(kind: DeckOverviewItem['kind']): IconName {
  switch (kind) {
    case 'lyrics-title':
    case 'lyrics':
      return 'music';
    case 'prayer':
      return 'prayer';
    case 'bible':
      return 'bible';
    case 'sermon':
      return 'sermon';
    case 'divider':
      return 'divider';
    default:
      return 'slide';
  }
}

const STEPS = [
  { id: 'service', label: '예배 정보' },
  { id: 'songs', label: '찬양' },
  { id: 'download', label: '다운로드' },
] as const;

function downloadBytes(bytes: Uint8Array, fileName: string): void {
  const blob = new Blob([bytes as unknown as BlobPart], {
    type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName.endsWith('.pptx') ? fileName : `${fileName}.pptx`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

async function fetchTemplate(name: string, label: string): Promise<ArrayBuffer> {
  const response = await fetch(`${BASE}${name}`);
  if (!response.ok) throw new Error(`${label}을 불러오지 못했습니다.`);
  return response.arrayBuffer();
}

export default function WednesdayApp() {
  const [step, setStep] = useState(0);
  const [service, setService] = useState<WednesdayService>(emptyWednesdayService);
  const [songs, setSongs] = useState<WednesdaySong[]>([]);
  const [fileNameOverride, setFileNameOverride] = useState<string | null>(null);

  const [passage, setPassage] = useState<ResolvedPassage>(EMPTY_PASSAGE);
  const [passageError, setPassageError] = useState<string | null>(null);
  const [passageLoading, setPassageLoading] = useState(false);

  const [generating, setGenerating] = useState(false);
  const [overview, setOverview] = useState<DeckOverviewItem[] | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [draftLoaded, setDraftLoaded] = useState(false);
  const [autoSaveStatus, setAutoSaveStatus] = useState<AutoSaveStatus>({ state: 'idle' });
  const [autoSaveRetry, setAutoSaveRetry] = useState(0);

  // Auto-save bookkeeping, mirroring the Sunday page: which library entry this
  // session writes to, what was last saved, and which inputs already failed
  // once (so a deck that cannot be built does not retry forever).
  const savedFingerprintRef = useRef<string | null>(null);
  const autoSaveTargetRef = useRef<string | null>(null);
  const autoSaveFailedRef = useRef<string | null>(null);
  const savingRef = useRef(false);
  const autoSaveRetryTimer = useRef<number | undefined>(undefined);
  const adoptFingerprintRef = useRef(false);

  const fileName = fileNameOverride ?? suggestWednesdayFileName(service.date);

  // ---- shared 라이브러리: restore an entry, then keep it current ----
  const restoreSavedDeck = useCallback(async (deckId: string) => {
    try {
      const saved = await getSavedDeck(deckId);
      const source = decodeWednesdaySource(saved.source);
      if (!source) {
        showToast('이 항목은 수요예배 입력 내용이 저장되기 전에 만들어졌습니다.', 'warn');
        return;
      }
      setService(source.service);
      setSongs(await decodeWednesdaySongDecks(saved.additionalFiles ?? null, source.songs));
      setFileNameOverride(source.fileNameOverride ?? saved.name);
      // The restored inputs are exactly what the entry already holds, so they
      // become the auto-save baseline instead of triggering another write.
      autoSaveTargetRef.current = saved.id;
      savedFingerprintRef.current = null;
      adoptFingerprintRef.current = true;
      showToast(`'${saved.name}'을(를) 불러왔습니다. 수정하면 같은 항목이 자동으로 갱신됩니다.`);
    } catch (error) {
      showToast(error instanceof Error ? error.message : '라이브러리에서 불러오지 못했습니다.', 'error');
    }
  }, []);

  const saveToLibrary = useCallback(
    async (fingerprint: string) => {
      savingRef.current = true;
      setAutoSaveStatus({ state: 'saving' });
      try {
        const template = await fetchTemplate('wednesday-template.pptx', '수요예배 템플릿');
        const built = await buildWednesdayDeck({
          template,
          service,
          songs,
          verses: passage.verses,
          rangeKo: passage.rangeKo,
        });
        const name = fileName.endsWith('.pptx') ? fileName : `${fileName}.pptx`;
        const { deck: saved } = await saveDeckToLibrary(
          {
            name,
            pptx: { name, data: built.deck.slice().buffer as ArrayBuffer },
            contiPdf: null,
            sermonPptx: null,
            source: encodeWednesdaySource({
              service,
              songs,
              fileNameOverride: fileNameOverride ?? undefined,
            }),
            // The week's 찬양 PPT files, so 편집 on another machine does not
            // have to fetch every one of them again.
            additionalFiles: await encodeWednesdaySongDecks(songs),
            slideCount: built.overview.length,
            songTitles: songs.map((song) => song.title).filter(Boolean),
          },
          autoSaveTargetRef.current ?? undefined,
        );
        savedFingerprintRef.current = fingerprint;
        autoSaveTargetRef.current = saved.id;
        autoSaveFailedRef.current = null;
        setAutoSaveStatus({
          state: 'saved',
          at: new Date().toISOString(),
          syncPending: Boolean(saved.syncPending),
        });
      } catch (error) {
        setAutoSaveStatus({
          state: 'error',
          message: error instanceof Error ? error.message : String(error),
        });
        if (autoSaveFailedRef.current !== fingerprint) {
          autoSaveFailedRef.current = fingerprint;
          window.clearTimeout(autoSaveRetryTimer.current);
          autoSaveRetryTimer.current = window.setTimeout(
            () => setAutoSaveRetry((count) => count + 1),
            AUTO_SAVE_RETRY_MS,
          );
        }
      } finally {
        savingRef.current = false;
      }
    },
    [fileName, fileNameOverride, passage.rangeKo, passage.verses, service, songs],
  );

  // ---- local draft: restore once, then save quietly as things change ----
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const draft = await loadWednesdayDraft();
      if (cancelled) {
        return;
      }
      // A deck id in the URL comes from the 라이브러리's 편집 button on the
      // Sunday page, and wins over whatever this machine was last editing.
      const deckId = new URLSearchParams(window.location.search).get('deck');
      if (deckId) {
        await restoreSavedDeck(deckId);
      } else if (draft) {
        setService(draft.service);
        setSongs(draft.songs);
        setFileNameOverride(draft.fileNameOverride ?? null);
        autoSaveTargetRef.current = draft.deckId ?? null;
        adoptFingerprintRef.current = true;
      }
      setDraftLoaded(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [restoreSavedDeck]);

  // Which songs are attached, and with which file. Typing is debounced, but
  // adding or attaching a song is a single deliberate act — and the thing most
  // expensive to lose — so it is written out at once.
  const songsKey = songs.map((song) => `${song.id}:${song.deck?.byteLength ?? 0}`).join('|');
  const savedSongsKeyRef = useRef<string | null>(null);

  useEffect(() => {
    if (!draftLoaded) return;
    const save = () =>
      void saveWednesdayDraft({
        service,
        songs,
        fileNameOverride: fileNameOverride ?? undefined,
        deckId: autoSaveTargetRef.current ?? undefined,
      });

    if (savedSongsKeyRef.current !== songsKey) {
      savedSongsKeyRef.current = songsKey;
      save();
      return;
    }
    const timer = setTimeout(save, DRAFT_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [draftLoaded, service, songs, songsKey, fileNameOverride]);

  // ---- shared 라이브러리 auto-save: build and upload once edits settle ----
  useEffect(() => {
    if (!draftLoaded) return;
    // Nothing worth a library entry until the week has some content.
    if (!service.date && songs.length === 0 && passage.verses.length === 0) return;

    const fingerprint = wednesdayFingerprint({ name: fileName, service, songs });
    if (adoptFingerprintRef.current) {
      // Restored inputs are already what the entry holds.
      adoptFingerprintRef.current = false;
      savedFingerprintRef.current = fingerprint;
      return;
    }
    if (savedFingerprintRef.current === fingerprint) return;

    setAutoSaveStatus((status) => (status.state === 'saving' ? status : { state: 'pending' }));
    const timer = window.setTimeout(() => {
      if (savingRef.current) {
        // A save is in flight; look again shortly rather than queueing a second.
        window.setTimeout(() => setAutoSaveRetry((count) => count + 1), AUTO_SAVE_BUSY_POLL_MS);
        return;
      }
      void saveToLibrary(fingerprint);
    }, AUTO_SAVE_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [
    draftLoaded,
    fileName,
    service,
    songs,
    passage.verses.length,
    saveToLibrary,
    autoSaveRetry,
  ]);

  // ---- passage: resolve 개역개정 verses for whatever range was typed ----
  const { refs: parsedRefs, invalidTokens } = useMemo(
    () => parsePassageInput(service.verseInput),
    [service.verseInput],
  );

  useEffect(() => {
    if (parsedRefs.length === 0) {
      setPassage(EMPTY_PASSAGE);
      setPassageError(null);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      setPassageLoading(true);
      void resolvePassage(service.verseInput, BASE)
        .then((resolved) => {
          if (cancelled) return;
          setPassage(resolved);
          setPassageError(null);
        })
        .catch((error: unknown) => {
          if (cancelled) return;
          setPassage(EMPTY_PASSAGE);
          setPassageError(error instanceof Error ? error.message : '본문을 불러오지 못했습니다.');
        })
        .finally(() => {
          if (!cancelled) setPassageLoading(false);
        });
    }, PASSAGE_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // parsedRefs is derived from verseInput, which is the real trigger.
  }, [service.verseInput, parsedRefs.length]);

  const patchService = (patch: Partial<WednesdayService>) =>
    setService((current) => ({ ...current, ...patch }));

  const handleSongsChange = useCallback((next: SongsUpdate) => {
    setSongs(next);
    setOverview(null);
  }, []);

  const attachedCount = songs.filter(isAttached).length;
  const songSlideCount = songs.reduce((total, song) => total + (song.slideCount ?? 0), 0);
  const verseGroupCount =
    passage.verses.length > 0
      ? Math.ceil(passage.verses.length / Math.max(1, service.versesPerSlide))
      : 0;
  // 표지·인트로·경배와 찬양 + 곡 제목 장 + 기도·말씀·설교·기도·합심기도·마지막
  const slideCount = 3 + songs.length + 6 + verseGroupCount + songSlideCount;
  const canBuild = service.date !== '' || songs.length > 0 || passage.verses.length > 0;

  const build = async () => {
    const template = await fetchTemplate('wednesday-template.pptx', '수요예배 템플릿');
    return buildWednesdayDeck({
      template,
      service,
      songs,
      verses: passage.verses,
      rangeKo: passage.rangeKo,
    });
  };

  const downloadDeck = async () => {
    setGenerating(true);
    try {
      const result = await build();
      setOverview(result.overview);
      setWarnings(result.warnings);
      downloadBytes(result.deck, fileName);
      for (const warning of result.warnings) showToast(warning, 'warn');
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'PPT를 만들지 못했습니다.', 'error');
    } finally {
      setGenerating(false);
    }
  };

  const downloadThumbnail = async () => {
    setGenerating(true);
    try {
      const template = await fetchTemplate('wednesday-thumbnail.pptx', '썸네일 템플릿');
      const thumbnail = await buildWednesdayThumbnail({ template, service, rangeKo: passage.rangeKo });
      downloadBytes(thumbnail, thumbnailFileName(fileName));
    } catch (error) {
      showToast(error instanceof Error ? error.message : '썸네일을 만들지 못했습니다.', 'error');
    } finally {
      setGenerating(false);
    }
  };

  const resetWeek = async () => {
    await clearWednesdayDraft(songs.map((song) => song.id));
    setService(emptyWednesdayService());
    setSongs([]);
    setFileNameOverride(null);
    setOverview(null);
    setWarnings([]);
    setPassage(EMPTY_PASSAGE);
    showToast('이번 주 입력을 비웠습니다.');
  };

  const headerRef = useRef<HTMLElement>(null);

  return (
    <>
      <a className="skip-link" href="#main-content">
        본문으로 건너뛰기
      </a>
      <header ref={headerRef} className="header">
        <div className="header-inner">
          <div className="header-brand">
            <img
              className="header-logo"
              src={`${BASE}favicon.svg`}
              alt="Korean Central Church of Pittsburgh 로고"
            />
            <div className="header-text">
              <h1>수요예배 PPT Generator</h1>
              <p>예배 정보와 찬양만 입력하면 수요예배 PPT와 썸네일을 만들어 드립니다.</p>
            </div>
          </div>
          <nav className="header-actions" aria-label="도구">
            <a className="btn" href={`${BASE}index.html`} data-testid="wednesday-to-sunday">
              <Icon name="steps" />
              <span className="btn-label">주일예배 생성기</span>
            </a>
          </nav>
        </div>
      </header>

      <div className="app">
        <ol
          className="wizard-progress"
          aria-label="수요예배 PPT 생성 단계"
          style={{ '--active-index': step } as React.CSSProperties}
        >
          {STEPS.map((item, index) => (
            <li
              key={item.id}
              className={`wizard-step${index === step ? ' current' : ''}${index < step ? ' complete' : ''}`}
            >
              <button
                type="button"
                className="wizard-step-button"
                data-testid={`wednesday-tab-${item.id}`}
                aria-current={index === step ? 'step' : undefined}
                onClick={() => setStep(index)}
              >
                <span className="wizard-step-dot">{index < step ? <Icon name="check" /> : index + 1}</span>
                <span className="wizard-step-label">{item.label}</span>
              </button>
            </li>
          ))}
        </ol>

        <div className="app-body">
          <main id="main-content">
            <section
              className={`wizard-panel${step === 0 ? ' active' : ''}`}
              aria-hidden={step !== 0}
              data-testid="wednesday-panel-service"
            >
              <div className="wizard-page-header">
                <p className="wizard-kicker">1 / 3</p>
                <h2>예배 정보</h2>
                <p>표지와 말씀·설교 슬라이드에 들어갈 내용입니다.</p>
              </div>

              <section className="card wednesday-form">
                <label className="field">
                  <span className="field-label">예배 날짜</span>
                  <input
                    type="date"
                    value={service.date}
                    data-testid="wednesday-date"
                    onChange={(event) => patchService({ date: event.target.value })}
                  />
                  <span className="field-hint">파일명은 그 주 수요일 날짜로 «{fileName}» 이 됩니다.</span>
                </label>

                <label className="field">
                  <span className="field-label">설교 제목</span>
                  <input
                    type="text"
                    value={service.sermonTitle}
                    placeholder="예: 나의 힘이 되신 여호와여"
                    data-testid="wednesday-sermon-title"
                    onChange={(event) => patchService({ sermonTitle: event.target.value })}
                  />
                </label>

                <div className="field-row">
                  <label className="field">
                    <span className="field-label">설교자</span>
                    <input
                      type="text"
                      value={service.preacher}
                      placeholder="예: 고신석"
                      data-testid="wednesday-preacher"
                      onChange={(event) => patchService({ preacher: event.target.value })}
                    />
                  </label>
                  <label className="field">
                    <span className="field-label">직분</span>
                    <input
                      type="text"
                      value={service.preacherTitle}
                      placeholder="예: 목사"
                      data-testid="wednesday-preacher-title"
                      onChange={(event) => patchService({ preacherTitle: event.target.value })}
                    />
                  </label>
                </div>

                <label className="field">
                  <span className="field-label">성경 본문 (개역개정)</span>
                  <input
                    type="text"
                    value={service.verseInput}
                    placeholder="예: 시18:1-12 또는 시편 18편 1-12절"
                    data-testid="wednesday-verse-input"
                    onChange={(event) => patchService({ verseInput: event.target.value })}
                  />
                  <span className="field-hint">범위만 적으면 본문은 개역개정에서 자동으로 채웁니다.</span>
                </label>

                <label className="field">
                  <span className="field-label">한 장에 넣을 절 수</span>
                  <input
                    type="number"
                    min={1}
                    max={10}
                    value={service.versesPerSlide}
                    data-testid="wednesday-verses-per-slide"
                    onChange={(event) =>
                      patchService({
                        versesPerSlide: Math.min(10, Math.max(1, Number(event.target.value) || 1)),
                      })
                    }
                  />
                </label>

                <div className="wednesday-passage" data-testid="wednesday-passage-preview">
                  {passageLoading && <p className="empty-hint">본문을 불러오는 중…</p>}
                  {!passageLoading && passageError && (
                    <p className="banner banner-error">
                      <Icon name="warning" />
                      <span className="banner-text">{passageError}</span>
                    </p>
                  )}
                  {!passageLoading && !passageError && passage.verses.length > 0 && (
                    <>
                      <p className="wednesday-passage-range">
                        {passage.rangeKo} · {passage.verses.length}절 · 말씀 슬라이드 {verseGroupCount}장
                      </p>
                      <p className="wednesday-passage-first">
                        {passage.verses[0].verse} {passage.verses[0].text}
                      </p>
                    </>
                  )}
                  {invalidTokens.length > 0 && (
                    <p className="empty-hint">읽을 수 없는 구절: {invalidTokens.join(', ')}</p>
                  )}
                </div>
              </section>

              <div className="wizard-nav">
                <button
                  type="button"
                  className="btn btn-primary"
                  data-testid="wednesday-next-service"
                  onClick={() => setStep(1)}
                >
                  <Icon name="next" />
                  <span className="btn-label">다음: 찬양</span>
                </button>
              </div>
            </section>

            <section
              className={`wizard-panel${step === 1 ? ' active' : ''}`}
              aria-hidden={step !== 1}
              data-testid="wednesday-panel-songs"
            >
              <div className="wizard-page-header">
                <p className="wizard-kicker">2 / 3</p>
                <h2>찬양</h2>
                <p>
                  곡 제목을 적고 찬양 PPT를 받아 오세요. 그 파일의 슬라이드가 순서대로 모두 들어갑니다.
                </p>
              </div>

              <WednesdaySongList
                songs={songs}
                onChange={handleSongsChange}
                onForgetDeck={(id) => void forgetWednesdaySongDeck(id)}
              />

              <div className="wizard-nav">
                <button type="button" className="btn" onClick={() => setStep(0)}>
                  <Icon name="back" />
                  <span className="btn-label">이전</span>
                </button>
                <button
                  type="button"
                  className="btn btn-primary"
                  data-testid="wednesday-next-songs"
                  onClick={() => setStep(2)}
                >
                  <Icon name="next" />
                  <span className="btn-label">다음: 다운로드</span>
                </button>
              </div>
            </section>

            <section
              className={`wizard-panel${step === 2 ? ' active' : ''}`}
              aria-hidden={step !== 2}
              data-testid="wednesday-panel-download"
            >
              <div className="wizard-page-header">
                <p className="wizard-kicker">3 / 3</p>
                <h2>확인 및 다운로드</h2>
                <p>설교 슬라이드는 들어가지 않습니다 — 설교 구분 장 뒤에 직접 넣으세요.</p>
              </div>

              <section className="card download-card">
                <label className="field">
                  <span className="field-label">파일명</span>
                  <input
                    type="text"
                    value={fileName}
                    data-testid="wednesday-file-name"
                    onChange={(event) => setFileNameOverride(event.target.value)}
                  />
                </label>

                <dl className="wednesday-summary" data-testid="wednesday-summary">
                  <div>
                    <dt>찬양</dt>
                    <dd>
                      {songs.length}곡 (파일 있는 곡 {attachedCount}곡 · 슬라이드 {songSlideCount}장)
                    </dd>
                  </div>
                  <div>
                    <dt>말씀</dt>
                    <dd>{passage.rangeKo ? `${passage.rangeKo} · ${verseGroupCount}장` : '없음'}</dd>
                  </div>
                  <div>
                    <dt>전체 슬라이드</dt>
                    <dd>약 {slideCount}장</dd>
                  </div>
                </dl>

                {warnings.length > 0 && (
                  <ul className="wednesday-warnings" data-testid="wednesday-warnings">
                    {warnings.map((warning) => (
                      <li key={warning} className="banner banner-notice">
                        <Icon name="info" />
                        <span className="banner-text">{warning}</span>
                      </li>
                    ))}
                  </ul>
                )}

                <AutoSaveIndicator status={autoSaveStatus} testId="wednesday-auto-save-status" />

                <div className="download-actions">
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={generating || !canBuild}
                    data-testid="wednesday-download"
                    onClick={() => void downloadDeck()}
                  >
                    <Icon name="download" />
                    <span className="btn-label">{generating ? '만드는 중…' : '수요예배 PPT 다운로드'}</span>
                  </button>
                  <button
                    type="button"
                    className="btn"
                    disabled={generating}
                    data-testid="wednesday-download-thumbnail"
                    onClick={() => void downloadThumbnail()}
                  >
                    <Icon name="file-down" />
                    <span className="btn-label">썸네일만 다운로드</span>
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost"
                    data-testid="wednesday-reset"
                    onClick={() => void resetWeek()}
                  >
                    <Icon name="trash" />
                    <span className="btn-label">이번 주 비우기</span>
                  </button>
                </div>
              </section>

              {overview && (
                <section className="card wednesday-slide-list" data-testid="wednesday-slide-list">
                  <h3>만든 슬라이드 {overview.length}장</h3>
                  <ol>
                    {overview.map((item, index) => (
                      <li key={item.id} data-kind={item.kind}>
                        <span className="wednesday-slide-index">{index + 1}</span>
                        <Icon name={slideIcon(item.kind)} />
                        <span className="wednesday-slide-label">{item.label}</span>
                        {item.subtitle && <span className="wednesday-slide-subtitle">{item.subtitle}</span>}
                      </li>
                    ))}
                  </ol>
                </section>
              )}

              <div className="wizard-nav">
                <button type="button" className="btn" onClick={() => setStep(1)}>
                  <Icon name="back" />
                  <span className="btn-label">이전</span>
                </button>
              </div>
            </section>
          </main>
        </div>
      </div>

      <ToastHost />
    </>
  );
}
