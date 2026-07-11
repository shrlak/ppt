// Merges two standalone .pptx decks into one file: `addition`'s slides are
// appended after `base`'s slides. Each deck keeps its own slide layouts,
// slide master, theme, and media (renamed to avoid collisions) so both
// render exactly as they did standalone — this lets the lyrics generator and
// the Bible-verse generator use their own templates yet produce one combined
// download. Notes masters/slides are dropped (cosmetic only, not shown to
// the congregation).
import JSZip from 'jszip';

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
  const m = relsXml.match(new RegExp(`Id="${rId}"[^>]*Target="([^"]+)"`));
  return m ? m[1] : null;
}

const SUPPORT_DIRS = ['slideLayouts', 'slideMasters', 'theme', 'media', 'fonts'];

/**
 * Merge two standalone .pptx decks: `addition`'s slides are appended after
 * `base`'s. Everything `addition`'s slides depend on (layouts, master,
 * theme, media) is copied in under a unique "merged-" prefix so it can't
 * collide with `base`'s own parts.
 */
export async function mergePptxDecks(
  base: ArrayBuffer | Uint8Array,
  addition: ArrayBuffer | Uint8Array,
): Promise<Uint8Array> {
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
  const addSlideFiles = Object.keys(addP.zip.files)
    .filter((f) => /^ppt\/slides\/slide\d+\.xml$/.test(f))
    .sort((a, b) => parseInt(a.match(/\d+/)![0], 10) - parseInt(b.match(/\d+/)![0], 10));

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

  // ---- [Content_Types].xml: carry over Overrides for renamed parts + any new Default extensions ----
  const addContentTypes = await addP.zip.file('[Content_Types].xml')!.async('string');
  for (const [oldPath, newPath] of allRenames) {
    const m = addContentTypes.match(new RegExp(`<Override PartName="/${escapeRegExp(oldPath)}" ContentType="([^"]+)"/>`));
    if (m) {
      contentTypes = contentTypes.replace('</Types>', `<Override PartName="/${newPath}" ContentType="${m[1]}"/></Types>`);
    }
  }
  for (const newPath of slideRenameMap.values()) {
    if (!newPath.endsWith('.rels') && !contentTypes.includes(`PartName="/${newPath}"`)) {
      contentTypes = contentTypes.replace(
        '</Types>',
        `<Override PartName="/${newPath}" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/></Types>`,
      );
    }
  }
  for (const m of addContentTypes.matchAll(/<Default Extension="([^"]+)" ContentType="([^"]+)"\/>/g)) {
    const [, ext, ct] = m;
    if (!contentTypes.includes(`Extension="${ext}"`)) {
      contentTypes = contentTypes.replace('</Types>', `<Default Extension="${ext}" ContentType="${ct}"/></Types>`);
    }
  }

  // ---- presentation.xml + rels: carry over addition's slide master(s), then its slides ----
  const addMasterSection = addP.presentationXml.match(/<p:sldMasterIdLst>([\s\S]*?)<\/p:sldMasterIdLst>/);
  if (addMasterSection) {
    for (const m of addMasterSection[1].matchAll(/r:id="(rId\d+)"/g)) {
      const origTarget = resolveRelTarget(addP.presentationRels, m[1]); // e.g. "slideMasters/slideMaster1.xml"
      if (!origTarget) continue;
      const newPath = renameMap.get(`ppt/${origTarget}`);
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

  for (const newNum of slideNewNumbers) {
    const rid = `rId${nextRid++}`;
    const id = nextSlideId++;
    presRels = presRels.replace(
      '</Relationships>',
      `<Relationship Id="${rid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${newNum}.xml"/></Relationships>`,
    );
    presentation = presentation.replace('</p:sldIdLst>', `<p:sldId id="${id}" r:id="${rid}"/></p:sldIdLst>`);
  }

  baseP.zip.file('[Content_Types].xml', contentTypes);
  baseP.zip.file('ppt/presentation.xml', presentation);
  baseP.zip.file('ppt/_rels/presentation.xml.rels', presRels);

  return baseP.zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
}
