# Post-End Attachments Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a sixth-step workflow that appends PDF pages, PPTX slides, and PNG/JPEG images after the Back/End deck, preserves those inputs in the shared library, and fixes editor-view gutters and responsive proportions.

**Architecture:** Keep raw uploads in a typed `AdditionalFile[]` model. Convert PDF pages and images into 4:3 image-only PPTX decks in the browser, pass uploaded PPTX files through unchanged, and append every resulting deck after Back/End with the existing merger. Archive all raw uploads and their order in one ZIP-backed library file kind so editing a saved deck reconstructs the exact list.

**Tech Stack:** React 18, TypeScript, Vite, Vitest, Playwright, JSZip, pdfjs-dist, browser Canvas/CreateImageBitmap, OOXML PPTX packages

**Spec:** `docs/superpowers/specs/2026-08-14-post-end-attachments-design.md`

## Global Constraints

- Final order is exactly `Front → 찬양 → 기도 → 말씀 → 설교 → 기도 → 광고 → Back/End → 추가 자료`.
- PDF pages and PNG/JPG/JPEG images use a white 4:3 slide, preserve aspect ratio, and never crop.
- Uploaded PPTX files retain all slides in their original order through `mergePptxDecks()`.
- All conversion stays in the browser; no new conversion server or external upload is introduced.
- The existing 100 MB per-library-entry total and 5000-slide server limit remain in force.
- Older library entries without `additionalFiles` remain readable.
- Production changes follow red-green-refactor: each behavior gets a failing test before implementation.

---

### Task 1: Additional-file model, validation, and ordering

**Files:**
- Create: `src/lib/additionalFiles/types.ts`
- Create: `src/lib/additionalFiles/files.ts`
- Test: `tests/additionalFiles/files.test.ts`

**Interfaces:**
- Produces: `AdditionalFileKind`, `AdditionalFile`, `SUPPORTED_ADDITIONAL_ACCEPT`, `detectAdditionalFileKind(name, bytes)`, `moveAdditionalFile(items, id, delta)`
- `AdditionalFile` fields: `{ id: string; name: string; kind: 'pdf' | 'pptx' | 'png' | 'jpeg'; data: ArrayBuffer; slideCount: number }`

- [ ] **Step 1: Write failing format and ordering tests**

```ts
import { describe, expect, it } from 'vitest';
import { detectAdditionalFileKind, moveAdditionalFile } from '../../src/lib/additionalFiles/files';

it('recognizes supported formats from signatures instead of extensions alone', () => {
  expect(detectAdditionalFileKind('pages.bin', new Uint8Array([0x25, 0x50, 0x44, 0x46]))).toBe('pdf');
  expect(detectAdditionalFileKind('photo.bin', new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe('png');
  expect(detectAdditionalFileKind('photo.bin', new Uint8Array([0xff, 0xd8, 0xff]))).toBe('jpeg');
  expect(detectAdditionalFileKind('deck.pptx', new Uint8Array([0x50, 0x4b, 0x03, 0x04]))).toBe('pptx');
});

it('rejects an extension whose bytes have the wrong signature', () => {
  expect(() => detectAdditionalFileKind('fake.pdf', new Uint8Array([1, 2, 3]))).toThrow('지원하지 않거나 손상된 파일');
});

it('moves one item by one slot without mutating the input', () => {
  const items = [
    { id: 'a', name: 'a.png' },
    { id: 'b', name: 'b.png' },
    { id: 'c', name: 'c.png' },
  ] as never[];
  expect(moveAdditionalFile(items, 'b', -1).map((item) => item.id)).toEqual(['b', 'a', 'c']);
  expect(items.map((item) => item.id)).toEqual(['a', 'b', 'c']);
});
```

- [ ] **Step 2: Run the test and verify RED**

Run: `npm test -- tests/additionalFiles/files.test.ts`

Expected: FAIL because `src/lib/additionalFiles/files.ts` does not exist.

- [ ] **Step 3: Implement minimal typed validation and movement**

