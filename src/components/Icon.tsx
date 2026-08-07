// The product's single icon family. One set, one geometry (24×24 grid,
// 1.75 stroke, round caps and joins), drawn in `currentColor` so an icon
// always matches the label it sits next to.
//
// Emoji are not icons: they render as a different typeface per platform,
// carry their own colour, ignore stroke weight, and are announced as words
// by screen readers. Every icon here is decorative — the button or label
// beside it carries the accessible name — so each one is aria-hidden.

export type IconName =
  | 'editor'
  | 'steps'
  | 'library'
  | 'usage'
  | 'settings'
  | 'download'
  | 'file-down'
  | 'save'
  | 'upload'
  | 'file'
  | 'search'
  | 'close'
  | 'trash'
  | 'up'
  | 'down'
  | 'next'
  | 'back'
  | 'plus'
  | 'check'
  | 'warning'
  | 'error'
  | 'info'
  | 'refresh'
  | 'edit'
  | 'music'
  | 'lyrics'
  | 'prayer'
  | 'bible'
  | 'sermon'
  | 'divider'
  | 'announcement'
  | 'slide';

const PATHS: Record<IconName, string[]> = {
  editor: ['M3 5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z', 'M9 3v18'],
  steps: ['M10 6h11', 'M10 12h11', 'M10 18h11', 'M4 6h1v4', 'M4 10h2', 'M6 18H4c0-1 2-2 2-3s-1-1.5-2-1'],
  library: ['M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H19a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1H6.5a1 1 0 0 1 0-5H20'],
  usage: ['M3 3v16a2 2 0 0 0 2 2h16', 'M18 17V9', 'M13 17V5', 'M8 17v-3'],
  settings: [
    'M20 7h-9',
    'M14 17H5',
    'M17 20a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
    'M7 10a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  ],
  download: ['M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4', 'm7 10 5 5 5-5', 'M12 15V3'],
  'file-down': [
    'M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7z',
    'M14 2v4a2 2 0 0 0 2 2h4',
    'M12 18v-6',
    'm9 15 3 3 3-3',
  ],
  save: [
    'M15.2 3a2 2 0 0 1 1.4.6l3.8 3.8a2 2 0 0 1 .6 1.4V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z',
    'M17 21v-7a1 1 0 0 0-1-1H8a1 1 0 0 0-1 1v7',
    'M7 3v4a1 1 0 0 0 1 1h7',
  ],
  upload: ['M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4', 'm17 8-5-5-5 5', 'M12 3v12'],
  file: [
    'M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7z',
    'M14 2v4a2 2 0 0 0 2 2h4',
    'M10 9H8',
    'M16 13H8',
    'M16 17H8',
  ],
  search: ['M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16z', 'm21 21-4.3-4.3'],
  close: ['M18 6 6 18', 'm6 6 12 12'],
  trash: [
    'M3 6h18',
    'M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6',
    'M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2',
    'M10 11v6',
    'M14 11v6',
  ],
  up: ['m5 12 7-7 7 7', 'M12 19V5'],
  down: ['M12 5v14', 'm19 12-7 7-7-7'],
  next: ['M5 12h14', 'm12 5 7 7-7 7'],
  back: ['M19 12H5', 'm12 19-7-7 7-7'],
  plus: ['M5 12h14', 'M12 5v14'],
  check: ['M20 6 9 17l-5-5'],
  warning: ['m21.7 18-8-14a2 2 0 0 0-3.4 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.7-3', 'M12 9v4', 'M12 17h.01'],
  error: ['M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z', 'M12 8v4', 'M12 16h.01'],
  info: ['M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z', 'M12 16v-4', 'M12 8h.01'],
  refresh: [
    'M3 12a9 9 0 0 1 9-9 9.7 9.7 0 0 1 6.7 2.7L21 8',
    'M21 3v5h-5',
    'M21 12a9 9 0 0 1-9 9 9.7 9.7 0 0 1-6.7-2.7L3 16',
    'M8 16H3v5',
  ],
  edit: [
    'M21.2 6.8a1 1 0 0 0-4-4L3.8 16.2a2 2 0 0 0-.5.8l-1.3 4.4a.5.5 0 0 0 .6.6l4.4-1.3a2 2 0 0 0 .8-.5z',
    'm15 5 4 4',
  ],
  music: ['M9 18V5l12-2v13', 'M6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6z', 'M18 19a3 3 0 1 0 0-6 3 3 0 0 0 0 6z'],
  lyrics: ['M21 6H3', 'M15 12H3', 'M17 18H3'],
  prayer: [
    'M19 14c1.5-1.5 3-3.2 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.8 0-3 .5-4.5 2-1.5-1.5-2.7-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4 3 5.5l7 7z',
  ],
  bible: [
    'M12 7v14',
    'M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z',
  ],
  sermon: ['M12 19v3', 'M19 10v2a7 7 0 0 1-14 0v-2', 'M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z'],
  divider: ['m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z'],
  announcement: ['m3 11 18-5v12L3 14z', 'M11.6 16.8a3 3 0 1 1-5.8-1.6'],
  slide: [
    'M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z',
    'M9 11a2 2 0 1 0 0-4 2 2 0 0 0 0 4z',
    'm21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21',
  ],
};

interface Props {
  name: IconName;
  /** Renders at 1.5em instead of the default 1.125em. */
  large?: boolean;
  className?: string;
}

export default function Icon({ name, large, className }: Props) {
  return (
    <svg
      className={`icon${large ? ' icon-lg' : ''}${className ? ` ${className}` : ''}`}
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
    >
      {PATHS[name].map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}
