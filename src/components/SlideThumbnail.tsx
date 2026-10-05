// Renders one RenderedSlide (from pptxRenderer.ts) as a scaled visual
// thumbnail — the exact shapes/text/images the real download will contain,
// not a text summary. Shows an empty placeholder while a slide at this
// index hasn't been rendered yet (deck still (re)generating).
import type { CSSProperties } from 'react';
import { emuToPx, ptToPx, type RenderedShape, type RenderedSlide } from '../lib/pptx/pptxRenderer';

interface Props {
  slide: RenderedSlide | undefined;
  width: number;
}

const FALLBACK_ASPECT = 16 / 9;
const DEFAULT_FONT_PT = 18;

export default function SlideThumbnail({ slide, width }: Props) {
  if (!slide) {
    return (
      <div
        className="slide-thumb slide-thumb-empty"
        style={{ width, height: width / FALLBACK_ASPECT }}
        aria-hidden="true"
      />
    );
  }

  const pxPerEmu = width / slide.widthEmu;
  const height = slide.heightEmu * pxPerEmu;

  return (
    <div
      className="slide-thumb"
      style={{
        width,
        height,
        background: slide.background ?? '#ffffff',
        ...(slide.backgroundImage
          ? { backgroundImage: `url("${slide.backgroundImage}")`, backgroundSize: '100% 100%' }
          : {}),
      }}
    >
      {slide.shapes.map((shape, i) => (
        <ShapeView key={i} shape={shape} pxPerEmu={pxPerEmu} />
      ))}
    </div>
  );
}

function ShapeView({ shape, pxPerEmu }: { shape: RenderedShape; pxPerEmu: number }) {
  const style: CSSProperties = {
    left: emuToPx(shape.xEmu, pxPerEmu),
    top: emuToPx(shape.yEmu, pxPerEmu),
    width: emuToPx(shape.wEmu, pxPerEmu),
    height: emuToPx(shape.hEmu, pxPerEmu),
  };

  if (shape.kind === 'picture') {
    return <img className="slide-thumb-picture" style={style} src={shape.imageUrl} alt="" />;
  }

  return (
    <div
      className="slide-thumb-text"
      style={{
        ...style,
        // A box that names its anchor is drawn from it; one that does not keeps
        // the old centred look.
        justifyContent: shape.anchor === 't' ? 'flex-start' : shape.anchor === 'b' ? 'flex-end' : undefined,
        background: shape.fill,
        ...(shape.outline
          ? {
              border: `${Math.max(1, emuToPx(shape.outline.widthEmu, pxPerEmu))}px solid ${shape.outline.color}`,
              boxSizing: 'border-box',
            }
          : {}),
      }}
    >
      {shape.paragraphs.map((p, pi) => (
        <p
          key={pi}
          className={`slide-thumb-paragraph${shape.noWrap ? ' is-single-line' : ''}`}
          style={{
            textAlign: p.align === 'ctr' ? 'center' : p.align === 'r' ? 'right' : 'left',
            // Its lines are spaced by its own largest run, as on the slide —
            // not by the page's font, which would push small text apart and
            // out of its box.
            fontSize: ptToPx(Math.max(0, ...p.runs.map((r) => r.sizePt ?? DEFAULT_FONT_PT)) || DEFAULT_FONT_PT, pxPerEmu),
          }}
        >
          {p.runs.map((r, ri) => (
            <span
              key={ri}
              className="slide-thumb-run"
              style={{
                fontSize: ptToPx(r.sizePt ?? DEFAULT_FONT_PT, pxPerEmu),
                fontWeight: r.bold ? 700 : undefined,
                fontStyle: r.italic ? 'italic' : undefined,
                color: r.color,
                // The exact font may not be installed in the viewer's browser (no
                // font files ship with the deck); naming it still gets a closer
                // system-font match than the browser's generic default, and a
                // sans-serif fallback keeps it from silently reverting to serif.
                fontFamily: r.fontFamily ? `"${r.fontFamily}", sans-serif` : undefined,
              }}
            >
              {r.text}
            </span>
          ))}
        </p>
      ))}
    </div>
  );
}