```ts
export type AdditionalFileKind = 'pdf' | 'pptx' | 'png' | 'jpeg';

export interface AdditionalFile {
  id: string;
  name: string;
  kind: AdditionalFileKind;
  data: ArrayBuffer;
  slideCount: number;
}

export const SUPPORTED_ADDITIONAL_ACCEPT = '.pdf,.pptx,.png,.jpg,.jpeg';
```

Implement fixed signature checks for `%PDF`, ZIP/PPTX, PNG, and JPEG. For PPTX, require both ZIP signature and `.pptx` extension here; Task 3 performs package validation with `inspectDeckBytes()`.

- [ ] **Step 4: Run tests and verify GREEN**

Run: `npm test -- tests/additionalFiles/files.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/additionalFiles/types.ts src/lib/additionalFiles/files.ts tests/additionalFiles/files.test.ts
git commit -m "feat: model ordered additional files"
```

---

### Task 2: Image-only PPTX builder

**Files:**
- Create: `src/lib/pptx/imageDeckBuilder.ts`
- Test: `tests/pptx/imageDeckBuilder.test.ts`
- Use: `public/template.pptx`

**Interfaces:**
- Consumes: a 4:3 template deck and `ImageSlideSource[]`
- Produces: `buildImageDeck(template, images): Promise<Uint8Array>` and `containRect(imageWidth, imageHeight, slideWidth?, slideHeight?)`
- `ImageSlideSource`: `{ data: Uint8Array; mimeType: 'image/png' | 'image/jpeg'; width: number; height: number }`

- [ ] **Step 1: Write failing package and geometry tests**

```ts
it('centers a portrait image without cropping on a 4:3 slide', () => {
  expect(containRect(1000, 2000)).toEqual({ x: 3429000, y: 0, cx: 2286000, cy: 6858000 });
});

it('creates one valid slide and media relationship per image', async () => {
  const result = await buildImageDeck(template, [
    { data: png1x1, mimeType: 'image/png', width: 1, height: 1 },
    { data: jpeg1x1, mimeType: 'image/jpeg', width: 1, height: 1 },
  ]);
  const zip = await JSZip.loadAsync(result);
  expect(Object.keys(zip.files).filter((path) => /^ppt\/slides\/slide\d+\.xml$/.test(path))).toHaveLength(2);
  expect(Object.keys(zip.files).filter((path) => /^ppt\/media\/additional-image-\d+\.(png|jpg)$/.test(path))).toHaveLength(2);
  await expect(assertPptxIntegrity(result)).resolves.toBeUndefined();
});
```

- [ ] **Step 2: Run the tests and verify RED**

Run: `npm test -- tests/pptx/imageDeckBuilder.test.ts`

Expected: FAIL because the builder exports are missing.

- [ ] **Step 3: Implement template cloning and image relationships**

Use `extractSlideSubset(template, images.map(() => 2))` to obtain one template-derived slide per image. For each numbered slide:

```ts
const picture = `<p:pic><p:nvPicPr><p:cNvPr id="${1000 + index}" name="추가 자료 ${index + 1}"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="${imageRid}"/><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill></p:spPr></p:pic>`;
```

Preserve the required `p:nvGrpSpPr` and `p:grpSpPr` nodes, remove existing visible shapes from `p:spTree`, append the picture, add an image relationship in that slide's `.rels`, add media bytes, and ensure PNG/JPEG content types. Reject empty image arrays and zero/invalid dimensions.

- [ ] **Step 4: Run package tests and verify GREEN**

Run: `npm test -- tests/pptx/imageDeckBuilder.test.ts tests/pptx/pptxPackage.test.ts`

Expected: PASS with no broken relationships.

- [ ] **Step 5: Commit**

```bash
git add src/lib/pptx/imageDeckBuilder.ts tests/pptx/imageDeckBuilder.test.ts
git commit -m "feat: build image-only attachment decks"
```

---

### Task 3: Browser conversion and slide-count inspection

**Files:**
- Create: `src/lib/additionalFiles/convert.ts`
- Test: `tests/additionalFiles/convert.test.ts`
- Modify: `src/lib/utils/contiPdf.ts`

