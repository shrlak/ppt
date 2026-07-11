# KCCP PPT Generator

찬양 가사와 성경 말씀 슬라이드를 자동으로 만들어 주는 웹 앱입니다. 두 가지 생성기를 하나의
사이트에서 탭으로 전환하며 사용합니다.

배포 주소: <https://shrlak.github.io/lyrics/>

## 🎵 찬양 가사 생성기

찬양 콘티 PDF를 업로드하면 파트별 가사 슬라이드 PPTX를 자동으로 생성합니다.

- **콘티 표지 자동 인식** — 날짜, 설교 제목, 곡 목록과 키(Key)를 표지에서 자동으로 읽어옵니다.
- **파트별 가사 관리** — V/PC/C/B/I 파트 구분과 파트 순서 지정을 지원합니다. 실제 예배에서는 절·후렴이 여러 번 반복되므로, 슬라이드는 콘티 순서를 그대로 펼치지 않고 **각 파트를 최소 1장씩만** 생성합니다 (반복은 진행자가 화면에서 되돌아가며 사용). 슬라이드 순서는 콘티에 처음 등장하는 파트 순서를 따릅니다.
- **곡 라이브러리** — 입력한 곡을 저장하고 다음 콘티에서 재사용할 수 있습니다. 라이브러리에 있는 곡은 업로드 직후 가사가 자동으로 채워집니다.
- **악보 페이지 미리보기** — 스캔된 악보 페이지를 보면서 가사를 입력할 수 있습니다.
- **템플릿 기반 PPT 생성** — 지정된 템플릿 서식 그대로 슬라이드를 만들어 `.pptx`로 다운로드합니다.

사용 방법:

1. **콘티 PDF 업로드** — 표지에서 날짜·설교 제목·곡 목록을 자동으로 인식하고, 라이브러리에 있는 곡은 가사가 미리 채워집니다.
2. **가사 확인·편집** — 곡별로 파트 가사와 순서를 확인하고 필요하면 수정합니다. 곡 추가나 라이브러리에서 불러오기도 가능합니다.
3. **PPTX 생성** — 파일명을 확인하고 생성 버튼을 누르면 슬라이드 PPTX가 다운로드됩니다.

순서 토큰 참고표:

| 토큰 | 의미 |
| --- | --- |
| `V` / `V1` / `V2` | 절 (Verse) |
| `PC` | 프리코러스 (Pre-Chorus) |
| `C` | 후렴 (Chorus) |
| `B` | 브릿지 (Bridge) |
| `I` | 간주 — 곡 제목 슬라이드 표시 |

`Cx2`처럼 순서에 반복이 있어도 해당 파트 슬라이드는 한 번만 생성됩니다. `기도`처럼 알 수 없는 토큰은 무시됩니다.

## 📖 성경 말씀 생성기

성경 구절을 입력하면 말씀 슬라이드 PPTX를 자동으로 생성합니다
([edcho1012/kccp-bible-slide](https://github.com/edcho1012/kccp-bible-slide)를 이식했습니다).

- **구절 입력** — `행1:8-10 요3:16 롬8:28` 처럼 여러 구절을 공백으로 구분해 입력합니다. 입력하는
  즉시 인식된 구절 목록을 미리 보여줍니다.
- **번역본** — 한국어(개역개정·개역한글·새번역)와 영어(ESV·NIV·KJV) 중 최대 2개를 함께 표시할 수
  있습니다.
- **설교 제목** — 선택 입력. 비워두면 해당 자리에 빈칸으로 표시됩니다.
- **슬라이드당 절 수** — 한 슬라이드에 몇 절씩 담을지 지정합니다.
- **템플릿** — 기본 템플릿(`public/bible-template.pptx`)을 사용하거나 `.pptx` 템플릿을 업로드해
  이번 세션에서만 사용할 수 있습니다 (브라우저에만 저장되며 서버에 업로드되지 않습니다).
- 템플릿 안의 `{{BODY}}`가 들어있는 슬라이드가 매 구절마다 반복되는 "본문 슬라이드"로 사용되고,
  나머지 슬라이드(표지·설교 등)는 `{{RANGE_KO}}`, `{{SERMON_TITLE}}` 등의 플레이스홀더가 한 번만
  채워집니다.

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

- **최초 1회 설정**: 저장소 **Settings → Pages → Source**를 **"GitHub Actions"** 로 설정해야
  합니다. 이 설정 전에는 CI의 `Deploy to GitHub Pages` 잡이 시작 단계에서 거부되어
  실패합니다 (빌드·테스트 잡은 정상 동작).
- 설정 후 Actions 탭에서 실패한 워크플로를 **Re-run** 하거나 아무 커밋이나 push하면
  배포됩니다. 배포 주소: `https://<계정>.github.io/lyrics/`
- 기본 브랜치(default branch)에 push될 때마다 테스트 통과 후 자동으로 배포됩니다.
- 배포가 계속 거부되면 **Settings → Environments → github-pages → Deployment branches**에서
  기본 브랜치가 허용되어 있는지 확인하세요.

## 참고

- 찬양 슬라이드 템플릿: `public/template.pptx` (교체 가능)
- 기본 곡 라이브러리: `public/library.json` (교체 가능)
- 성경 슬라이드 템플릿: `public/bible-template.pptx` (교체 가능, 앱에서 세션별 업로드도 지원)
- 성경 본문 데이터: `public/bible-text/*.json` (번역본별 전체 본문, 실제 사용 시에만 지연 로드)
- 데스크톱 앱(별도 프로젝트): `desktop/` — Tauri 기반 예배 셋리스트 관리 앱, 자세한 내용은
  `desktop/README.md` 참고

---

## English Summary

**KCCP PPT Generator** combines two slide generators behind a single tabbed UI:

1. **Lyrics generator** — turns a weekly praise set-list (콘티) PDF into per-section lyric
   slides as a PPTX. Auto-detects date, sermon title, song list, and keys from the cover page,
   pre-fills lyrics from a bundled song library, supports section tokens (V/PC/C/B/I) for slide
   ordering — each part is generated only once, in its first-appearance order, regardless of
   repeats in the conti order — and generates slides from a PPTX template (`public/template.pptx`).
2. **Bible verse slide generator** (ported from
   [edcho1012/kccp-bible-slide](https://github.com/edcho1012/kccp-bible-slide)) — turns free-text
   verse references (`행1:8-10 요3:16`) into verse slides in up to two translations, substituting
   `{{PLACEHOLDER}}` tokens directly in a PPTX template (`public/bible-template.pptx`), with an
   optional per-session custom template upload.

Both run entirely client-side (no backend) — built with Vite + React + TypeScript, deployed to
GitHub Pages via GitHub Actions (set repo Settings → Pages → Source to "GitHub Actions"). Local
dev: `npm install && npm run dev`; e2e tests: `npm run build && CHROMIUM_PATH=/opt/pw-browsers/chromium npm run test:e2e`.

A separate local-first desktop app (Tauri + React) for worship setlist planning lives in `desktop/`.
