// Merges two standalone .pptx decks into one file: `addition`'s slides are
// appended after `base`'s slides. Each deck keeps its own slide layouts,
// slide master, theme, and media (renamed to avoid collisions) so both
// render exactly as they did standalone — this lets the lyrics generator and
// the Bible-verse generator use their own templates yet produce one combined
// download. Notes masters/slides are dropped (cosmetic only, not shown to
// the congregation).
import JSZip from 'jszip';
import { repairContentTypes, stripNonVisualParts } from './pptxPackage';
import {
  ensureDefaultExtension,
  parseContentTypes,
  partNameKey,
  setContentTypeOverride,
} from './contentTypes';

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

interface LoadedPkg {
  zip: JSZip;
  presentationXml: string;
  presentationRels: string;
}

async function loadPkg(data: ArrayBuffer | Uint8Array): Promise<LoadedPkg> {
  const zip = await JSZip.loadAsync(data);
  await stripNonVisualParts(zip);
  const presentationXml = await zip.file('ppt/presentation.xml')!.async('string');
  const presentationRels = await zip.file('ppt/_rels/presentation.xml.rels')!.async('string');
  return { zip, presentationXml, presentationRels };
}

function maxNumberIn(text: string, re: RegExp): number {
  let max = 0;
  for (const m of text.matchAll(re)) {
    const n = parseInt(m[1], 10);
    if (n > max) max = n;
  }
  return max;
}

function resolveRelTarget(relsXml: string, rId: string): string | null {
  for (const match of relsXml.matchAll(/<Relationship\b[^>]*\/>/g)) {
    if (xmlAttr(match[0], 'Id') === rId) return xmlAttr(match[0], 'Target');
  }
  return null;
}

function normalizePartPath(path: string): string {
  const pieces: string[] = [];
  for (const piece of path.split('/')) {
    if (!piece || piece === '.') continue;
    if (piece === '..') pieces.pop();
    else pieces.push(piece);
  }
  return pieces.join('/');
}

