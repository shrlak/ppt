// 기도 step: how many times the night prays, what each 기도 projects, and
// which songs they come after.
//
// The top card holds the count (기도 횟수, − / +) and the songs to check: the
// night's 기도 go after the checked songs in order — 기도 1 after the first
// checked song, 기도 2 after the second (see prayers.ts). Below it, one card
// per 기도 lists its slides in the order they are projected — 기도제목 (typed
// one topic to a line), 말씀 (a passage, read in 개역개정 and NASB) and
// 기도 / Prayer or another prayer title — each movable, removable, and
// added with the buttons at the card's foot.
import { useEffect, useRef, useState } from 'react';
import Icon from '../components/Icon';
import type { Song } from '../lib/utils/types';
import { paginateTopics, planPrayerSlides } from './planner';
import {
  PRAYER_TITLE_PRESETS,
  createPrayerSlide,
  isEmptyPrayerSlide,
  movePrayerSlide,
  placePrayers,
  topicLines,
} from './prayers';
import { parsePraisePassage, resolvePraisePassage, type BibleLoader } from './scripture';
import type { PraisePassage, PraisePrayer, PraisePrayerSlide, PraisePrayerSlideKind, PraiseSongExtras } from './types';

interface Props {
  songs: Song[];
  extras: Record<string, PraiseSongExtras>;
  prayers: PraisePrayer[];
  onPrayerAfter: (songId: string, on: boolean) => void;
  onAddPrayer: () => void;
  /** Take out 기도 `index` (0-based). */
  onRemovePrayer: (index: number) => void;
  onPrayerChange: (prayerId: string, update: (prayer: PraisePrayer) => PraisePrayer) => void;
  loadBible: BibleLoader;
}

const KIND_LABEL: Record<PraisePrayerSlideKind, string> = {
  topics: '기도제목',
  scripture: '말씀',
  title: '기도 슬라이드',
};

/** How long a typed passage must sit still before it is looked up. */
const PASSAGE_DELAY_MS = 450;

function songLabel(songs: Song[], songId: string): string {
  const index = songs.findIndex((song) => song.id === songId);
  return `${index + 1}. ${songs[index]?.title.trim() || '(제목 없음)'}`;
}

function TopicsEditor({
  slide,
  onChange,
}: {
  slide: Extract<PraisePrayerSlide, { kind: 'topics' }>;
  onChange: (slide: PraisePrayerSlide) => void;
}) {
  const topics = topicLines(slide.text);
  const pages = paginateTopics(topics).length;
  return (
    <div className="praise-prayer-fields">
      <div className="praise-prayer-heading-fields">
        <label className="field">
          <span className="field-label">제목 (한글)</span>
          <input
            type="text"
            value={slide.heading}
            placeholder="기도제목"
            data-testid="praise-topics-heading"
            onChange={(event) => onChange({ ...slide, heading: event.target.value })}
          />
        </label>
        <label className="field">
          <span className="field-label">제목 (English)</span>
          <input
            type="text"
            lang="en"
            value={slide.headingEn}
            placeholder="Prayer Prompt"
            data-testid="praise-topics-heading-en"
            onChange={(event) => onChange({ ...slide, headingEn: event.target.value })}
          />
        </label>
      </div>
      <label className="field">
        <span className="field-label">기도제목</span>
        <textarea
          rows={Math.max(3, slide.text.split('\n').length)}
          value={slide.text}
          placeholder={'찬양집회를 통해 성령님께서 모든 지체들의 마음을 만지시도록\n복음의 열정이 회복되고 지속될 수 있도록'}
          data-testid="praise-topics-input"
          onChange={(event) => onChange({ ...slide, text: event.target.value })}
        />
        <span className="field-hint" data-testid="praise-topics-hint">
          {topics.length === 0
            ? '한 줄에 기도제목 하나씩 적으세요. 비워 두면 이 슬라이드는 넣지 않습니다.'
            : `기도제목 ${topics.length}개${pages > 1 ? ` · 한 장에 다 안 들어가 ${pages}장으로 나눠 넣습니다` : ' · 1장'}. 슬라이드 제목은 ‘${[slide.heading.trim(), slide.headingEn.trim()].filter(Boolean).join(' | ')}’로 한 줄에 들어갑니다.`}
        </span>
      </label>
    </div>
  );
}

