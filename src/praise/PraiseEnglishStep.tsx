// 영어 가사 step: every song's English, slide by slide.
//
// Each Korean slide the deck will print gets its own English box right next
// to it, so what is typed here is exactly what appears under that slide.
// English the 영어 가사 library already knows (last year's deck, or a song
// saved since) is filled in automatically; the rest can be pasted in one go,
// asked of the AI, or typed.
import { useState } from 'react';
import Icon from '../components/Icon';
import type { Song } from '../lib/utils/types';
import { showToast } from '../lib/utils/toast';
import { fetchEnglishWithAi } from './englishAi';
import { findEnglishEntry, type EnglishSongEntry } from './englishLibrary';
import { distributeEnglish } from './englishText';
import { planPraiseSong } from './planner';
import { extrasFor, type PraiseSongExtras } from './types';

interface Props {
  songs: Song[];
  extras: Record<string, PraiseSongExtras>;
  library: EnglishSongEntry[];
  onExtrasChange: (songId: string, update: (current: PraiseSongExtras) => PraiseSongExtras) => void;
  /** Replace a song's Korean with the library's copy (and its English). */
  onLoadFromLibrary: (song: Song, entry: EnglishSongEntry) => void;
  onSaveToLibrary: (song: Song) => Promise<void>;
}

const SOURCE_LABEL: Record<NonNullable<PraiseSongExtras['englishSource']>, string> = {
  memory: '저장된 영어 가사',
  ai: 'AI 초안 · 확인 필요',
  manual: '직접 입력',
};

function songHasLyrics(song: Song): boolean {
  return song.sections.some((section) => section.lines.some((line) => line.trim()));
}

