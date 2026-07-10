# 찬양 가사 슬라이드 생성기

찬양 콘티 PDF를 업로드하면 파트별 가사 슬라이드 PPTX를 자동으로 생성하는 웹 앱입니다.

배포 주소: <https://shrlak.github.io/lyrics/>

## 기능

- **콘티 표지 자동 인식** — 날짜, 설교 제목, 곡 목록과 키(Key)를 표지에서 자동으로 읽어옵니다.
- **파트별 가사 관리** — V/PC/C/B/I 파트 구분, 파트 순서 지정, `x2` 반복 표기를 지원합니다.
- **곡 라이브러리** — 입력한 곡을 저장하고 다음 콘티에서 재사용할 수 있습니다. 라이브러리에 있는 곡은 업로드 직후 가사가 자동으로 채워집니다.
- **악보 페이지 미리보기** — 스캔된 악보 페이지를 보면서 가사를 입력할 수 있습니다.
- **템플릿 기반 PPT 생성** — 지정된 템플릿 서식 그대로 슬라이드를 만들어 `.pptx`로 다운로드합니다.

## 사용 방법

1. **콘티 PDF 업로드** — 표지에서 날짜·설교 제목·곡 목록을 자동으로 인식하고, 라이브러리에 있는 곡은 가사가 미리 채워집니다.
2. **가사 확인·편집** — 곡별로 파트 가사와 순서를 확인하고 필요하면 수정합니다. 곡 추가나 라이브러리에서 불러오기도 가능합니다.
3. **PPTX 생성** — 파일명을 확인하고 생성 버튼을 누르면 슬라이드 PPTX가 다운로드됩니다.

## 순서 토큰 참고표

| 토큰 | 의미 |
| --- | --- |
| `V` / `V1` / `V2` | 절 (Verse) |
| `PC` | 프리코러스 (Pre-Chorus) |
| `C` | 후렴 (Chorus) |
| `B` | 브릿지 (Bridge) |
| `I` | 간주 — 곡 제목 슬라이드 표시 |
| `Cx2` | 해당 파트 반복 (후렴 2번) |

## 로컬 개발

```bash
npm install
npm run dev          # 개발 서버
npm test             # 단위 테스트 (vitest)
npm run build        # 프로덕션 빌드 (tsc + vite)

# E2E 테스트: 먼저 빌드한 뒤 실행 (preview 서버가 빌드 결과물을 서빙)
npm run build && CHROMIUM_PATH=/opt/pw-browsers/chromium npm run test:e2e
```

CI(GitHub Actions)에서는 `CHROMIUM_PATH` 없이 `npx playwright install --with-deps chromium`으로 설치된 브라우저를 사용합니다.

## 배포

GitHub Actions로 GitHub Pages에 자동 배포됩니다.

- 저장소 **Settings → Pages → Source**를 **"GitHub Actions"** 로 설정해야 합니다.
- 기본 브랜치(default branch)에 push될 때마다 테스트 통과 후 자동으로 배포됩니다.

## 참고

- 슬라이드 템플릿: `public/template.pptx` (교체 가능)
- 기본 곡 라이브러리: `public/library.json` (교체 가능)

---

## English Summary

A web app that turns a praise set-list (conti) PDF into per-section lyric slides as a PPTX file. It auto-detects the date, sermon title, song list, and keys from the cover page, pre-fills lyrics from a bundled song library, supports section tokens (V/PC/C/B/I, `x2` repeats) for slide ordering, and generates slides from a PPTX template (`public/template.pptx`). Built with Vite + React + TypeScript; deployed to GitHub Pages via GitHub Actions (set repo Settings → Pages → Source to "GitHub Actions"). Local dev: `npm install && npm run dev`; e2e tests: `npm run build && CHROMIUM_PATH=/opt/pw-browsers/chromium npm run test:e2e`.
