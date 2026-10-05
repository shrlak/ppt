// The poster: the 찬양집회 deck's very first slide, ahead of the 표지.
//
// Everything on it is edited here — a picture (this year's flyer, or a photo
// to write on), the words, and the colours — next to a preview drawn from
// the same layout the slide is built from (posterLayout), so what is shown
// is where the download puts it. The slide itself is an ordinary picture and
// text box, so it can be changed again in PowerPoint.
import { useEffect, useMemo, type CSSProperties } from 'react';
import Icon from '../components/Icon';
import { showToast } from '../lib/utils/toast';
import { PRAISE_SLIDE_SIZE } from './template';
import { POSTER_FONTS, posterHasContent, posterLayout, type PosterRect } from './poster';
import { DEFAULT_POSTER_BACKGROUND, type PraisePoster, type PraisePosterImage } from './types';

interface Props {
  poster: PraisePoster;
  onChange: (poster: PraisePoster) => void;
}

/** Width, height and the colour at its edge (the slide's background around it) of an uploaded picture. */
async function readPosterImage(file: File): Promise<{ image: PraisePosterImage; edge: string }> {
  const mimeType = file.type === 'image/png' ? 'image/png' : file.type === 'image/jpeg' ? 'image/jpeg' : null;
  if (!mimeType) throw new Error('포스터는 PNG나 JPG 이미지만 쓸 수 있습니다.');
  const data = await file.arrayBuffer();
  const bitmap = await createImageBitmap(new Blob([data], { type: mimeType }));
  try {
    let edge = DEFAULT_POSTER_BACKGROUND;
    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    const context = canvas.getContext('2d');
    if (context) {
      context.drawImage(bitmap, 2, 2, 1, 1, 0, 0, 1, 1);
      const [r, g, b] = context.getImageData(0, 0, 1, 1).data;
      edge = [r, g, b].map((value) => value.toString(16).padStart(2, '0')).join('').toUpperCase();
    }
    return { image: { name: file.name, mimeType, data, width: bitmap.width, height: bitmap.height }, edge };
  } finally {
    bitmap.close();
  }
}

/** EMU on the slide as a share of its width or height, for the preview's CSS. */
function percentOf(rect: PosterRect): CSSProperties {
  return {
    left: `${(rect.x / PRAISE_SLIDE_SIZE.cx) * 100}%`,
    top: `${(rect.y / PRAISE_SLIDE_SIZE.cy) * 100}%`,
    width: `${(rect.cx / PRAISE_SLIDE_SIZE.cx) * 100}%`,
    height: `${(rect.cy / PRAISE_SLIDE_SIZE.cy) * 100}%`,
  };
}

/** 1/100 pt on a slide 720pt wide, as a share of the preview's width. */
function pointsAsWidth(hundredths: number): string {
  return `${hundredths / 720}cqw`;
}

function PosterPreview({ poster }: { poster: PraisePoster }) {
  const layout = posterLayout(poster);
  const image = poster.image;
  const url = useMemo(() => (image ? URL.createObjectURL(new Blob([image.data], { type: image.mimeType })) : null), [image]);
  useEffect(() => () => {
    if (url) URL.revokeObjectURL(url);
  }, [url]);
  const empty = !posterHasContent(poster);
  return (
    <div
      className="praise-poster-preview"
      style={{ background: `#${layout.background}` }}
      role="img"
      aria-label="포스터 슬라이드 미리보기"
      data-testid="praise-poster-preview"
    >
      {layout.picture && url && <img className="praise-poster-preview-picture" style={percentOf(layout.picture)} src={url} alt="" />}
      {layout.text && (
        <div
          className={`praise-poster-preview-text${layout.text.shadow ? ' has-shadow' : ''}`}
          style={{ ...percentOf(layout.text.box), color: `#${layout.text.color}` }}
        >
          {layout.text.paragraphs.map((paragraph, index) => (
            <p
              key={index}
              data-role={paragraph.role}
              style={{
                fontSize: pointsAsWidth(paragraph.sz),
                marginTop: pointsAsWidth(paragraph.spaceBefore),
                fontWeight: paragraph.role === 'title' ? 800 : POSTER_FONTS[paragraph.role].bold ? 700 : 400,
              }}
            >
              {paragraph.text}
            </p>
          ))}
        </div>
      )}
      {empty && <span className="praise-poster-preview-empty">이미지를 올리거나 문구를 적어 주세요</span>}
    </div>
  );
}