/** Resolve a relationship target owned by ppt/presentation.xml. */
function presentationTargetPath(target: string | null): string | null {
  if (!target) return null;
  const xmlDecoded = target
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .split(/[?#]/, 1)[0];
  let decoded = xmlDecoded;
  try {
    decoded = decodeURIComponent(xmlDecoded);
  } catch {
    // Keep the literal path when a producer wrote an invalid percent escape.
  }
  return normalizePartPath(decoded.startsWith('/') ? decoded.slice(1) : `ppt/${decoded}`);
}

function xmlAttr(tag: string, name: string): string | null {
  return tag.match(new RegExp(`\\s${escapeRegExp(name)}="([^"]*)"`))?.[1] ?? null;
}

function setXmlAttr(tag: string, name: string, value: string): string {
  const re = new RegExp(`(\\s)${escapeRegExp(name)}="[^"]*"`);
  return re.test(tag) ? tag.replace(re, `$1${name}="${value}"`) : tag;
}

/**
 * Slide-master and slide-layout ids share one presentation-wide id space.
 * Standalone decks commonly start that sequence over, so copying their
 * masters verbatim creates collisions that desktop PowerPoint repairs.
 * These ids are not relationship keys; masters and layouts resolve through
 * r:id, so assigning one fresh sequence is safe and preserves visuals.
 */
async function normalizeSlideMasterAndLayoutIds(
  zip: JSZip,
  presentationXml: string,
  presentationRels: string,
): Promise<string> {
  const masterPaths: Array<string | null> = [];
  const seen = new Set<string>();
  for (const match of presentationXml.matchAll(/<p:sldMasterId\b[^>]*>/g)) {
    const rId = xmlAttr(match[0], 'r:id');
    const target = rId ? resolveRelTarget(presentationRels, rId) : null;
    const path = presentationTargetPath(target);
    if (path && /^ppt\/slideMasters\/[^/]+\.xml$/.test(path)) {
      masterPaths.push(path);
      seen.add(path);
    } else masterPaths.push(null);
  }

  const unreferencedMasterPaths: string[] = [];
  for (const path of Object.keys(zip.files).sort()) {
    if (/^ppt\/slideMasters\/[^/]+\.xml$/.test(path) && !seen.has(path)) unreferencedMasterPaths.push(path);
  }

  let nextId = 2147483648;
  const masterIds: string[] = [];
  for (const path of masterPaths) {
    masterIds.push(String(nextId++));
    if (!path) continue;
    const file = zip.file(path);
    if (!file) continue;
    const xml = await file.async('string');
    const normalized = xml.replace(/<p:sldLayoutId\b[^>]*>/g, (tag) =>
      setXmlAttr(tag, 'id', String(nextId++)),
    );
    if (normalized !== xml) zip.file(path, normalized);
  }

  // A valid presentation should not contain unreferenced masters, but keeping
  // their layout ids out of the used range makes the normalizer defensive and
  // lets the package validator report the actual relationship problem.
  for (const path of unreferencedMasterPaths) {
    const file = zip.file(path);
    if (!file) continue;
    const xml = await file.async('string');
    const normalized = xml.replace(/<p:sldLayoutId\b[^>]*>/g, (tag) =>
      setXmlAttr(tag, 'id', String(nextId++)),
    );
    if (normalized !== xml) zip.file(path, normalized);
  }

  let masterIndex = 0;
  return presentationXml.replace(/<p:sldMasterId\b[^>]*>/g, (tag) =>
    setXmlAttr(tag, 'id', masterIds[masterIndex++] ?? String(nextId++)),
  );
}

const SUPPORT_DIRS = [
  'slideLayouts',
  'slideMasters',
  'theme',
  'media',
  'fonts',
  'charts',
  'embeddings',
  'diagrams',
  'activeX',
  'ctrlProps',
  'ink',
  'models',
  'oleObjects',
];

/**
 * Splice `<p:sldId>` entries into the presentation's slide list at `insertAt`
 * (0-based position among the existing entries); appended when it is omitted,
 * and clamped when it points past either end.
 */
function insertSlideIds(presentationXml: string, sldIds: string[], insertAt?: number): string {
  if (sldIds.length === 0) return presentationXml;
  if (insertAt === undefined) {
    return presentationXml.replace('</p:sldIdLst>', `${sldIds.join('')}</p:sldIdLst>`);
  }
  const section = presentationXml.match(/<p:sldIdLst>([\s\S]*?)<\/p:sldIdLst>/);
  if (!section) throw new Error('프레젠테이션에서 슬라이드 목록을 찾지 못했습니다.');
  const existing = [...section[1].matchAll(/<p:sldId\b[^>]*\/>|<p:sldId\b[\s\S]*?<\/p:sldId>/g)].map(
    (match) => match[0],
  );
  const at = Math.max(0, Math.min(insertAt, existing.length));
  const ordered = [...existing.slice(0, at), ...sldIds, ...existing.slice(at)];
  return presentationXml.replace(
    /<p:sldIdLst>[\s\S]*?<\/p:sldIdLst>/,
    `<p:sldIdLst>${ordered.join('')}</p:sldIdLst>`,
  );
}

export interface MergeOptions {
  /**
   * How the *result* is packed. A full deck download chains many of these
   * calls, each re-zipping the whole (growing) package — 'STORE' on the
   * intermediate calls skips the DEFLATE work until the final one, which is
   * the only output actually written to disk.
   */
  compression?: 'STORE' | 'DEFLATE';
  /**
   * Where the addition's slides land in the result, as a 0-based index into
   * the base deck's slide order. Omitted (the default) appends them at the
   * end. The 수요예배 deck uses this to drop each song's slides in right
   * after that song's title slide.
   */
  insertAt?: number;
}

/**
 * Merge two standalone .pptx decks: `addition`'s slides are spliced into
 * `base` — appended at the end, or at `options.insertAt`. Everything
 * `addition`'s slides depend on (layouts, master, theme, media) is copied in
 * under a unique "merged-" prefix so it can't collide with `base`'s own parts.
 *
 * The third argument accepts either the compression mode on its own or the
 * full options object.
 */
export async function mergePptxDecks(
  base: ArrayBuffer | Uint8Array,
  addition: ArrayBuffer | Uint8Array,
  options: 'STORE' | 'DEFLATE' | MergeOptions = 'DEFLATE',
): Promise<Uint8Array> {
  const merge: MergeOptions = typeof options === 'string' ? { compression: options } : options;
  const compression = merge.compression ?? 'DEFLATE';
  const insertAt = merge.insertAt;
  const baseP = await loadPkg(base);
  const addP = await loadPkg(addition);
  const suffix = Math.random().toString(36).slice(2, 8);

  let contentTypes = await baseP.zip.file('[Content_Types].xml')!.async('string');
  let presentation = baseP.presentationXml;
  let presRels = baseP.presentationRels;

  const baseSlideFiles = Object.keys(baseP.zip.files).filter((f) => /^ppt\/slides\/slide\d+\.xml$/.test(f));
  const baseMaxSlideNum = Math.max(0, ...baseSlideFiles.map((f) => parseInt(f.match(/\d+/)![0], 10)));

  let nextRid = maxNumberIn(presRels, /rId(\d+)/g) + 1;
  let nextSlideId = maxNumberIn(presentation, /<p:sldId id="(\d+)"/g) + 1;
  // Google Slides exports use a distinct (huge) id range for slide masters;
  // keep new master ids in that same range so they can't collide with slide ids.
  const masterSection = presentation.match(/<p:sldMasterIdLst>([\s\S]*?)<\/p:sldMasterIdLst>/);
  let nextMasterId = Math.max(2147483647, maxNumberIn(masterSection?.[1] ?? '', /id="(\d+)"/g)) + 1;
  let nextSlideNum = baseMaxSlideNum + 1;

  // ---- Rename addition's layouts/master/theme/media/fonts to avoid collisions ----
  const renameMap = new Map<string, string>(); // full path -> full path
  const basenameMap = new Map<string, string>(); // "dir/filename" -> "dir/newFilename", for substitution in .rels
  for (const path of Object.keys(addP.zip.files)) {
    if (addP.zip.files[path].dir) continue;
    for (const dir of SUPPORT_DIRS) {
      const prefix = `ppt/${dir}/`;
      if (!path.startsWith(prefix)) continue;
      const rest = path.slice(prefix.length); // "slideMaster1.xml" or "_rels/slideMaster1.xml.rels"
      const isRels = rest.startsWith('_rels/');
      const filename = isRels ? rest.slice('_rels/'.length) : rest;
      const newFilename = `merged-${suffix}-${filename}`;
      const newPath = isRels ? `${prefix}_rels/${newFilename}` : `${prefix}${newFilename}`;
      renameMap.set(path, newPath);
      if (!isRels) basenameMap.set(`${dir}/${filename}`, `${dir}/${newFilename}`);
      break;
    }
  }

  // ---- Renumber addition's slides to continue after base's ----
  const addSlideFiles: string[] = [];
  const addSlideSection = addP.presentationXml.match(/<p:sldIdLst>([\s\S]*?)<\/p:sldIdLst>/);
  if (addSlideSection) {
    for (const match of addSlideSection[1].matchAll(/r:id="([^"]+)"/g)) {
      const target = resolveRelTarget(addP.presentationRels, match[1]);
      const path = presentationTargetPath(target);
      if (path && /^ppt\/slides\/slide\d+\.xml$/.test(path)) addSlideFiles.push(path);
    }
  }
  if (addSlideFiles.length === 0) {
    addSlideFiles.push(
      ...Object.keys(addP.zip.files)
        .filter((f) => /^ppt\/slides\/slide\d+\.xml$/.test(f))
        .sort((a, b) => parseInt(a.match(/\d+/)![0], 10) - parseInt(b.match(/\d+/)![0], 10)),
    );
  }

  const slideRenameMap = new Map<string, string>();
  const slideNewNumbers: number[] = [];
  for (const path of addSlideFiles) {
    const newNum = nextSlideNum++;
    slideNewNumbers.push(newNum);
    slideRenameMap.set(path, `ppt/slides/slide${newNum}.xml`);
    const relsPath = `ppt/slides/_rels/${path.split('/').pop()}.rels`;
    if (addP.zip.file(relsPath)) {
      slideRenameMap.set(relsPath, `ppt/slides/_rels/slide${newNum}.xml.rels`);
    }
  }

  if (addSlideFiles.length === 0) {
    throw new Error('추가할 슬라이드가 없습니다.');
  }

  // ---- Copy renamed files, rewriting relative Target="../dir/file" references in .rels content ----
  function applyBasenameSubs(text: string): string {
    let out = text;
    for (const [oldKey, newKey] of basenameMap) {
      const [dir, filename] = oldKey.split('/');
      const newFilename = newKey.slice(newKey.indexOf('/') + 1);
      const re = new RegExp(`(\\.\\./${escapeRegExp(dir)}/)${escapeRegExp(filename)}(["'])`, 'g');
      out = out.replace(re, `$1${newFilename}$2`);
    }
    return out;
  }

  // A slide's own .rels points at sibling slides with a bare filename
  // (Target="slide5.xml", no "../"), which is how a jump button
  // (ppaction://hlinksldjump) addresses its target. Those names are renumbered
  // by the copy below, so without this substitution the button would keep
  // pointing at whichever slide now occupies the old number — silently, since
  // that part still exists.
  const slideBasenameSubs = new Map<string, string>();
  for (const [oldPath, newPath] of slideRenameMap) {
    if (oldPath.endsWith('.rels')) continue;
    slideBasenameSubs.set(oldPath.split('/').pop()!, newPath.split('/').pop()!);
  }
  function applySlideTargetSubs(text: string): string {
    return text.replace(
      /(Target=")(?:\.\.\/slides\/)?(slide\d+\.xml)(")/g,
      (whole, open: string, filename: string, close: string) => {
        const replacement = slideBasenameSubs.get(filename);
        return replacement ? `${open}${replacement}${close}` : whole;
      },
    );
  }

  /**
   * Drop slide relationships whose target is not coming along. Only slides
   * listed in the addition's `<p:sldIdLst>` are copied, so a jump button
   * pointing at a slide that is hidden (or outside the list) would otherwise
   * leave a relationship with no part behind it — which fails the integrity
   * check and stops the download. The `<a:hlinkClick>` that used it goes too,
   * or the slide XML would carry an r:id that no longer resolves.
   */
  function dropUnmappedSlideLinks(relsXml: string, slideXml: string): { rels: string; xml: string } {
    const dropped: string[] = [];
    const rels = relsXml.replace(/<Relationship\b[^>]*\/>/g, (tag) => {
      if (!/Type="[^"]*\/relationships\/slide"/.test(tag)) return tag;
      if (/TargetMode="External"/.test(tag)) return tag;
      const target = xmlAttr(tag, 'Target')?.replace(/^\.\.\/slides\//, '');
      if (!target || slideBasenameSubs.has(target)) return tag;
      const id = xmlAttr(tag, 'Id');
      if (id) dropped.push(id);
      return '';
    });
    if (dropped.length === 0) return { rels: relsXml, xml: slideXml };

    let xml = slideXml;
    for (const id of dropped) {
      xml = xml.replace(
        new RegExp(`<a:hlinkClick\\b[^>]*r:id="${escapeRegExp(id)}"[^>]*(?:/>|>[\\s\\S]*?</a:hlinkClick>)`, 'g'),
        '',
      );
    }
    return { rels, xml };
  }

  const allRenames = new Map<string, string>([...renameMap, ...slideRenameMap]);
  for (const [oldPath, newPath] of allRenames) {
    const file = addP.zip.file(oldPath);
    if (!file) continue;
    if (/\.(xml|rels)$/.test(oldPath)) {
      const text = await file.async('string');
      baseP.zip.file(newPath, applyBasenameSubs(text));
    } else {
      const bytes = await file.async('uint8array');
      baseP.zip.file(newPath, bytes);
    }
  }

  // ---- Retarget the copied slides' own slide→slide links (jump buttons) ----
  for (const [oldPath, newPath] of slideRenameMap) {
    if (oldPath.endsWith('.rels')) continue;
    const relsPath = `ppt/slides/_rels/${newPath.split('/').pop()}.rels`;
    const relsFile = baseP.zip.file(relsPath);
    if (!relsFile) continue;
    const slideFile = baseP.zip.file(newPath);
    if (!slideFile) continue;

    // Drop first, retarget second: the check is against the *original* slide
    // names, which the retargeting replaces.
    const pruned = dropUnmappedSlideLinks(await relsFile.async('string'), await slideFile.async('string'));
    baseP.zip.file(relsPath, applySlideTargetSubs(pruned.rels));
    baseP.zip.file(newPath, pruned.xml);
  }

  // ---- [Content_Types].xml: carry over Overrides for renamed parts + any new Default extensions ----
  const addContentTypes = parseContentTypes(await addP.zip.file('[Content_Types].xml')!.async('string'));
  for (const [oldPath, newPath] of allRenames) {
    const contentType = addContentTypes.overrides.get(partNameKey(oldPath));
    if (contentType) contentTypes = setContentTypeOverride(contentTypes, newPath, contentType);
  }
  for (const newPath of slideRenameMap.values()) {
    if (!newPath.endsWith('.rels')) {
      contentTypes = setContentTypeOverride(
        contentTypes,
        newPath,
        'application/vnd.openxmlformats-officedocument.presentationml.slide+xml',
      );
    }
  }
  for (const [ext, ct] of addContentTypes.defaults) {
    contentTypes = ensureDefaultExtension(contentTypes, ext, ct);
  }

  // ---- presentation.xml + rels: carry over addition's slide master(s), then its slides ----
  const addMasterSection = addP.presentationXml.match(/<p:sldMasterIdLst>([\s\S]*?)<\/p:sldMasterIdLst>/);
  if (addMasterSection) {
    for (const match of addMasterSection[1].matchAll(/<p:sldMasterId\b[^>]*>/g)) {
      const origRid = xmlAttr(match[0], 'r:id');
      const origPath = presentationTargetPath(
        origRid ? resolveRelTarget(addP.presentationRels, origRid) : null,
      );
      if (!origPath) continue;
      const newPath = renameMap.get(origPath);
      if (!newPath) continue;
      const newTarget = newPath.replace(/^ppt\//, '');
      const rid = `rId${nextRid++}`;
      const id = nextMasterId++;
      presRels = presRels.replace(
        '</Relationships>',
        `<Relationship Id="${rid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="${newTarget}"/></Relationships>`,
      );
      presentation = presentation.replace('</p:sldMasterIdLst>', `<p:sldMasterId id="${id}" r:id="${rid}"/></p:sldMasterIdLst>`);
    }
  }

  const newSldIds: string[] = [];
  for (const newNum of slideNewNumbers) {
    const rid = `rId${nextRid++}`;
    const id = nextSlideId++;
    presRels = presRels.replace(
      '</Relationships>',
      `<Relationship Id="${rid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${newNum}.xml"/></Relationships>`,
    );
    newSldIds.push(`<p:sldId id="${id}" r:id="${rid}"/>`);
  }
  presentation = insertSlideIds(presentation, newSldIds, insertAt);

  presentation = await normalizeSlideMasterAndLayoutIds(baseP.zip, presentation, presRels);

  baseP.zip.file('[Content_Types].xml', contentTypes);
  baseP.zip.file('ppt/presentation.xml', presentation);
  baseP.zip.file('ppt/_rels/presentation.xml.rels', presRels);

  // Last word on content types: a part copied out of a deck whose own
  // declarations could not be read still has to be declared for what the
  // relationships pointing at it say it is.
  await repairContentTypes(baseP.zip);

  return baseP.zip.generateAsync({ type: 'uint8array', compression });
}