**Interfaces:**
- Consumes: `AdditionalFile`, 4:3 template bytes
- Produces: `inspectAdditionalUpload(file): Promise<AdditionalFile>`, `convertAdditionalFile(file, template): Promise<{ deck: Uint8Array; slideCount: number }>`
- Reuse a shared PDF loader configuration exported from `contiPdf.ts` so pdf.js worker and asset URLs are configured once.

- [ ] **Step 1: Write failing PPTX pass-through and invalid-package tests**

```ts
it('passes a valid PPTX through and reports its real slide count', async () => {
  const file = await inspectAdditionalUpload(new File([frontSlides], 'extra.pptx'));
  expect(file.kind).toBe('pptx');
  expect(file.slideCount).toBe(4);
  const converted = await convertAdditionalFile(file, template);
  expect(converted.slideCount).toBe(4);
  expect(converted.deck).toEqual(new Uint8Array(frontSlides));
});

it('rejects a ZIP that is not a presentation', async () => {
  const zip = new JSZip();
  zip.file('hello.txt', 'no slides');
  await expect(inspectAdditionalUpload(new File([await zip.generateAsync({ type: 'uint8array' })], 'fake.pptx'))).rejects.toThrow('fake.pptx');
});
```

- [ ] **Step 2: Run the tests and verify RED**

Run: `npm test -- tests/additionalFiles/convert.test.ts`

Expected: FAIL because conversion functions do not exist.

- [ ] **Step 3: Implement upload inspection and conversion**

For PPTX, call `inspectDeckBytes()` during upload. For images, decode through `createImageBitmap(new Blob(...))`, capture post-EXIF dimensions, and close the bitmap. For PDF, load a private byte copy through pdf.js, record `numPages`, then on conversion render each page to a white canvas at up to 1600px wide and encode PNG bytes.

```ts
export async function convertAdditionalFile(file: AdditionalFile, template: ArrayBuffer) {
  if (file.kind === 'pptx') return { deck: new Uint8Array(file.data), slideCount: file.slideCount };
  const images = file.kind === 'pdf' ? await renderPdfImages(file.data) : [await decodeImage(file)];
  return { deck: await buildImageDeck(template, images), slideCount: images.length };
}
```

Always destroy PDF loading tasks and close bitmaps. Prefix conversion errors with the original file name.

- [ ] **Step 4: Run tests and verify GREEN**

Run: `npm test -- tests/additionalFiles/convert.test.ts tests/pptx/imageDeckBuilder.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/additionalFiles/convert.ts src/lib/utils/contiPdf.ts tests/additionalFiles/convert.test.ts
git commit -m "feat: convert additional uploads into slide decks"
```

---

### Task 4: Additional-files archive and shared library transport

**Files:**
- Create: `src/lib/storage/additionalFilesArchive.ts`
- Test: `tests/storage/additionalFilesArchive.test.ts`
- Modify: `src/lib/storage/deckFileKinds.ts`
- Modify: `src/lib/storage/pptLibrary.ts`
- Modify: `worker/src/library.js`
- Modify: `tests/storage/pptLibraryPurge.test.ts`
- Modify: `tests/storage/cloudLibraryWorker.test.ts`

**Interfaces:**
- Consumes: `AdditionalFile[]`
- Produces: `encodeAdditionalFiles(files): Promise<SavedFile | null>`, `decodeAdditionalFiles(file): Promise<AdditionalFile[]>`
- Adds nullable `additionalFiles` to `SavedDeck`, `SavedDeckSummary`, remote metadata, and `SavedDeckInput`.
- Adds `'additionalFiles'` to both `SAVED_FILE_KINDS` and Worker `PPT_FILE_KINDS`.

- [ ] **Step 1: Write failing archive round-trip and compatibility tests**

