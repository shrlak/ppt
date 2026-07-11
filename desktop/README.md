# Worship Setlist + Lyrics Slide Generator (desktop)

A local-first desktop app for planning worship setlists, managing a song library,
transposing keys, and generating PowerPoint lyric slides — no cloud backend, no
account, everything stored in a local SQLite file.

Stack: **Tauri 2 + React + TypeScript + Tailwind CSS**, with a Rust backend for
the SQLite store and `.pptx` export.

## Status: Phase 1 (project scaffold + UI layout)

This phase sets up the project and a browsable UI shell for every planned page.
Data is placeholder/in-memory (`src/lib/demoData.ts`); no persistence yet.

- [x] **Phase 1** — Tauri + React + TypeScript project, Tailwind, routed UI layout
- [ ] **Phase 2** — SQLite database + song library CRUD
- [ ] **Phase 3** — Setlist builder (drag & drop, per-song keys, transitions)
- [ ] **Phase 4** — Chord transposition engine
- [ ] **Phase 5** — PowerPoint slide generation (.pptx export)
- [ ] **Phase 6** — Slide theme editor + export preview

## Pages

| Route | Page |
| --- | --- |
| `/` | Dashboard |
| `/songs` | Song Library |
| `/songs/new`, `/songs/:id/edit` | Add/Edit Song |
| `/setlists` | Setlist Builder |
| `/themes` | Slide Theme Editor |
| `/export` | Export Preview |
| `/settings` | Settings |

## Data model

See `src/types.ts` for the full TypeScript model: `Song`, `SongSection`,
`Setlist`, `SetlistItem`, `SlideTheme`. Phase 2 introduces the matching SQLite
schema (`songs`, `song_sections`, `setlists`, `setlist_items`, `slide_themes`).

## Running locally (macOS)

### Prerequisites

1. **Node.js 20+** and npm.
2. **Rust** (via [rustup](https://rustup.rs)): `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh`
3. **Xcode Command Line Tools**: `xcode-select --install`
4. Tauri's macOS system dependencies are covered by the above — no extra system
   packages are required (unlike Linux, which needs webkit2gtk).

### Install & run

```bash
cd desktop
npm install

# Run the desktop app in dev mode (opens a native window, hot-reloads on save)
npm run tauri dev

# Or just the web UI in a browser (faster iteration on layout; Tauri APIs no-op)
npm run dev
```

### Build a distributable app

```bash
npm run tauri build
```

Outputs a signed-for-local-use `.app` / `.dmg` under
`src-tauri/target/release/bundle/`.

### Frontend-only checks (no Rust toolchain required)

```bash
npm run build      # tsc -b && vite build — typechecks and bundles the UI
```

## Project layout

```
desktop/
├── src/                  # React frontend
│   ├── components/       # Layout, Sidebar, shared UI
│   ├── pages/            # One file per route
│   ├── lib/demoData.ts   # Placeholder data (removed in Phase 2)
│   └── types.ts          # Shared TypeScript data model
├── src-tauri/            # Rust backend
│   ├── src/lib.rs        # Tauri commands (IPC) — SQLite + PPTX land here
│   ├── tauri.conf.json   # App window, bundle, dev-server config
│   └── capabilities/     # Tauri v2 permission grants
└── package.json
```
