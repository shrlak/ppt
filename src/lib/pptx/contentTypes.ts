// Reading and editing a package's `[Content_Types].xml`.
//
// Every part of a .pptx gets its content type from this one file, and
// PowerPoint refuses to open a deck whose slide master, layouts or theme are
// typed as plain `application/xml`. The decks we merge come from whatever
// authored them — PowerPoint, Google Slides, Keynote, 한쇼, a Python
// exporter — and XML lets each of them write the same declaration
// differently: attributes in either order, single or double quotes, an
// explicit namespace prefix on every element, an empty element written as a
// tag pair. Matching one hand-written shape ("<Override PartName=…/>") silently
// misses the others, and a missed Override means a lost content type.
//
// These helpers read and rewrite the part through one tolerant tag scanner
// instead, and they compare part names the way OPC does: case-insensitively.

const NAME = '(?:[A-Za-z_][\\w.-]*:)?';

function tagPattern(local: string): RegExp {
  return new RegExp(`<${NAME}${local}\\b[^>]*>`, 'g');
}

function closingTagPattern(local: string): RegExp {
  return new RegExp(`^\\s*</${NAME}${local}\\s*>`);
}

/** Read an attribute, accepting either quote style and an optional prefix. */
function attrValue(tag: string, name: string): string | null {
  const match = tag.match(new RegExp(`\\s${NAME}${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i'));
  if (!match) return null;
  return decodeXmlText(match[1] ?? match[2] ?? '');
}

function decodeXmlText(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function encodeXmlAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
}

/**
 * OPC part names are absolute, `/`-rooted and compared without regard to
 * case, so `/ppt/slideMasters/slideMaster1.xml` and the zip entry
 * `ppt/slideMasters/slideMaster1.xml` are the same part.
 */
export function partNameKey(path: string): string {
  let decoded = path;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    // Keep the literal path when a producer wrote an invalid percent escape.
  }
  return `/${decoded.replace(/^\/+/, '')}`.toLowerCase();
}

interface TagSpan {
  /** Offset of the element's first character in the source XML. */
  start: number;
  /** Offset just past the element (past `</Override>` for a tag pair). */
  end: number;
  tag: string;
}

/** Every `<local .../>` or `<local ...></local>` element, in document order. */
function elements(xml: string, local: string): TagSpan[] {
  const spans: TagSpan[] = [];
  for (const match of xml.matchAll(tagPattern(local))) {
    const tag = match[0];
    const start = match.index!;
    let end = start + tag.length;
    if (!tag.endsWith('/>')) {
      const closing = xml.slice(end).match(closingTagPattern(local));
      if (closing) end += closing[0].length;
    }
    spans.push({ start, end, tag });
  }
  return spans;
}

export interface ContentTypes {
  /** Part name (via partNameKey) -> content type. */
  overrides: Map<string, string>;
  /** Lower-cased extension -> content type. */
  defaults: Map<string, string>;
}

export function parseContentTypes(xml: string): ContentTypes {
  const overrides = new Map<string, string>();
  const defaults = new Map<string, string>();
  for (const { tag } of elements(xml, 'Override')) {
    const partName = attrValue(tag, 'PartName');
    const contentType = attrValue(tag, 'ContentType');
    if (partName && contentType) overrides.set(partNameKey(partName), contentType);
  }
  for (const { tag } of elements(xml, 'Default')) {
    const extension = attrValue(tag, 'Extension');
    const contentType = attrValue(tag, 'ContentType');
    if (extension && contentType) defaults.set(extension.toLowerCase(), contentType);
  }
  return { overrides, defaults };
}

/** The content type a part actually carries: its Override, else its Default. */
export function contentTypeOf(types: ContentTypes, path: string): string | undefined {
  const override = types.overrides.get(partNameKey(path));
  if (override) return override;
  const extension = path.includes('.') ? path.slice(path.lastIndexOf('.') + 1).toLowerCase() : '';
  return types.defaults.get(extension);
}

/**
 * The element prefix in use, so parts added to a namespace-prefixed document
 * stay in the content-types namespace instead of landing in no namespace.
 */
function elementPrefix(xml: string): string {
  return xml.match(new RegExp(`<(${NAME})Types\\b`))?.[1] ?? '';
}

function insertBeforeTypesEnd(xml: string, element: string): string {
  const closing = xml.match(new RegExp(`</${NAME}Types\\s*>`));
  if (!closing) return xml + element;
  const at = closing.index!;
  return xml.slice(0, at) + element + xml.slice(at);
}

function replaceContentTypeAttr(tag: string, contentType: string): string {
  const re = new RegExp(`(\\s${NAME}ContentType\\s*=\\s*)(?:"[^"]*"|'[^']*')`, 'i');
  if (re.test(tag)) return tag.replace(re, (_full, lead: string) => `${lead}"${encodeXmlAttr(contentType)}"`);
  return tag.replace(/\s*\/?>$/, (end) => ` ContentType="${encodeXmlAttr(contentType)}"${end.trimStart()}`);
}

/**
 * Declare `contentType` for `partPath`, replacing whatever the part was
 * declared as before. Returns the XML unchanged when it already says so.
 */
export function setContentTypeOverride(xml: string, partPath: string, contentType: string): string {
  const key = partNameKey(partPath);
  const existing = elements(xml, 'Override').filter(({ tag }) => {
    const partName = attrValue(tag, 'PartName');
    return partName !== null && partNameKey(partName) === key;
  });

  if (existing.length > 0) {
    let out = xml;
    // Rewrite from the back so earlier spans keep their offsets.
    for (const span of [...existing].reverse()) {
      const updated = replaceContentTypeAttr(span.tag, contentType);
      out = out.slice(0, span.start) + updated + out.slice(span.start + span.tag.length);
    }
    return out;
  }

  const prefix = elementPrefix(xml);
  const partName = `/${partPath.replace(/^\/+/, '')}`;
  return insertBeforeTypesEnd(
    xml,
    `<${prefix}Override PartName="${encodeXmlAttr(partName)}" ContentType="${encodeXmlAttr(contentType)}"/>`,
  );
}

/** Drop the declaration for a part that is no longer in the package. */
export function removeContentTypeOverride(xml: string, partPath: string): string {
  const key = partNameKey(partPath);
  let out = xml;
  const doomed = elements(xml, 'Override').filter(({ tag }) => {
    const partName = attrValue(tag, 'PartName');
    return partName !== null && partNameKey(partName) === key;
  });
  for (const span of [...doomed].reverse()) {
    out = out.slice(0, span.start) + out.slice(span.end);
  }
  return out;
}

/** Remove every Override whose part name satisfies `matches`. */
export function removeContentTypeOverridesWhere(xml: string, matches: (partName: string) => boolean): string {
  let out = xml;
  const doomed = elements(xml, 'Override').filter(({ tag }) => {
    const partName = attrValue(tag, 'PartName');
    return partName !== null && matches(partName);
  });
  for (const span of [...doomed].reverse()) {
    out = out.slice(0, span.start) + out.slice(span.end);
  }
  return out;
}

/** Declare a file extension's content type unless the package already does. */
export function ensureDefaultExtension(xml: string, extension: string, contentType: string): string {
  const parsed = parseContentTypes(xml);
  if (parsed.defaults.has(extension.toLowerCase())) return xml;
  const prefix = elementPrefix(xml);
  return insertBeforeTypesEnd(
    xml,
    `<${prefix}Default Extension="${encodeXmlAttr(extension)}" ContentType="${encodeXmlAttr(contentType)}"/>`,
  );
}