```ts
it('round-trips names, kinds, bytes, counts, and order', async () => {
  const encoded = await encodeAdditionalFiles([pdfFile, imageFile]);
  expect(encoded?.name).toBe('additional-files.zip');
  const decoded = await decodeAdditionalFiles(encoded!);
  expect(decoded.map(({ name, kind, slideCount }) => ({ name, kind, slideCount }))).toEqual([
    { name: 'pages.pdf', kind: 'pdf', slideCount: 2 },
    { name: 'photo.png', kind: 'png', slideCount: 1 },
  ]);
  expect(new Uint8Array(decoded[0].data)).toEqual(new Uint8Array(pdfFile.data));
});

it('returns an empty archive only as null', async () => {
  await expect(encodeAdditionalFiles([])).resolves.toBeNull();
});

it('keeps browser and worker file-kind declarations identical', () => {
  expect([...PPT_FILE_KINDS]).toEqual([...SAVED_FILE_KINDS]);
  expect(PPT_FILE_KINDS).toContain('additionalFiles');
});
```

- [ ] **Step 2: Run storage tests and verify RED**

Run: `npm test -- tests/storage/additionalFilesArchive.test.ts tests/storage/pptLibraryPurge.test.ts tests/storage/cloudLibraryWorker.test.ts`

Expected: FAIL because the archive module and new file kind are missing.

- [ ] **Step 3: Implement versioned ZIP archive**

Write `manifest.json` version 1 with ordered entries `{ path, name, kind, slideCount }`; store bytes at `files/0000`, `files/0001`, etc. Decode only exact version 1, validate every path/name/kind/count, require every referenced ZIP member, and mint fresh UUIDs. Throw `추가 자료 보관 파일이 손상되었습니다.` for any partial/corrupt archive.

- [ ] **Step 4: Extend client and Worker file metadata**

Add `additionalFiles` to descriptors, upload/download batches, local normalization, summary conversion, sanitization, route regexes, and total-byte accounting. Missing metadata from old entries normalizes to `null`.

- [ ] **Step 5: Run storage tests and verify GREEN**

Run: `npm test -- tests/storage/additionalFilesArchive.test.ts tests/storage/pptLibraryPurge.test.ts tests/storage/cloudLibraryWorker.test.ts tests/storage/deckAutoSave.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/storage/additionalFilesArchive.ts src/lib/storage/deckFileKinds.ts src/lib/storage/pptLibrary.ts worker/src/library.js tests/storage/additionalFilesArchive.test.ts tests/storage/pptLibraryPurge.test.ts tests/storage/cloudLibraryWorker.test.ts
git commit -m "feat: preserve additional files in the shared library"
```

---

### Task 5: Additional-files page component

**Files:**
- Create: `src/components/AdditionalFilesSection.tsx`
- Modify: `src/components/Icon.tsx`
- Modify: `src/styles.css`
- Test: `e2e/app.spec.ts`

**Interfaces:**
- Props: `{ value: AdditionalFile[]; onChange(files: AdditionalFile[]): void }`
- Uses: `SUPPORTED_ADDITIONAL_ACCEPT`, `inspectAdditionalUpload()`, `moveAdditionalFile()`
- Exposes: root `data-testid="additional-files-section"`, input `additional-files-input`, rows `additional-file-row`, move controls, and delete controls.

- [ ] **Step 1: Write a failing E2E test for the sixth-step navigation and list controls**

```ts
test('adds and orders files on the new 추가 자료 page', async ({ page }) => {
  await page.getByTestId('wizard-tab-additional').click();
  await expect(page.getByTestId('additional-files-section')).toBeVisible();
  await page.getByTestId('additional-files-input').setInputFiles([
    { name: 'first.png', mimeType: 'image/png', buffer: PNG_1X1 },
    { name: 'second.jpg', mimeType: 'image/jpeg', buffer: JPEG_1X1 },
  ]);
  const rows = page.getByTestId('additional-file-row');
  await expect(rows).toHaveCount(2);
  await rows.nth(1).getByTestId('additional-file-up').click();
  await expect(rows.nth(0)).toContainText('second.jpg');
  await rows.nth(0).getByTestId('additional-file-delete').click();
  await expect(rows).toHaveCount(1);
});
```

- [ ] **Step 2: Run the E2E test and verify RED**

Run: `npm run build && npm run test:e2e -- -g "adds and orders files"`

