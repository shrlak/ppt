import { describe, expect, it } from 'vitest';
import {
  contentTypeOf,
  ensureDefaultExtension,
  parseContentTypes,
  partNameKey,
  removeContentTypeOverride,
  removeContentTypeOverridesWhere,
  setContentTypeOverride,
} from '../../src/lib/pptx/contentTypes';

const MASTER = 'application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml';
const SLIDE = 'application/vnd.openxmlformats-officedocument.presentationml.slide+xml';

const PLAIN = [
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
  '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">',
  '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
  '<Default Extension="xml" ContentType="application/xml"/>',
  `<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="${MASTER}"/>`,
  `<Override PartName="/ppt/slides/slide1.xml" ContentType="${SLIDE}"/>`,
  '</Types>',
].join('');

// The same declarations, written the way other producers legally write them.
const VARIANTS: Record<string, string> = {
  'attributes in the other order': PLAIN.replace(
    /<Override PartName="([^"]*)" ContentType="([^"]*)"\/>/g,
    (_m, part, type) => `<Override ContentType="${type}" PartName="${part}"/>`,
  ),
  'single-quoted attributes': PLAIN.replace(/(\w+)="([^"]*)"/g, (_m, name, value) => `${name}='${value}'`),
  'element pairs instead of empty elements': PLAIN.replace(
    /<Override\b([^>]*)\/>/g,
    (_m, attrs) => `<Override${attrs}></Override>`,
  ),
  'a namespace prefix on every element': PLAIN.replace(
    '<Types xmlns=',
    '<ct:Types xmlns:ct=',
  )
    .replace('</Types>', '</ct:Types>')
    .replace(/<(Override|Default) /g, '<ct:$1 '),
};

describe('parseContentTypes', () => {
  for (const [shape, xml] of Object.entries({ 'the shape this app writes': PLAIN, ...VARIANTS })) {
    it(`reads declarations written with ${shape}`, () => {
      const types = parseContentTypes(xml);
      expect(contentTypeOf(types, 'ppt/slideMasters/slideMaster1.xml')).toBe(MASTER);
      expect(contentTypeOf(types, 'ppt/slides/slide1.xml')).toBe(SLIDE);
      // Extension defaults still apply to parts without an override.
      expect(contentTypeOf(types, 'ppt/theme/theme1.xml')).toBe('application/xml');
    });
  }

  it('compares part names without regard to case, as OPC does', () => {
    expect(partNameKey('ppt/slideMasters/slideMaster1.xml')).toBe(partNameKey('/PPT/SlideMasters/SLIDEMASTER1.XML'));
    const types = parseContentTypes(PLAIN.replace('/ppt/slideMasters/slideMaster1.xml', '/ppt/slidemasters/slidemaster1.xml'));
    expect(contentTypeOf(types, 'ppt/slideMasters/slideMaster1.xml')).toBe(MASTER);
  });

  it('decodes percent-escaped part names', () => {
    const types = parseContentTypes(PLAIN.replace('slide1.xml', 'slide%201.xml'));
    expect(contentTypeOf(types, 'ppt/slides/slide 1.xml')).toBe(SLIDE);
  });
});

describe('setContentTypeOverride', () => {
  it('adds a declaration for a part that has none', () => {
    const xml = setContentTypeOverride(PLAIN, 'ppt/slideLayouts/slideLayout1.xml', MASTER);
    expect(contentTypeOf(parseContentTypes(xml), 'ppt/slideLayouts/slideLayout1.xml')).toBe(MASTER);
    expect(xml).toContain('</Types>');
  });

  it('replaces a wrong declaration rather than adding a second one', () => {
    const wrong = PLAIN.replace(MASTER, 'application/xml');
    const xml = setContentTypeOverride(wrong, 'ppt/slideMasters/slideMaster1.xml', MASTER);
    expect(contentTypeOf(parseContentTypes(xml), 'ppt/slideMasters/slideMaster1.xml')).toBe(MASTER);
    expect(xml.match(/slideMaster1\.xml/g)).toHaveLength(1);
  });

  it('is a no-op in effect when the part is already declared correctly', () => {
    const xml = setContentTypeOverride(PLAIN, 'ppt/slideMasters/slideMaster1.xml', MASTER);
    expect(parseContentTypes(xml).overrides).toEqual(parseContentTypes(PLAIN).overrides);
  });

  for (const [shape, source] of Object.entries(VARIANTS)) {
    it(`keeps a document with ${shape} readable after an edit`, () => {
      const xml = setContentTypeOverride(source, 'ppt/slides/slide2.xml', SLIDE);
      const types = parseContentTypes(xml);
      expect(contentTypeOf(types, 'ppt/slides/slide2.xml')).toBe(SLIDE);
      expect(contentTypeOf(types, 'ppt/slideMasters/slideMaster1.xml')).toBe(MASTER);
    });
  }

  it('puts an added element in the content-types namespace of a prefixed document', () => {
    const xml = setContentTypeOverride(VARIANTS['a namespace prefix on every element'], 'ppt/slides/slide2.xml', SLIDE);
    expect(xml).toContain('<ct:Override PartName="/ppt/slides/slide2.xml"');
    expect(xml).not.toContain('<Override ');
  });
});

describe('removeContentTypeOverride', () => {
  it('drops the declaration whatever shape it was written in', () => {
    for (const source of [PLAIN, ...Object.values(VARIANTS)]) {
      const xml = removeContentTypeOverride(source, 'ppt/slides/slide1.xml');
      expect(contentTypeOf(parseContentTypes(xml), 'ppt/slides/slide1.xml')).toBe('application/xml');
      // The other declarations survive.
      expect(contentTypeOf(parseContentTypes(xml), 'ppt/slideMasters/slideMaster1.xml')).toBe(MASTER);
    }
  });

  it('takes the closing tag with it when the source used element pairs', () => {
    const source = VARIANTS['element pairs instead of empty elements'];
    const xml = removeContentTypeOverride(source, 'ppt/slides/slide1.xml');
    // One pair removed whole: the remaining opening tags still each have a
    // closing tag, rather than an orphan left where the part used to be.
    expect(xml.match(/<Override\b/g)).toHaveLength(1);
    expect(xml.match(/<\/Override>/g)).toHaveLength(1);
  });

  it('removes by predicate', () => {
    const xml = removeContentTypeOverridesWhere(PLAIN, (partName) => partName.startsWith('/ppt/slides/'));
    expect(parseContentTypes(xml).overrides.size).toBe(1);
  });
});

describe('ensureDefaultExtension', () => {
  it('adds an extension the package does not declare yet', () => {
    const xml = ensureDefaultExtension(PLAIN, 'png', 'image/png');
    expect(parseContentTypes(xml).defaults.get('png')).toBe('image/png');
  });

  it('never redeclares an extension the package already has', () => {
    const xml = ensureDefaultExtension(PLAIN, 'xml', 'text/xml');
    expect(xml).toBe(PLAIN);
  });
});