export default function PraisePosterCard({ poster, onChange }: Props) {
  const set = (patch: Partial<PraisePoster>) => onChange({ ...poster, ...patch });

  async function pickImage(file: File | undefined) {
    if (!file) return;
    try {
      const { image, edge } = await readPosterImage(file);
      // The picture's own edge colour fills the slide around it, so a
      // portrait flyer on the 4:3 slide looks like one piece; 배경색 can
      // still change it afterwards.
      onChange({ ...poster, enabled: true, image, background: edge });
    } catch (error) {
      showToast(error instanceof Error ? error.message : '이미지를 읽지 못했습니다.', 'error');
    }
  }

  const inDeck = poster.enabled && posterHasContent(poster);

  return (
    <section className="card praise-poster" data-testid="praise-poster">
      <div className="praise-poster-head">
        <div>
          <h3>포스터 슬라이드</h3>
          <p className="field-hint">
            넣으면 PPT의 <strong>맨 첫 장</strong>(표지 앞)에 들어갑니다. PowerPoint에서도 그림과 글상자를 그대로 옮기고
            고칠 수 있습니다.
          </p>
        </div>
        <label className="praise-prayer-toggle praise-poster-toggle">
          <input
            type="checkbox"
            checked={poster.enabled}
            data-testid="praise-poster-enabled"
            onChange={(event) => set({ enabled: event.target.checked })}
          />
          맨 첫 장에 포스터 넣기
        </label>
      </div>

      {poster.enabled && (
        <div className="praise-poster-body">
          <PosterPreview poster={poster} />

          <div className="praise-poster-fields">
            <div className="field">
              <span className="field-label">포스터 이미지</span>
              <div className="praise-cover-actions">
                <label className="btn">
                  <Icon name="upload" />
                  {poster.image ? '다른 이미지로 바꾸기' : '포스터 이미지 올리기'}
                  <input
                    type="file"
                    accept="image/png,image/jpeg"
                    className="visually-hidden"
                    data-testid="praise-poster-input"
                    onChange={(event) => {
                      void pickImage(event.target.files?.[0]);
                      event.target.value = '';
                    }}
                  />
                </label>
                {poster.image && (
                  <button type="button" className="btn btn-ghost" data-testid="praise-poster-remove-image" onClick={() => set({ image: null })}>
                    <Icon name="trash" />
                    이미지 빼기
                  </button>
                )}
              </div>
              <span className="field-hint">
                {poster.image
                  ? `${poster.image.name} (${poster.image.width}×${poster.image.height})`
                  : '완성된 포스터 그림을 올리거나, 배경 사진 위에 아래 문구를 얹을 수 있습니다. 이미지 없이 문구만 써도 됩니다.'}
              </span>
            </div>

            {poster.image && (
              <fieldset className="praise-poster-fit">
                <legend className="field-label">이미지 맞춤</legend>
                <label>
                  <input
                    type="radio"
                    name="praise-poster-fit"
                    checked={poster.fit === 'contain'}
                    data-testid="praise-poster-fit-contain"
                    onChange={() => set({ fit: 'contain' })}
                  />
                  전체 보이기 (남는 곳은 배경색)
                </label>
                <label>
                  <input
                    type="radio"
                    name="praise-poster-fit"
                    checked={poster.fit === 'cover'}
                    data-testid="praise-poster-fit-cover"
                    onChange={() => set({ fit: 'cover' })}
                  />
                  화면 채우기 (가장자리는 잘림)
                </label>
              </fieldset>
            )}

            <label className="field">
              <span className="field-label">제목</span>
              <input
                type="text"
                value={poster.title}
                placeholder="예: EM & KM Praise Night"
                data-testid="praise-poster-title"
                onChange={(event) => set({ title: event.target.value })}
              />
            </label>
            <label className="field">
              <span className="field-label">부제</span>
              <input
                type="text"
                value={poster.subtitle}
                placeholder="예: 집회 주제나 주제 말씀"
                data-testid="praise-poster-subtitle"
                onChange={(event) => set({ subtitle: event.target.value })}
              />
            </label>
            <label className="field">
              <span className="field-label">안내 (한 줄에 하나씩)</span>
              <textarea
                rows={3}
                value={poster.details}
                placeholder={'예: 2026년 9월 26일 (토) 오후 7시\nKorean Central Church of Pittsburgh'}
                data-testid="praise-poster-details"
                onChange={(event) => set({ details: event.target.value })}
              />
            </label>

            <div className="praise-poster-colors">
              <label className="field">
                <span className="field-label">배경색</span>
                <input
                  type="color"
                  value={`#${poster.background}`}
                  data-testid="praise-poster-background"
                  onChange={(event) => set({ background: event.target.value.slice(1).toUpperCase() })}
                />
              </label>
              <label className="field">
                <span className="field-label">글자색</span>
                <input
                  type="color"
                  value={`#${poster.textColor}`}
                  data-testid="praise-poster-text-color"
                  onChange={(event) => set({ textColor: event.target.value.slice(1).toUpperCase() })}
                />
              </label>
            </div>
            <p className="field-hint">
              제목·부제·안내는 각각 한 줄에 들어가는 크기로 맞추고, 비워 둔 줄은 넣지 않습니다.
            </p>
          </div>
        </div>
      )}

      {poster.enabled && !inDeck && (
        <p className="banner banner-notice praise-poster-note" data-testid="praise-poster-empty">
          <Icon name="info" />
          <span className="banner-text">포스터가 비어 있어 아직 넣지 않습니다. 이미지를 올리거나 문구를 적으면 맨 첫 장에 들어갑니다.</span>
        </p>
      )}
    </section>
  );
}