function SongEnglishCard({
  song,
  index,
  extras,
  entry,
  onExtrasChange,
  onLoadFromLibrary,
  onSaveToLibrary,
}: {
  song: Song;
  index: number;
  extras: PraiseSongExtras;
  entry: EnglishSongEntry | undefined;
  onExtrasChange: Props['onExtrasChange'];
  onLoadFromLibrary: Props['onLoadFromLibrary'];
  onSaveToLibrary: Props['onSaveToLibrary'];
}) {
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteText, setPasteText] = useState('');
  const [aiBusy, setAiBusy] = useState(false);
  const [saving, setSaving] = useState(false);

  const plan = planPraiseSong(song, extras);
  const done = plan.slides.filter((slide) => slide.english.length > 0).length;
  const hasLyrics = songHasLyrics(song);
  const update = (change: (current: PraiseSongExtras) => PraiseSongExtras) => onExtrasChange(song.id, change);

  const setSlideEnglish = (key: string, text: string) =>
    update((current) => ({
      ...current,
      englishSource: 'manual',
      // Kept as typed (blank lines too) so the box edits naturally; the
      // planner drops blank lines when it lays the slide out.
      english: { ...current.english, slides: { ...current.english.slides, [key]: text.split('\n') } },
    }));

  async function fillWithAi() {
    setAiBusy(true);
    try {
      const result = await fetchEnglishWithAi(
        song.title,
        plan.slides.map((slide) => slide.lines),
      );
      update((current) => {
        const slides = { ...current.english.slides };
        plan.slides.forEach((slide, slideIndex) => {
          // AI never overwrites English someone already has there.
          const existing = (slides[slide.key] ?? []).filter((line) => line.trim());
          if (existing.length === 0 && result.slides[slideIndex].length > 0) slides[slide.key] = result.slides[slideIndex];
        });
        return {
          ...current,
          englishSource: 'ai',
          english: { title: current.english.title.trim() || result.englishTitle, slides },
        };
      });
      showToast(`'${song.title}' 영어 가사를 AI로 채웠습니다. 프로젝터에 띄우기 전에 한 번 확인해 주세요.`, 'warn');
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), 'error');
    } finally {
      setAiBusy(false);
    }
  }

  function applyPaste() {
    const distributed = distributeEnglish(pasteText, plan.slides);
    update((current) => ({
      ...current,
      englishSource: 'manual',
      english: { ...current.english, slides: { ...current.english.slides, ...distributed } },
    }));
    setPasteOpen(false);
    setPasteText('');
  }

  async function save() {
    setSaving(true);
    try {
      await onSaveToLibrary(song);
    } finally {
      setSaving(false);
    }
  }

  return (
    <article className="card praise-song" data-testid="praise-english-song" id={`praise-song-${song.id}`}>
      <header className="praise-song-head">
        <span className="wednesday-song-index" aria-hidden="true">
          {index + 1}
        </span>
        <div className="praise-song-titles">
          <strong className="praise-song-title">{song.title || '(제목 없음)'}</strong>
          {!plan.englishOnly && (
            <input
              type="text"
              className="praise-english-title"
              aria-label={`${song.title} 영어 제목`}
              placeholder="English title (예: Goodness of God)"
              value={extras.english.title}
              data-testid="praise-english-title"
              onChange={(event) =>
                update((current) => ({ ...current, english: { ...current.english, title: event.target.value } }))
              }
            />
          )}
        </div>
        <span
          className={`praise-song-status${plan.englishOnly || (plan.slides.length > 0 && done === plan.slides.length) ? ' is-done' : ''}`}
          data-testid="praise-english-status"
        >
          {plan.englishOnly
            ? '영어 곡'
            : plan.slides.length === 0
              ? '가사 없음'
              : `영어 ${done}/${plan.slides.length}장`}
          {!plan.englishOnly && extras.englishSource ? ` · ${SOURCE_LABEL[extras.englishSource]}` : ''}
        </span>
      </header>

      <div className="praise-song-tools">
        {entry && (
          <button
            type="button"
            className="btn"
            data-testid="praise-load-library"
            title="찬양집회 영어 가사 라이브러리에 저장된 한글·영어 가사로 이 곡을 바꿉니다."
            onClick={() => onLoadFromLibrary(song, entry)}
          >
            <Icon name="library" />
            저장된 가사로 {hasLyrics ? '바꾸기' : '불러오기'}
          </button>
        )}
        {!plan.englishOnly && plan.slides.length > 0 && (
          <>
            <button
              type="button"
              className="btn"
              disabled={aiBusy}
              data-testid="praise-ai-fill"
              onClick={() => void fillWithAi()}
            >
              <Icon name="refresh" />
              {aiBusy ? 'AI가 찾는 중…' : 'AI로 빈 칸 채우기'}
            </button>
            <button
              type="button"
              className="btn"
              aria-expanded={pasteOpen}
              data-testid="praise-paste-toggle"
              onClick={() => setPasteOpen((open) => !open)}
            >
              <Icon name="lyrics" />
              영어 가사 한 번에 붙여넣기
            </button>
          </>
        )}
        {plan.slides.length > 0 && (
          <button
            type="button"
            className="btn btn-ghost"
            disabled={saving}
            data-testid="praise-save-english"
            title="다음 찬양집회에서 이 곡의 영어 가사를 다시 입력하지 않도록 저장합니다."
            onClick={() => void save()}
          >
            <Icon name="save" />
            {saving ? '저장 중…' : '영어 가사 저장'}
          </button>
        )}
        <label className="praise-prayer-toggle">
          <input
            type="checkbox"
            checked={Boolean(extras.prayerAfter)}
            data-testid="praise-prayer-after"
            onChange={(event) => update((current) => ({ ...current, prayerAfter: event.target.checked || undefined }))}
          />
          이 곡 뒤에 기도 / Prayer 슬라이드
        </label>
      </div>

      {pasteOpen && (
        <div className="praise-paste">
          <label className="field">
            <span className="field-label">영어 가사 전체</span>
            <textarea
              rows={8}
              value={pasteText}
              placeholder={'I love You Lord\nOh Your mercy never fails me\n\nFrom the moment that I wake up\n…'}
              data-testid="praise-paste-input"
              onChange={(event) => setPasteText(event.target.value)}
            />
            <span className="field-hint">
              빈 줄로 나눈 문단 수가 슬라이드 수({plan.slides.length}장)와 같으면 문단마다 한 장씩, 아니면 줄을 순서대로
              나눠 넣습니다. 이미 적힌 영어도 덮어씁니다.
            </span>
          </label>
          <div className="praise-paste-actions">
            <button type="button" className="btn btn-ghost" onClick={() => setPasteOpen(false)}>
              취소
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={!pasteText.trim()}
              data-testid="praise-paste-apply"
              onClick={applyPaste}
            >
              슬라이드에 나눠 넣기
            </button>
          </div>
        </div>
      )}

      {!hasLyrics ? (
        <p className="empty-hint">
          아직 한글 가사가 없습니다. 찬양 단계에서 가사를 채우거나
          {entry ? ' 위의 ‘저장된 가사로 불러오기’를 누르세요.' : ' 악보 인식을 기다려 주세요.'}
        </p>
      ) : plan.englishOnly ? (
        <p className="empty-hint">영어로만 부르는 곡이라 가사가 한 번만 나옵니다 ({plan.slides.length}장).</p>
      ) : (
        <ol className="praise-slides">
          {plan.slides.map((slide, slideIndex) => (
            <li key={`${slide.key}-${slideIndex}`} className="praise-slide" data-testid="praise-slide-row">
              <span className="praise-slide-number">{slideIndex + 1}</span>
              <div className="praise-slide-ko" lang="ko">
                {slide.lines.map((line, lineIndex) => (
                  <span key={lineIndex}>{line}</span>
                ))}
                {slide.pages.length > 1 && (
                  <em className="praise-slide-split" data-testid="praise-slide-split">
                    한글·영어가 한 화면에 다 안 들어가 {slide.pages.length}장으로 나눠 넣습니다.
                  </em>
                )}
              </div>
              <textarea
                className="praise-slide-en"
                lang="en"
                rows={Math.max(2, slide.lines.length, (extras.english.slides[slide.key] ?? []).length)}
                aria-label={`${slideIndex + 1}번째 슬라이드 영어 가사`}
                placeholder="English lyrics"
                value={(extras.english.slides[slide.key] ?? []).join('\n')}
                data-testid="praise-slide-english"
                onChange={(event) => setSlideEnglish(slide.key, event.target.value)}
              />
            </li>
          ))}
        </ol>
      )}
    </article>
  );
}

export default function PraiseEnglishStep({
  songs,
  extras,
  library,
  onExtrasChange,
  onLoadFromLibrary,
  onSaveToLibrary,
}: Props) {
  if (songs.length === 0) {
    return (
      <section className="card">
        <p className="empty-hint" data-testid="praise-english-empty">
          찬양 단계에서 콘티를 올리면 곡마다 영어 가사를 넣을 수 있습니다.
        </p>
      </section>
    );
  }
  return (
    <div className="praise-songs">
      {songs.map((song, index) => (
        <SongEnglishCard
          key={song.id}
          song={song}
          index={index}
          extras={extrasFor(extras, song.id)}
          entry={findEnglishEntry(library, song.title)}
          onExtrasChange={onExtrasChange}
          onLoadFromLibrary={onLoadFromLibrary}
          onSaveToLibrary={onSaveToLibrary}
        />
      ))}
    </div>
  );
}
