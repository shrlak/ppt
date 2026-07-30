# 실제 악보 코퍼스

`sources.json`은 공개된 CCM 악보 모음 두 곳의 목록입니다 — 합계 **1,401장**.

| source | 장수 | 출처 |
|---|---:|---|
| `ccm4u` | 1,331 | ccm4u.tistory.com 의 코드별 악보 모음 (C 248 / D 254 / E 217 / F 172 / G 464곡) |
| `naver-dloper` | 70 | blog.naver.com/dloper 「G코드_CCM 느린 찬양 악보 모음」 |

## 이미지는 커밋하지 않습니다

악보 스캔에는 각 출판사의 저작권 표시가 실려 있습니다(예: `Copyright (C) 1986
Kingsway's Thankyou Music. Adm. By CopyCare Korea`). 저장소가 필요한 것은 **같은
페이지를 다시 가져올 수 있는 능력**뿐이므로, 목록만 두고 파일은 받아서 씁니다.

```sh
node bench/corpus/fetch-corpus.mjs                      # 전체 (약 190 MB)
node bench/corpus/fetch-corpus.mjs --limit 50           # 앞 50장만
node bench/corpus/fetch-corpus.mjs --source naver-dloper
node bench/corpus/fetch-corpus.mjs --only 은혜아니면
```

`bench/corpus/pages/` 로 내려받으며, 이 경로는 `.gitignore` 에 있습니다.

## 왜 필요한가

기존 벤치마크는 `public/library.json` 의 가사로 악보를 **합성해서** 그립니다.
구조를 마음대로 만들 수 있어 회귀 테스트에는 좋지만, 실제로 인식해야 하는
페이지 — 손으로 쓴 음표, 스캔 잡티, 낮은 해상도, 출판사마다 다른 가사 배치 —
와는 다릅니다. 이 코퍼스는 그 실제 페이지들입니다.

## 정답(ground truth)

`truth.json` 에 사람이 확인한 곡만 들어갑니다. 형식은 합성 벤치마크의
`manifest.json` 과 같습니다.

```json
{ "file": "ccm4u/D/우리는주의백성이오니주의그큰이름_D.jpg",
  "title": "우리는 주의 백성이오니", "key": "D",
  "order": ["I", "C", "V", "V2", "V3"],
  "sections": [{ "label": "C", "lines": ["우리는 주의 백성이오니", "…"] }] }
```

**`public/library.json` 의 가사를 그대로 정답으로 쓰면 안 됩니다.** 같은 곡이라도
악보마다 표기가 다릅니다 — 예를 들어 위 악보는 「이곳 어두운 세상**에**」로
인쇄돼 있지만 라이브러리 항목은 「세상**에서**」입니다. 정답은 반드시 그 이미지에
인쇄된 대로 적어야 하고, 그래서 `truth.json` 은 확인한 만큼만 자랍니다.

## 벤치마크 돌리기

```sh
node bench/corpus/fetch-corpus.mjs
node bench/corpus/build-manifest.mjs          # truth.json → bench/real/manifest.json
GEMINI_API_KEY=... BENCH_OUT=bench/real npx vite-node bench/run-bench.ts
```
