// One step of a 수련회 session's 예배 순서, and its editor.
import { useState } from 'react';
import Icon from '../components/Icon';
import type { RetreatPassage } from './scripture';
import { lyricSlides } from './songs';
import { BLOCK_LABELS, type RetreatBlock, type RetreatSong } from './types';

interface Props {
  block: RetreatBlock;
  index: number;
  total: number;
  /** Resolved verses for a scripture block; undefined while loading, null when unreadable. */
  passage?: RetreatPassage | null;
  passageError?: string;
  songTitles: string[];
  onChange: (block: RetreatBlock) => void;
  onMove: (delta: -1 | 1) => void;
  onRemove: () => void;
  /** Look a title up in last year's decks and the 찬양 라이브러리. */
  resolveSong: (title: string) => RetreatSong;
}

const SOURCE_LABEL: Record<NonNullable<RetreatSong['source']>, string> = {
  retreat: '작년 수련회 가사',
  library: '찬양 라이브러리',
  manual: '직접 입력',
};

function SongRow({
  song,
  index,
  total,
  onChange,
  onMove,
  onRemove,
  resolveSong,
}: {
  song: RetreatSong;
  index: number;
  total: number;
  onChange: (song: RetreatSong) => void;
  onMove: (delta: -1 | 1) => void;
  onRemove: () => void;
  resolveSong: (title: string) => RetreatSong;
}) {
  const slides = lyricSlides(song.lyrics).length;
  return (
    <li className="retreat-song" data-testid="retreat-song">
      <div className="retreat-song-head">
        <span className="wednesday-song-index" aria-hidden="true">
          {index + 1}
        </span>
        <input
          type="text"
          className="retreat-input"
          aria-label={`${index + 1}번째 곡 제목`}
          value={song.title}
          data-testid="retreat-song-title"
          onChange={(event) => onChange({ ...song, title: event.target.value })}
          onBlur={(event) => {
            // A title typed onto a song with no lyrics yet fills them in.
            if (song.lyrics.trim() || !event.target.value.trim()) return;
            const found = resolveSong(event.target.value.trim());
            if (found.lyrics) onChange({ ...song, lyrics: found.lyrics, source: found.source });
          }}
        />
        <span className={`retreat-song-source${song.lyrics.trim() ? '' : ' is-missing'}`} data-testid="retreat-song-source">
          {song.lyrics.trim() ? `${SOURCE_LABEL[song.source ?? 'manual']} · ${slides}장` : '가사 없음'}
        </span>
        <div className="retreat-row-actions">
          <button type="button" className="btn btn-icon" aria-label="위로" disabled={index === 0} onClick={() => onMove(-1)}>
            <Icon name="up" />
          </button>
          <button
            type="button"
            className="btn btn-icon"
            aria-label="아래로"
            disabled={index === total - 1}
            onClick={() => onMove(1)}
          >
            <Icon name="down" />
          </button>
          <button type="button" className="btn btn-icon" aria-label={`${song.title} 빼기`} onClick={onRemove}>
            <Icon name="close" />
          </button>
        </div>
      </div>
      <textarea
        className="retreat-textarea"
        rows={Math.min(14, Math.max(3, song.lyrics.split('\n').length))}
        aria-label={`${song.title || `${index + 1}번째 곡`} 가사`}
        placeholder={'가사를 한 줄씩 입력하세요.\n빈 줄 = 다음 슬라이드 (한 장에 4줄까지)'}
        value={song.lyrics}
        data-testid="retreat-song-lyrics"
        onChange={(event) => onChange({ ...song, lyrics: event.target.value, source: 'manual' })}
      />
    </li>
  );
}

