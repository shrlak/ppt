import PageHeader from '../components/PageHeader';
import { DEFAULT_THEME } from '../types';

/** Phase 1: static preview of the default theme; editing + saving lands in Phase 6. */
export default function ThemeEditor() {
  const theme = DEFAULT_THEME;
  return (
    <>
      <PageHeader
        title="Slide Themes"
        description="Customize background, colors, fonts, and layout. Editing and saving reusable themes arrives in Phase 6."
      />
      <div className="grid grid-cols-2 gap-6">
        <div className="space-y-4 rounded-xl border border-slate-200 bg-white p-6 text-sm">
          <h3 className="font-semibold">{theme.name}</h3>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <span className="text-slate-500">Background</span>
              <div className="mt-1 flex items-center gap-2">
                <span
                  className="h-5 w-5 rounded border border-slate-300"
                  style={{ backgroundColor: theme.backgroundColor }}
                />
                {theme.backgroundColor}
              </div>
            </div>
            <div>
              <span className="text-slate-500">Text</span>
              <div className="mt-1 flex items-center gap-2">
                <span
                  className="h-5 w-5 rounded border border-slate-300"
                  style={{ backgroundColor: theme.textColor }}
                />
                {theme.textColor}
              </div>
            </div>
            <div>
              <span className="text-slate-500">Font</span>
              <div className="mt-1">{theme.fontFamily} · {theme.fontSize}pt</div>
            </div>
            <div>
              <span className="text-slate-500">Aspect ratio</span>
              <div className="mt-1">{theme.aspectRatio}</div>
            </div>
            <div>
              <span className="text-slate-500">Title position</span>
              <div className="mt-1">{theme.titlePosition}</div>
            </div>
            <div>
              <span className="text-slate-500">Lyrics alignment</span>
              <div className="mt-1">{theme.lyricsAlign}</div>
            </div>
          </div>
        </div>
        <div>
          <div
            className="flex aspect-video flex-col rounded-xl border border-slate-300 p-4 shadow-sm"
            style={{ backgroundColor: theme.backgroundColor, color: theme.textColor }}
          >
            <div className="text-left text-xs opacity-70">주님의 사랑</div>
            <div
              className="flex flex-1 flex-col items-center justify-center gap-1 font-semibold"
              style={{ textAlign: theme.lyricsAlign }}
            >
              <div>눈부신 햇살</div>
              <div>저 하늘 너머 내게 주어진</div>
            </div>
          </div>
          <p className="mt-2 text-center text-xs text-slate-400">Live slide preview</p>
        </div>
      </div>
    </>
  );
}
