import JSZip from 'jszip';

const DISCARD_PART_PREFIXES = [
  'ppt/notesSlides/',
  'ppt/notesMasters/',
  'ppt/comments/',
  'ppt/threadedComments/',
  'ppt/tags/',
  'ppt/persons/',
];

const DISCARD_PARTS = new Set([
  'ppt/commentAuthors.xml',
  'ppt/threadedCommentAuthors.xml',
  'ppt/person.xml',
]);

const DISCARD_REL_KIND =
  /\/(?:notesSlide|notesMaster|comments?|commentAuthors?|threadedComments?|threadedCommentAuthors?|person|tags|slideUpdateInfo)$/i;

function attr(tag: string, name: string): string | null {
  return tag.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1] ?? null;
}

function isDiscardedPart(path: string): boolean {
  return DISCARD_PARTS.has(path) || DISCARD_PART_PREFIXES.some((prefix) => path.startsWith(prefix));
}

function stripDiscardedRelationships(xml: string): string {
  return xml.replace(/<Relationship\b[^>]*\/>/g, (tag) => {
    const type = attr(tag, 'Type') ?? '';
    const target = (attr(tag, 'Target') ?? '').replace(/^\.\.\//, '');
    return DISCARD_REL_KIND.test(type) || isDiscardedPart(`ppt/${target}`) ? '' : tag;
  });
}

/**
 * Remove speaker-note and comment parts that are not needed for projection.
 *
 * The deck merger intentionally does not carry those parts into the combined
 * presentation. Their relationships must be removed at the same time; leaving
 * a slide -> notesSlide reference behind is enough for PowerPoint to report
 * that the downloaded file needs repair.
 */
export async function stripNonVisualParts(zip: JSZip): Promise<void> {
  const paths = Object.keys(zip.files);
  for (const path of paths) {
    if (isDiscardedPart(path)) zip.remove(path);
  }

  const relPaths = Object.keys(zip.files).filter((path) => path.endsWith('.rels'));
  for (const path of relPaths) {
    const file = zip.file(path);
    if (!file) continue;
    zip.file(path, stripDiscardedRelationships(await file.async('string')));
  }

  const contentTypesFile = zip.file('[Content_Types].xml');
  if (contentTypesFile) {
    let contentTypes = await contentTypesFile.async('string');
    contentTypes = contentTypes.replace(/<Override\b[^>]*PartName="\/ppt\/(?:notesSlides|notesMasters|comments|threadedComments|tags|persons)\/[^\"]+"[^>]*\/>/g, '');
    contentTypes = contentTypes.replace(/<Override\b[^>]*PartName="\/ppt\/(?:commentAuthors|threadedCommentAuthors|person)\.xml"[^>]*\/>/g, '');
    zip.file('[Content_Types].xml', contentTypes);
  }

  // presentation.xml keeps its own pointer to the notes master; with the
  // part and its relationship gone, that r:id dangles — which PowerPoint
  // reports as content that needs repair even though every relationship
  // target in the package resolves.
  const presentationFile = zip.file('ppt/presentation.xml');
  if (presentationFile) {
    const presentation = await presentationFile.async('string');
    const cleaned = presentation.replace(/<p:notesMasterIdLst>[\s\S]*?<\/p:notesMasterIdLst>|<p:notesMasterIdLst\/>/g, '');
    if (cleaned !== presentation) zip.file('ppt/presentation.xml', cleaned);
  }
}

function decodeTarget(value: string): string {
  const xmlDecoded = value
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .split(/[?#]/, 1)[0];
  try {
    return decodeURIComponent(xmlDecoded);
  } catch {
    return xmlDecoded;
  }
}

function normalizePartPath(path: string): string {
  const out: string[] = [];
  for (const piece of path.split('/')) {
    if (!piece || piece === '.') continue;
    if (piece === '..') out.pop();
    else out.push(piece);
  }
  return out.join('/');
}

function relationshipOwner(relsPath: string): string | null {
  if (relsPath === '_rels/.rels') return null;
  const marker = '/_rels/';
  const at = relsPath.lastIndexOf(marker);
  if (at === -1 || !relsPath.endsWith('.rels')) return null;
  const directory = relsPath.slice(0, at);
  const filename = relsPath.slice(at + marker.length, -'.rels'.length);
  return `${directory}/${filename}`;
}

function resolveRelationshipTarget(relsPath: string, target: string): string {
  const clean = decodeTarget(target);
  if (clean.startsWith('/')) return normalizePartPath(clean.slice(1));
  const owner = relationshipOwner(relsPath);
  const directory = owner?.includes('/') ? owner.slice(0, owner.lastIndexOf('/')) : '';
  return normalizePartPath(`${directory}/${clean}`);
}

// Attributes in the officeDocument relationships namespace: their value must
// match a relationship Id in the part's own .rels file. A reference without a
// matching Id ("dangling") makes PowerPoint prompt to repair the file.
const RELATIONSHIP_REF = /\br:(?:id|embed|link|pict|dm|lo|qs|cs|href)="([^"]+)"/g;

/** Return every broken internal package relationship with a useful location. */
export async function findBrokenRelationships(zip: JSZip): Promise<string[]> {
  const errors: string[] = [];
  const relPaths = Object.keys(zip.files).filter((path) => path.endsWith('.rels'));

  const xmlPaths = Object.keys(zip.files).filter(
    (path) => path.endsWith('.xml') && !path.endsWith('.rels') && !zip.files[path].dir,
  );
  for (const path of xmlPaths) {
    const xml = await zip.file(path)!.async('string');
    const refs = new Set<string>();
    for (const match of xml.matchAll(RELATIONSHIP_REF)) {
      if (match[1]) refs.add(match[1]);
    }
    if (refs.size === 0) continue;

    const directory = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
    const relsPath = directory ? `${directory}/_rels/${path.slice(directory.length + 1)}.rels` : `_rels/${path}.rels`;
    const ids = new Set<string>();
    const relsFile = zip.file(relsPath);
    if (relsFile) {
      for (const match of (await relsFile.async('string')).matchAll(/<Relationship\b[^>]*\/>/g)) {
        const id = attr(match[0], 'Id');
        if (id) ids.add(id);
      }
    }
    for (const ref of refs) {
      if (!ids.has(ref)) errors.push(`${path}: dangling relationship reference ${ref} (not in ${relsPath})`);
    }
  }

  for (const relsPath of relPaths) {
    const owner = relationshipOwner(relsPath);
    if (owner && !zip.file(owner)) {
      errors.push(`${relsPath}: relationship owner is missing (${owner})`);
      continue;
    }

    const xml = await zip.file(relsPath)!.async('string');
    const ids = new Set<string>();
    for (const match of xml.matchAll(/<Relationship\b[^>]*\/>/g)) {
      const tag = match[0];
      const id = attr(tag, 'Id');
      if (id) {
        if (ids.has(id)) errors.push(`${relsPath}: duplicate relationship Id ${id}`);
        ids.add(id);
      }
      if ((attr(tag, 'TargetMode') ?? '').toLowerCase() === 'external') continue;
      const target = attr(tag, 'Target');
      if (!target || /^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
      const resolved = resolveRelationshipTarget(relsPath, target);
      if (!zip.file(resolved)) errors.push(`${relsPath}: missing target ${resolved}`);
    }
  }

  return errors;
}

// Characters XML 1.0 cannot carry at all (not even as entity references).
// PowerPoint reports a deck containing one as corrupt and offers to repair it.
const ILLEGAL_XML_CHAR =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/**
 * Check every XML part for characters XML cannot represent and — when a
 * DOMParser is available (always, in the browser) — for well-formedness.
 * Catches text-level corruption that relationship checks can't see.
 */
export async function findMalformedXmlParts(zip: JSZip): Promise<string[]> {
  const errors: string[] = [];
  // Structural type so this file also type-checks under the node tsconfig
  // (tests), where the DOM lib — and thus the DOMParser type — is absent.
  interface XmlParser {
    parseFromString(text: string, type: string): { getElementsByTagName(name: string): { length: number } };
  }
  const DomParser = (globalThis as { DOMParser?: new () => XmlParser }).DOMParser;
  const parser = DomParser ? new DomParser() : null;
  const xmlPaths = Object.keys(zip.files).filter(
    (path) => (path.endsWith('.xml') || path.endsWith('.rels')) && !zip.files[path].dir,
  );
  for (const path of xmlPaths) {
    const text = await zip.file(path)!.async('string');
    if (ILLEGAL_XML_CHAR.test(text)) {
      errors.push(`${path}: contains characters not allowed in XML`);
      continue;
    }
    if (parser && parser.parseFromString(text, 'application/xml').getElementsByTagName('parsererror').length > 0) {
      errors.push(`${path}: malformed XML`);
    }
  }
  return errors;
}

/** Validate the final deck before the browser offers it for download. */
export async function assertPptxIntegrity(data: ArrayBuffer | Uint8Array): Promise<void> {
  const zip = await JSZip.loadAsync(data);
  const required = ['[Content_Types].xml', 'ppt/presentation.xml', 'ppt/_rels/presentation.xml.rels'];
  for (const path of required) {
    if (!zip.file(path)) throw new Error(`PPTX 필수 파일이 없습니다: ${path}`);
  }

  const errors = [...(await findMalformedXmlParts(zip)), ...(await findBrokenRelationships(zip))];
  const slideFiles = Object.keys(zip.files).filter((path) => /^ppt\/slides\/slide\d+\.xml$/.test(path));
  const presentation = await zip.file('ppt/presentation.xml')!.async('string');
  const listedSlides = presentation.match(/<p:sldId\b/g)?.length ?? 0;
  if (listedSlides !== slideFiles.length) {
    errors.push(`presentation lists ${listedSlides} slides but package contains ${slideFiles.length}`);
  }

  const contentTypes = await zip.file('[Content_Types].xml')!.async('string');
  const overrides = new Map<string, string>();
  const defaults = new Map<string, string>();
  for (const match of contentTypes.matchAll(/<Override\b[^>]*\/>/g)) {
    const partName = attr(match[0], 'PartName');
    const contentType = attr(match[0], 'ContentType');
    if (partName && contentType) overrides.set(partName.replace(/^\//, ''), contentType);
  }
  for (const match of contentTypes.matchAll(/<Default\b[^>]*\/>/g)) {
    const extension = attr(match[0], 'Extension');
    const contentType = attr(match[0], 'ContentType');
    if (extension && contentType) defaults.set(extension.toLowerCase(), contentType);
  }

  const effectiveContentType = (path: string): string | undefined => {
    const override = overrides.get(path);
    if (override) return override;
    const extension = path.includes('.') ? path.slice(path.lastIndexOf('.') + 1).toLowerCase() : '';
    return defaults.get(extension);
  };

  for (const path of slideFiles) {
    if (!contentTypes.includes(`PartName="/${path}"`)) {
      errors.push(`[Content_Types].xml: missing override for ${path}`);
    }
  }

  const expectedByRelationship: Record<string, string> = {
    slide: 'application/vnd.openxmlformats-officedocument.presentationml.slide+xml',
    slideLayout: 'application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml',
    slideMaster: 'application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml',
    theme: 'application/vnd.openxmlformats-officedocument.theme+xml',
  };
  const relPaths = Object.keys(zip.files).filter((path) => path.endsWith('.rels'));
  for (const relsPath of relPaths) {
    const xml = await zip.file(relsPath)!.async('string');
    for (const match of xml.matchAll(/<Relationship\b[^>]*\/>/g)) {
      const tag = match[0];
      if ((attr(tag, 'TargetMode') ?? '').toLowerCase() === 'external') continue;
      const type = attr(tag, 'Type') ?? '';
      const kind = type.slice(type.lastIndexOf('/') + 1);
      const expected = expectedByRelationship[kind];
      const target = attr(tag, 'Target');
      if (!expected || !target) continue;
      const resolved = resolveRelationshipTarget(relsPath, target);
      const actual = effectiveContentType(resolved);
      if (actual !== expected) {
        errors.push(`${relsPath}: ${resolved} has content type ${actual ?? '(missing)'}; expected ${expected}`);
      }
    }
  }

  if (errors.length > 0) {
    throw new Error(`PPTX 무결성 검사 실패:\n${errors.slice(0, 12).join('\n')}`);
  }
}