Expected: FAIL because the `additional` wizard tab does not exist.

- [ ] **Step 3: Implement the accessible uploader and ordered list**

Use one hidden `multiple` file input wrapped by the existing dropzone visual pattern. Process selected files sequentially so selected order is deterministic. Show `파일명 · 형식 · N장`, disable only the item being inspected, and use labeled buttons `위로 이동`, `아래로 이동`, `삭제` with disabled boundary controls.

- [ ] **Step 4: Run the E2E test and verify GREEN**

Run: `npm run build && npm run test:e2e -- -g "adds and orders files"`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/AdditionalFilesSection.tsx src/components/Icon.tsx src/styles.css e2e/app.spec.ts
git commit -m "feat: add the additional-files wizard page"
```

---

### Task 6: App merge, overview, auto-save, and restore integration

**Files:**
- Modify: `src/App.tsx`
- Modify: `src/lib/utils/deckOverview.ts`
- Modify: `src/components/SlideOverviewList.tsx`
- Modify: `src/lib/storage/deckAutoSave.ts`
- Modify: `tests/storage/deckAutoSave.test.ts`
- Modify: `tests/serviceDeck.test.ts`
- Modify: `e2e/app.spec.ts`

**Interfaces:**
- Consumes: Tasks 1–5 APIs.
- Adds overview kind `'additional'` and callback `onSelectAdditional()`.
- Adds `additionalFiles: AutoSaveFile[]` to `AutoSaveInputs` fingerprinting in exact list order.

- [ ] **Step 1: Write failing fingerprint and final-order tests**

```ts
it('changes when additional-file order changes', () => {
  const first = deckFingerprint({ ...baseInputs, additionalFiles: [fileA, fileB] });
  const second = deckFingerprint({ ...baseInputs, additionalFiles: [fileB, fileA] });
  expect(first).not.toBe(second);
});
```

Extend the service-deck integration fixture to append an image deck and a PPTX deck, then assert the first additional slide index equals `backStart + backCount`, and the uploaded PPTX's marker text occurs after the image relationship slide.

- [ ] **Step 2: Run targeted tests and verify RED**

Run: `npm test -- tests/storage/deckAutoSave.test.ts tests/serviceDeck.test.ts`

Expected: FAIL because fingerprint inputs and post-Back merging are absent.

- [ ] **Step 3: Add sixth step and merge after Back/End**

Add `additionalFiles` state and include it in `hasAnyContent`, fingerprint, estimated count, editor regeneration dependencies, download, and save. Insert `AdditionalFilesSection` as step 5 and move download to step 6. In `buildMergedDeck()`, merge Back with STORE when extra files exist, convert and merge each additional file in order, use DEFLATE only for the final additional merge, and add one overview row per actual slide.

- [ ] **Step 4: Archive and restore additional files**

Set `additionalFiles: await encodeAdditionalFiles(additionalFiles)` in `writeToLibrary()`. Make `openSavedDeck()` async, decode `deck.additionalFiles`, restore the list, and show a warning while preserving other restored inputs if archive decoding fails.

- [ ] **Step 5: Add editor navigation and E2E final-order coverage**

Add `scrollToAdditional()`, make `additional` overview rows clickable, and verify in E2E that those rows occur after every `back` row. Download the deck and inspect presentation order with JSZip, asserting an additional media relationship or known PPTX marker appears only after the bundled Back slides.

- [ ] **Step 6: Run targeted tests and verify GREEN**

Run: `npm test -- tests/storage/deckAutoSave.test.ts tests/serviceDeck.test.ts && npm run build && npm run test:e2e -- -g "additional|editor view"`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/App.tsx src/lib/utils/deckOverview.ts src/components/SlideOverviewList.tsx src/lib/storage/deckAutoSave.ts tests/storage/deckAutoSave.test.ts tests/serviceDeck.test.ts e2e/app.spec.ts
git commit -m "feat: append additional files after end slides"
```

---

### Task 7: Editor gutters and responsive proportions

**Files:**
- Modify: `src/styles.css`
- Modify: `e2e/app.spec.ts`

