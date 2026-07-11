// Extracts a subset of slides (by their 1-based position in presentation
// order) out of a source .pptx into a new standalone deck, keeping every
// slide's original layout/master/theme/media untouched. Used to pull fixed
// slides (intro, 기도, 광고 title) out of the weekly service template so
// they can be spliced into the combined deck via mergePptxDecks.
import JSZip from 'jszip';
import { stripNonVisualParts } from './pptxPackage';

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Resolve a deck's slide filenames in presentation display order. */
async function slideOrderOf(zip: JSZip): Promise<string[]> {
  const presentation = await zip.file('ppt/presentation.xml')!.async('string');
  const rels = await zip.file('ppt/_rels/presentation.xml.rels')!.async('string');
  const section = presentation.match(/<p:sldIdLst>([\s\S]*?)<\/p:sldIdLst>/);
  if (!section) throw new Error('프레젠테이션에서 슬라이드 목록을 찾지 못했습니다.');
  const names: string[] = [];
  for (const m of section[1].matchAll(/r:id="(rId\d+)"/g)) {
    const target = rels.match(new RegExp(`Id="${m[1]}"[^>]*Target="slides/(slide\\d+\\.xml)"`));
    if (target) names.push(target[1]);
  }
  return names;
}

/**
 * Extract slides at the given 1-based positions (in presentation order,
 * duplicates allowed) into a new standalone .pptx, preserving each slide's
 * original layout/master/theme/media exactly, renumbered sequentially in
 * the order requested.
 */
export async function extractSlideSubset(
  templateData: ArrayBuffer | Uint8Array,
  slideNumbers: number[],
): Promise<Uint8Array> {
  if (slideNumbers.length === 0) throw new Error('추출할 슬라이드 번호가 없습니다.');

  const zip = await JSZip.loadAsync(templateData);
  await stripNonVisualParts(zip);
  const orderedNames = await slideOrderOf(zip);
  const keepNames = slideNumbers.map((n) => {
    const name = orderedNames[n - 1];
    if (!name) throw new Error(`템플릿에 ${n}번 슬라이드가 없습니다.`);
    return name;
  });

  // Read the kept slides' content into memory before mutating the zip —
  // a slide can be requested more than once (e.g. reusing one 기도 slide
  // design at two points), so we can't just rename files in place.
  const kept = await Promise.all(
    keepNames.map(async (name) => {
      const xml = await zip.file(`ppt/slides/${name}`)!.async('string');
      const relsFile = zip.file(`ppt/slides/_rels/${name}.rels`);
      const rels = relsFile ? await relsFile.async('string') : null;
      return { xml, rels };
    }),
  );

  let contentTypes = await zip.file('[Content_Types].xml')!.async('string');
  for (const name of orderedNames) {
    zip.remove(`ppt/slides/${name}`);
    zip.remove(`ppt/slides/_rels/${name}.rels`);
    contentTypes = contentTypes.replace(
      new RegExp(`<Override PartName="/ppt/slides/${escapeRegExp(name)}"[^>]*/>`),
      '',
    );
  }

  kept.forEach(({ xml, rels }, i) => {
    const n = i + 1;
    zip.file(`ppt/slides/slide${n}.xml`, xml);
    if (rels) zip.file(`ppt/slides/_rels/slide${n}.xml.rels`, rels);
    contentTypes = contentTypes.replace(
      '</Types>',
      `<Override PartName="/ppt/slides/slide${n}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/></Types>`,
    );
  });

  const presentationOrig = await zip.file('ppt/presentation.xml')!.async('string');
  let presRels = (await zip.file('ppt/_rels/presentation.xml.rels')!.async('string')).replace(
    /<Relationship[^>]*Type="[^"]*\/relationships\/slide"[^>]*\/>/g,
    '',
  );
  const sldIds: string[] = [];
  kept.forEach((_, i) => {
    const n = i + 1;
    const rid = `rIdSlice${n}`;
    presRels = presRels.replace(
      '</Relationships>',
      `<Relationship Id="${rid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${n}.xml"/></Relationships>`,
    );
    sldIds.push(`<p:sldId id="${900000 + n}" r:id="${rid}"/>`);
  });
  const presentation = presentationOrig.replace(
    /<p:sldIdLst>[\s\S]*?<\/p:sldIdLst>/,
    `<p:sldIdLst>${sldIds.join('')}</p:sldIdLst>`,
  );

  zip.file('[Content_Types].xml', contentTypes);
  zip.file('ppt/presentation.xml', presentation);
  zip.file('ppt/_rels/presentation.xml.rels', presRels);

  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
}