export default function RetreatBlockEditor({
  block,
  index,
  total,
  passage,
  passageError,
  songTitles,
  onChange,
  onMove,
  onRemove,
  resolveSong,
}: Props) {
  const [newSong, setNewSong] = useState('');

  const addSong = () => {
    if (block.kind !== 'songs' || !newSong.trim()) return;
    onChange({ ...block, songs: [...block.songs, resolveSong(newSong.trim())] });
    setNewSong('');
  };

  const heading = block.kind === 'songs' ? block.label || '찬양' : BLOCK_LABELS[block.kind];

  return (
    <li className="card retreat-block" data-testid="retreat-block" data-kind={block.kind}>
      <header className="retreat-block-head">
        <span className="retreat-block-kind">{index + 1}</span>
        <strong>{heading}</strong>
        {block.kind === 'songs' && <span className="retreat-block-meta">{block.songs.length}곡</span>}
        <div className="retreat-row-actions">
          <button type="button" className="btn btn-icon" aria-label="순서 위로" disabled={index === 0} onClick={() => onMove(-1)}>
            <Icon name="up" />
          </button>
          <button
            type="button"
            className="btn btn-icon"
            aria-label="순서 아래로"
            disabled={index === total - 1}
            onClick={() => onMove(1)}
          >
            <Icon name="down" />
          </button>
          <button type="button" className="btn btn-icon" aria-label={`${heading} 순서 빼기`} onClick={onRemove}>
            <Icon name="trash" />
          </button>
        </div>
      </header>

      {block.kind === 'title' && <p className="field-hint">수련회 이름과 부제가 들어간 제목 슬라이드입니다 (수련회 정보에서 바꿉니다).</p>}
      {block.kind === 'blank' && <p className="field-hint">검은 빈 화면 한 장 — 설교 슬라이드를 따로 띄울 때 씁니다.</p>}

      {block.kind === 'songs' && (
        <>
          <label className="field">
            <span className="field-label">구분 장 제목</span>
            <input
              type="text"
              className="retreat-input"
              value={block.label}
              placeholder="찬양 / 기도회 / 찬양집회 (비우면 구분 장 없음)"
              onChange={(event) => onChange({ ...block, label: event.target.value })}
            />
          </label>
          <ol className="retreat-songs">
            {block.songs.map((song, songIndex) => (
              <SongRow
                key={song.id}
                song={song}
                index={songIndex}
                total={block.songs.length}
                resolveSong={resolveSong}
                onChange={(next) =>
                  onChange({ ...block, songs: block.songs.map((candidate) => (candidate.id === song.id ? next : candidate)) })
                }
                onMove={(delta) => {
                  const songs = [...block.songs];
                  const target = songIndex + delta;
                  [songs[songIndex], songs[target]] = [songs[target], songs[songIndex]];
                  onChange({ ...block, songs });
                }}
                onRemove={() => onChange({ ...block, songs: block.songs.filter((candidate) => candidate.id !== song.id) })}
              />
            ))}
          </ol>
          <div className="retreat-add-song">
            <input
              type="text"
              className="retreat-input"
              list="retreat-song-titles"
              value={newSong}
              placeholder="곡 제목 (작년 수련회·찬양 라이브러리 곡은 가사가 자동으로 채워집니다)"
              aria-label="추가할 곡 제목"
              data-testid="retreat-add-song-input"
              onChange={(event) => setNewSong(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  addSong();
                }
              }}
            />
            <datalist id="retreat-song-titles">
              {songTitles.map((title) => (
                <option key={title} value={title} />
              ))}
            </datalist>
            <button type="button" className="btn" disabled={!newSong.trim()} data-testid="retreat-add-song" onClick={addSong}>
              <Icon name="plus" />곡 추가
            </button>
          </div>
        </>
      )}

      {block.kind === 'scripture' && (
        <label className="field">
          <span className="field-label">본문 (개역개정 + ESV)</span>
          <input
            type="text"
            className="retreat-input"
            value={block.passage}
            placeholder="예: 마14:22-33 또는 마태복음 14장 22-33절"
            data-testid="retreat-passage"
            onChange={(event) => onChange({ ...block, passage: event.target.value })}
          />
          <span className="field-hint" data-testid="retreat-passage-hint">
            {!block.passage.trim()
              ? '비워 두면 설교말씀 슬라이드가 들어가지 않습니다.'
              : passageError
                ? passageError
                : passage === undefined
                  ? '본문을 불러오는 중…'
                  : passage
                    ? `${passage.passageKo} · ${passage.passageEn} · 말씀 ${passage.verses.length}장`
                    : '읽을 수 없는 본문입니다.'}
          </span>
        </label>
      )}

      {block.kind === 'sermon' && (
        <label className="field">
          <span className="field-label">설교 제목</span>
          <input
            type="text"
            className="retreat-input"
            value={block.title}
            placeholder="예: Go Beyond the Visible"
            data-testid="retreat-sermon-title"
            onChange={(event) => onChange({ ...block, title: event.target.value })}
          />
        </label>
      )}

      {(block.kind === 'prayer' || block.kind === 'benediction') && (
        <label className="field">
          <span className="field-label">슬라이드 글자</span>
          <input
            type="text"
            className="retreat-input"
            value={block.label}
            onChange={(event) => onChange({ ...block, label: event.target.value })}
          />
        </label>
      )}

      {block.kind === 'announcements' && (
        <>
          <label className="field">
            <span className="field-label">구분 장 글자</span>
            <input
              type="text"
              className="retreat-input"
              value={block.label}
              onChange={(event) => onChange({ ...block, label: event.target.value })}
            />
          </label>
          <label className="field">
            <span className="field-label">광고 내용</span>
            <textarea
              className="retreat-textarea"
              rows={6}
              value={block.text}
              placeholder={'1. <환영합니다>\n수련회 책자 p. 33 참고\n2. <일정 미리보기>\n12PM 점심식사'}
              data-testid="retreat-announcements"
              onChange={(event) => onChange({ ...block, text: event.target.value })}
            />
            <span className="field-hint">번호를 붙인 항목마다 광고 슬라이드가 한 장씩 만들어집니다.</span>
          </label>
        </>
      )}
    </li>
  );
}