**Interfaces:**
- Produces CSS token `--page-gutter` shared by `.app` and `.header-inner`.
- Editor grid contract: two columns at 1200px and above; one column at 1160px and below; no horizontal overflow.

- [ ] **Step 1: Write a failing viewport layout test**

```ts
test('editor gutters stay aligned and the narrow editor stacks before squeezing', async ({ page }) => {
  await page.getByTestId('view-mode-toggle').click();
  for (const width of [900, 901, 1024, 1160, 1200, 1280, 1440, 1920]) {
    await page.setViewportSize({ width, height: 900 });
    const layout = await page.evaluate(() => {
      const app = document.querySelector('.app')!.getBoundingClientRect();
      const header = document.querySelector('.header-inner')!.getBoundingClientRect();
      const main = document.querySelector('.app-body > main')!.getBoundingClientRect();
      return { appLeft: app.left, appRight: app.right, headerLeft: header.left, headerRight: header.right, mainWidth: main.width, scrollWidth: document.documentElement.scrollWidth, viewport: innerWidth };
    });
    expect(layout.appLeft).toBeCloseTo(layout.headerLeft, 0);
    expect(layout.appRight).toBeCloseTo(layout.headerRight, 0);
    expect(layout.scrollWidth).toBe(layout.viewport);
    if (width <= 1160) expect(layout.mainWidth).toBeGreaterThan(width - 80);
  }
});
```

- [ ] **Step 2: Run the E2E test and verify RED**

Run: `npm run build && npm run test:e2e -- -g "editor gutters"`

Expected: FAIL at 901px because the main editor collapses to about 509px.

- [ ] **Step 3: Implement the shared gutter and earlier breakpoint**

```css
:root {
  --page-gutter: clamp(16px, 3vw, 32px);
}
.app,
.header-inner {
  width: 100%;
  padding-left: var(--page-gutter);
  padding-right: var(--page-gutter);
}
.app-editor-mode .app-body {
  grid-template-columns: minmax(280px, 312px) minmax(0, 1fr);
}
.app-editor-mode .app-body > main {
  min-width: 0;
}
@media (max-width: 1160px) {
  .app-editor-mode .app-body { grid-template-columns: minmax(0, 1fr); }
  .slide-overview { position: static; max-height: 320px; }
}
```

Keep the shared maximum width token for editor header and body so their painted edges match.

- [ ] **Step 4: Run the E2E test and verify GREEN**

Run: `npm run build && npm run test:e2e -- -g "editor gutters"`

Expected: PASS at all listed widths.

- [ ] **Step 5: Commit**

```bash
git add src/styles.css e2e/app.spec.ts
git commit -m "fix: balance editor gutters and responsive layout"
```

---

### Task 8: Documentation and full verification

**Files:**
- Modify: `README.md`
- Verify: all changed source and test files

**Interfaces:**
- No new runtime interfaces.

- [ ] **Step 1: Update product documentation**

Change every five-step reference to six steps, document the `추가 자료` page, list PDF/PPTX/PNG/JPG/JPEG behavior, show additional files after Back slides in every order diagram, and include the archived additional-file ZIP in the library description.

- [ ] **Step 2: Run formatting and TypeScript/build verification**

Run: `git diff --check && npm run build`

Expected: zero whitespace errors and a successful TypeScript/Vite build.

- [ ] **Step 3: Run the complete unit/integration suite**

Run: `npm test`

Expected: all Vitest suites pass with no unhandled rejection.

- [ ] **Step 4: Run the complete browser suite**

Run: `npm run test:e2e`

Expected: all Playwright tests pass.

- [ ] **Step 5: Inspect final generated PPTX and working tree**

Generate one deck containing PDF, PPTX, PNG, and JPEG attachments. Confirm `assertPptxIntegrity()` passes, slide count equals slide IDs, additional slides begin immediately after the final Back slide, and `git status --short` contains only intentional files.

- [ ] **Step 6: Commit**

```bash
git add README.md
git commit -m "docs: explain post-end additional files"
```