function ScriptureEditor({
  slide,
  onChange,
  loadBible,
}: {
  slide: Extract<PraisePrayerSlide, { kind: 'scripture' }>;
  onChange: (update: (slide: PraisePrayerSlide) => PraisePrayerSlide) => void;
  loadBible: BibleLoader;
}) {
  const [status, setStatus] = useState<{ state: 'idle' | 'loading' } | { state: 'error'; message: string }>({
    state: 'idle',
  });
  // The reference the stored passage was read for: a reopened night already has it.
  const resolvedFor = useRef<string | null>(slide.passage ? slide.reference : null);
  const reference = slide.reference;

  useEffect(() => {
    const text = reference.trim();
    if (resolvedFor.current === reference) return;
    if (!text || parsePraisePassage(text).refs.length === 0) {
      setStatus({ state: 'idle' });
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      setStatus({ state: 'loading' });
      resolvePraisePassage(text, loadBible)
        .then((passage) => {
          if (cancelled) return;
          resolvedFor.current = reference;
          setStatus({ state: 'idle' });
          onChange((current) =>
            current.kind === 'scripture' && current.reference === reference ? { ...current, passage } : current,
          );
        })
        .catch((error: unknown) => {
          if (cancelled) return;
          setStatus({ state: 'error', message: error instanceof Error ? error.message : String(error) });
        });
    }, PASSAGE_DELAY_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
    // onChange is rebuilt every render; the passage depends on the reference alone.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reference, loadBible]);

  const parsed = parsePraisePassage(reference);
  const passage: PraisePassage | null = slide.passage;
  return (
    <div className="praise-prayer-fields">
      <label className="field">
        <span className="field-label">말씀 구절</span>
        <input
          type="text"
          value={reference}
          placeholder="예: 사도행전 1장 3-5, 8절 · 행1:3-5,8 · Acts 1:3-5, 8"
          data-testid="praise-scripture-input"
          onChange={(event) => {
            resolvedFor.current = null;
            // The verses of the old reference never stay under a new one.
            onChange((current) => ({ ...current, reference: event.target.value, passage: null }) as PraisePrayerSlide);
          }}
        />
        <span
          className={`field-hint${status.state === 'error' || parsed.invalidTokens.length > 0 ? ' is-warn' : ''}`}
          data-testid="praise-scripture-status"
          role="status"
        >
          {status.state === 'loading'
            ? '개역개정·NASB에서 찾는 중…'
            : status.state === 'error'
              ? status.message
              : parsed.invalidTokens.length > 0
                ? `${parsed.invalidTokens.map((token) => `‘${token}’`).join(', ')}은(는) 구절로 읽지 못했습니다.`
                : passage
                  ? `${passage.rangeKo} · ${passage.rangeEn} — ${passage.verses.length}절, 한 절에 한 장씩 (개역개정 · NASB)`
                  : '구절을 적으면 개역개정과 NASB 본문을 한 절에 한 장씩 넣습니다.'}
        </span>
      </label>
      {passage && (
        <details className="praise-scripture-verses">
          <summary>본문 보기</summary>
          <ol>
            {passage.verses.map((verse) => (
              <li key={verse.refKo}>
                <strong>{verse.refKo}</strong> {verse.ko}
                <br />
                <strong>{verse.refEn}</strong> <span lang="en">{verse.en || '(NASB에 없는 절)'}</span>
              </li>
            ))}
          </ol>
        </details>
      )}
    </div>
  );
}

function TitleEditor({
  slide,
  onChange,
}: {
  slide: Extract<PraisePrayerSlide, { kind: 'title' }>;
  onChange: (slide: PraisePrayerSlide) => void;
}) {
  return (
    <div className="praise-prayer-fields praise-prayer-title-fields">
      <label className="field">
        <span className="field-label">한글</span>
        <input
          type="text"
          value={slide.ko}
          placeholder="기도"
          data-testid="praise-prayer-title-ko"
          onChange={(event) => onChange({ ...slide, ko: event.target.value })}
        />
      </label>
      <label className="field">
        <span className="field-label">English</span>
        <input
          type="text"
          lang="en"
          value={slide.en}
          placeholder="Prayer"
          data-testid="praise-prayer-title-en"
          onChange={(event) => onChange({ ...slide, en: event.target.value })}
        />
      </label>
      <label className="field">
        <span className="field-label">자주 쓰는 제목</span>
        <select
          value=""
          data-testid="praise-prayer-title-preset"
          onChange={(event) => {
            const preset = PRAYER_TITLE_PRESETS[Number(event.target.value)];
            if (preset) onChange({ ...slide, ko: preset.ko, en: preset.en });
          }}
        >
          <option value="">골라서 바꾸기…</option>
          {PRAYER_TITLE_PRESETS.map((preset, index) => (
            <option key={preset.ko} value={index}>
              {preset.ko} / {preset.en}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}

function PrayerCard({
  prayer,
  number,
  where,
  waiting,
  onChange,
  onRemove,
  loadBible,
}: {
  prayer: PraisePrayer;
  number: number;
  where: string;
  waiting: boolean;
  onChange: (update: (prayer: PraisePrayer) => PraisePrayer) => void;
  onRemove: () => void;
  loadBible: BibleLoader;
}) {
  const slideCount = planPrayerSlides(prayer, { prayerId: prayer.id, prayerNumber: number, afterSongId: null }).length;
  const updateSlide = (slideId: string, update: (slide: PraisePrayerSlide) => PraisePrayerSlide) =>
    onChange((current) => ({
      ...current,
      slides: current.slides.map((slide) => (slide.id === slideId ? update(slide) : slide)),
    }));
  const addSlide = (kind: PraisePrayerSlideKind) =>
    onChange((current) => ({ ...current, slides: [...current.slides, createPrayerSlide(kind)] }));

  return (
    <article className="card praise-prayer" data-testid="praise-prayer" id={`praise-prayer-${prayer.id}`}>
      <header className="praise-prayer-head">
        <span className="wednesday-song-index" aria-hidden="true">
          {number}
        </span>
        <div className="praise-prayer-titles">
          <strong className="praise-song-title">기도 {number}</strong>
          <span className={`praise-prayer-where${waiting ? ' is-waiting' : ''}`} data-testid="praise-prayer-where">
            {where}
          </span>
        </div>
        <span className={`praise-song-status${slideCount > 0 ? ' is-done' : ''}`} data-testid="praise-prayer-slide-count">
          슬라이드 {slideCount}장
        </span>
        <button
          type="button"
          className="btn btn-ghost btn-danger"
          data-testid="praise-prayer-remove"
          onClick={onRemove}
        >
          <Icon name="trash" />
          기도 {number} 빼기
        </button>
      </header>

      {prayer.slides.length === 0 ? (
        <p className="empty-hint">슬라이드가 없어 이 기도는 PPT에 아무것도 넣지 않습니다. 아래에서 슬라이드를 더하세요.</p>
      ) : (
        <ol className="praise-prayer-slides">
          {prayer.slides.map((slide, index) => (
            <li
              key={slide.id}
              className={`praise-prayer-slide${isEmptyPrayerSlide(slide) ? ' is-empty' : ''}`}
              data-testid="praise-prayer-slide"
              data-kind={slide.kind}
            >
              <div className="praise-prayer-slide-head">
                <Icon name={slide.kind === 'scripture' ? 'bible' : 'prayer'} />
                <strong>{KIND_LABEL[slide.kind]}</strong>
                <span className="praise-prayer-slide-tools">
                  <button
                    type="button"
                    className="btn btn-ghost btn-icon"
                    aria-label={`${KIND_LABEL[slide.kind]} 위로`}
                    disabled={index === 0}
                    onClick={() => onChange((current) => movePrayerSlide(current, slide.id, -1))}
                  >
                    <Icon name="up" />
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost btn-icon"
                    aria-label={`${KIND_LABEL[slide.kind]} 아래로`}
                    disabled={index === prayer.slides.length - 1}
                    onClick={() => onChange((current) => movePrayerSlide(current, slide.id, 1))}
                  >
                    <Icon name="down" />
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost btn-icon btn-danger"
                    aria-label={`${KIND_LABEL[slide.kind]} 빼기`}
                    data-testid="praise-prayer-slide-remove"
                    onClick={() =>
                      onChange((current) => ({ ...current, slides: current.slides.filter((s) => s.id !== slide.id) }))
                    }
                  >
                    <Icon name="close" />
                  </button>
                </span>
              </div>
              {slide.kind === 'topics' ? (
                <TopicsEditor slide={slide} onChange={(next) => updateSlide(slide.id, () => next)} />
              ) : slide.kind === 'scripture' ? (
                <ScriptureEditor slide={slide} onChange={(update) => updateSlide(slide.id, update)} loadBible={loadBible} />
              ) : (
                <TitleEditor slide={slide} onChange={(next) => updateSlide(slide.id, () => next)} />
              )}
            </li>
          ))}
        </ol>
      )}

      <div className="praise-prayer-add">
        <button type="button" className="btn" data-testid="praise-prayer-add-topics" onClick={() => addSlide('topics')}>
          <Icon name="plus" />
          기도제목
        </button>
        <button type="button" className="btn" data-testid="praise-prayer-add-scripture" onClick={() => addSlide('scripture')}>
          <Icon name="plus" />
          말씀
        </button>
        <button type="button" className="btn" data-testid="praise-prayer-add-title" onClick={() => addSlide('title')}>
          <Icon name="plus" />
          기도 슬라이드
        </button>
      </div>
    </article>
  );
}

export default function PraisePrayerStep({
  songs,
  extras,
  prayers,
  onPrayerAfter,
  onAddPrayer,
  onRemovePrayer,
  onPrayerChange,
  loadBible,
}: Props) {
  const placed = placePrayers(songs, extras, prayers).slice(0, prayers.length);
  const numberBySong = new Map(placed.flatMap((item) => (item.afterSongId ? [[item.afterSongId, item.number]] : [])));
  const waiting = placed.filter((item) => item.afterSongId === null);

  const confirmRemove = (index: number) => {
    const prayer = prayers[index];
    const typed = prayer.slides.some((slide) => !isEmptyPrayerSlide(slide) && slide.kind !== 'title');
    if (typed && !window.confirm(`기도 ${index + 1}에 적은 기도제목·말씀도 함께 지울까요?`)) return;
    onRemovePrayer(index);
  };

  return (
    <div className="praise-prayers">
      <section className="card praise-prayer-plan" data-testid="praise-prayer-plan">
        <div className="praise-prayer-count">
          <span className="field-label" id="praise-prayer-count-label">
            기도 횟수
          </span>
          <div className="praise-prayer-stepper" role="group" aria-labelledby="praise-prayer-count-label">
            <button
              type="button"
              className="btn btn-icon"
              aria-label="기도 하나 빼기"
              data-testid="praise-prayer-count-down"
              disabled={prayers.length === 0}
              onClick={() => confirmRemove(prayers.length - 1)}
            >
              <span aria-hidden="true">−</span>
            </button>
            <output className="praise-prayer-count-value" data-testid="praise-prayer-count" aria-live="polite">
              {prayers.length}번
            </output>
            <button
              type="button"
              className="btn btn-icon"
              aria-label="기도 하나 더하기"
              data-testid="praise-prayer-count-up"
              onClick={onAddPrayer}
            >
              <Icon name="plus" />
            </button>
          </div>
        </div>

        <h3>기도를 넣을 곡</h3>
        <p className="field-hint">
          체크한 곡 뒤에 기도가 순서대로 들어갑니다 — 첫 번째로 체크한 곡 뒤에 기도 1, 두 번째 곡 뒤에 기도 2…
          곡을 체크하면 기도가 하나 늘고, 체크를 풀면 그 곡의 기도가 빠집니다. 곡 뒤에 넣은 추가 자료(설교 등)는
          기도보다 앞에 들어갑니다.
        </p>
        {songs.length === 0 ? (
          <p className="empty-hint" data-testid="praise-prayer-no-songs">
            찬양 단계에서 콘티를 올리면 곡마다 뒤에 기도를 넣을지 고를 수 있습니다.
          </p>
        ) : (
          <ul className="praise-prayer-songs">
            {songs.map((song, index) => {
              const number = numberBySong.get(song.id);
              return (
                <li key={song.id}>
                  <label className="praise-prayer-song" data-testid="praise-prayer-song">
                    <input
                      type="checkbox"
                      checked={Boolean(extras[song.id]?.prayerAfter)}
                      data-testid="praise-prayer-song-toggle"
                      onChange={(event) => onPrayerAfter(song.id, event.target.checked)}
                    />
                    <span className="praise-prayer-song-name">
                      {index + 1}. {song.title.trim() || '(제목 없음)'}
                    </span>
                    {number && <span className="praise-prayer-badge">기도 {number}</span>}
                  </label>
                </li>
              );
            })}
          </ul>
        )}
        {waiting.length > 0 && (
          <p className="banner banner-warn" data-testid="praise-prayer-waiting">
            <Icon name="warning" />
            <span className="banner-text">
              {waiting.map((item) => `기도 ${item.number}`).join(', ')}은(는) 체크한 곡이 모자라 맨 뒤(마지막 곡 다음)에
              들어갑니다. 곡을 더 체크하거나 기도를 빼세요.
            </span>
          </p>
        )}
      </section>

      {placed.map((item, index) => (
        <PrayerCard
          key={item.prayer.id}
          prayer={item.prayer}
          number={item.number}
          where={item.afterSongId ? `${songLabel(songs, item.afterSongId)} 뒤` : '맨 뒤 — 체크한 곡이 모자랍니다'}
          waiting={item.afterSongId === null}
          onChange={(update) => onPrayerChange(item.prayer.id, update)}
          onRemove={() => confirmRemove(index)}
          loadBible={loadBible}
        />
      ))}
    </div>
  );
}
