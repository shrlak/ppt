// Builds a Bible-verse .pptx by substituting {{PLACEHOLDER}} tokens directly
// in the uploaded/bundled template's slide XML. Ported from kccp-bible-slide's
// src/lib/generate-pptx.ts, adapted from Node Buffer to browser Uint8Array.
import JSZip from 'jszip';
import type { VerseSlideData } from './types';
import type { VerseSlidePlan } from './versePlanner';
import { stripNonVisualParts } from '../lib/pptxPackage';

const PLACEHOLDERS: Record<string, string> = {
  title: '{{TITLE}}',
  etitle: '{{ETITLE}}',
  chapter: '{{CHAP}}',
  verse: '{{PARA}}',
  rangeKo: '{{RANGE_KO}}',
  rangeEn: '{{RANGE_EN}}',
  sermonTitle: '{{SERMON_TITLE}}',
  body: '{{BODY}}',
  body1: '{{BODY1}}',
  body2: '{{BODY2}}',
  body3: '{{BODY3}}',
};

function escapeXml(t: string): string {
  return t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function cleanText(t: string): string {
  return t
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/\s+([?!.,;:)])/g, '$1')
    .replace(/([(])\s+/g, '$1')
    .trim();
}

function doReplace(xml: string, data: VerseSlideData): string {
  const clean: Record<string, string> = {};
  for (const [k, v] of Object.entries(data)) {
    if (v !== undefined) clean[k] = escapeXml(cleanText(String(v)));
  }

  let out = xml;
  for (const [key, placeholder] of Object.entries(PLACEHOLDERS)) {
    // Use `key in clean` rather than a truthy check so optional fields left
    // blank (e.g. no sermon title) clear the placeholder instead of leaving
    // the literal "{{...}}" text visible on the slide.
    if (key in clean && out.includes(placeholder)) out = out.replaceAll(placeholder, clean[key]);
  }

  // A placeholder can be split across multiple <a:t> runs by PowerPoint's spell-check
  // splitting; collapse each paragraph's runs to find + replace across run boundaries.
  out = out.replace(/<a:p\b[\s\S]*?<\/a:p>/g, (para) => {
    const runRe = /(<a:t[^>]*>)([\s\S]*?)(<\/a:t>)/g;
    const matches = [...para.matchAll(runRe)];
    if (matches.length === 0) return para;
    const full = matches.map((m) => m[2]).join('');
    let next = full;
    let found = false;
    for (const [key, placeholder] of Object.entries(PLACEHOLDERS)) {
      if (key in clean && next.includes(placeholder)) {
        next = next.replaceAll(placeholder, clean[key]);
        found = true;
      }
    }
    if (!found) return para;
    let result = para;
    for (let i = 0; i < matches.length; i++) {
      result = result.replace(matches[i][0], i === 0 ? `${matches[i][1]}${next}${matches[i][3]}` : `${matches[i][1]}${matches[i][3]}`);
    }
    return result;
  });

  return out;
}

function isVerseSlide(xml: string): boolean {
  if (xml.includes('{{BODY}}')) return true;
  const shapes = xml.match(/<p:sp\b[\s\S]*?<\/p:sp>/g) || [];
  for (const shape of shapes) {
    const text = [...shape.matchAll(/<a:t[^>]*>([\s\S]*?)<\/a:t>/g)].map((m) => m[1]).join('');
    if (text.includes('{{BODY}}')) return true;
  }
  return false;
}

/**
 * Generate the deck: every slide containing {{BODY}} is treated as the
 * per-verse template and repeated once per planned verse slide; every other
 * slide (title/sermon/etc.) gets the plan's globalData substituted once.
 */
export async function buildBiblePptx(
  templateData: ArrayBuffer | Uint8Array,
  plan: VerseSlidePlan,
): Promise<Uint8Array> {
  const { globalData, verseSlides } = plan;
  const zip = await JSZip.loadAsync(templateData);
  await stripNonVisualParts(zip);

  const slideFiles = Object.keys(zip.files)
    .filter((f) => /^ppt\/slides\/slide\d+\.xml$/.test(f))
    .sort((a, b) => parseInt(a.match(/\d+/)![0], 10) - parseInt(b.match(/\d+/)![0], 10));
  if (slideFiles.length === 0) throw new Error('템플릿에 슬라이드가 없습니다.');

  const presXml = await zip.file('ppt/presentation.xml')!.async('string');
  const relsXml = await zip.file('ppt/_rels/presentation.xml.rels')!.async('string');

  const ordered: string[] = [];
  const sldIdSection = presXml.match(/<p:sldIdLst>([\s\S]*?)<\/p:sldIdLst>/);
  if (sldIdSection) {
    for (const m of sldIdSection[1].matchAll(/r:id="(rId\d+)"/g)) {
      const target = relsXml.match(new RegExp(`Id="${m[1]}"[^>]*Target="slides/(slide\\d+\\.xml)"`));
      if (target) ordered.push(target[1]);
    }
  }
  const slideOrder = ordered.length > 0 ? ordered : slideFiles.map((f) => f.split('/').pop()!);

  const xmlByName = new Map<string, string>();
  let verseTemplateName: string | null = null;
  for (const name of slideOrder) {
    const xml = await zip.file(`ppt/slides/${name}`)!.async('string');
    xmlByName.set(name, xml);
    if (isVerseSlide(xml)) verseTemplateName = name;
  }
  if (!verseTemplateName) verseTemplateName = slideOrder[slideOrder.length - 1];

  let contentTypes = await zip.file('[Content_Types].xml')!.async('string');
  let presentation = presXml;
  let presRels = relsXml;

  const existingNums = slideFiles.map((f) => parseInt(f.match(/\d+/)![0], 10));
  let nextNum = Math.max(...existingNums) + 1;
  let nextRid = Math.max(...[...presRels.matchAll(/rId(\d+)/g)].map((m) => parseInt(m[1], 10))) + 1;
  const slideIdSection = presentation.match(/<p:sldIdLst>([\s\S]*?)<\/p:sldIdLst>/)?.[1] ?? '';
  let nextSid = Math.max(255, ...[...slideIdSection.matchAll(/<p:sldId\b[^>]*id="(\d+)"/g)].map((m) => parseInt(m[1], 10))) + 1;

  const getRels = async (name: string): Promise<string | null> => {
    const path = `ppt/slides/_rels/${name}.rels`;
    if (!zip.file(path)) return null;
    return (await zip.file(path)!.async('string')).replace(/<Relationship[^>]*notesSlide[^>]*\/>/g, '');
  };

  const addSlide = (xml: string, rels: string | null) => {
    const name = `slide${nextNum}.xml`;
    zip.file(`ppt/slides/${name}`, xml);
    if (rels) zip.file(`ppt/slides/_rels/${name}.rels`, rels);
    contentTypes = contentTypes.replace(
      '</Types>',
      `<Override PartName="/ppt/slides/${name}" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/></Types>`,
    );
    presRels = presRels.replace(
      '</Relationships>',
      `<Relationship Id="rId${nextRid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/${name}"/></Relationships>`,
    );
    presentation = presentation.replace('</p:sldIdLst>', `<p:sldId id="${nextSid}" r:id="rId${nextRid}"/></p:sldIdLst>`);
    nextNum++;
    nextRid++;
    nextSid++;
  };

  const removeSlide = (name: string) => {
    const escaped = name.replace('.', '\\.');
    const relMatch = presRels.match(new RegExp(`Id="(rId\\d+)"[^>]*Target="slides/${escaped}"`));
    if (relMatch) {
      presentation = presentation.replace(new RegExp(`<p:sldId[^>]*r:id="${relMatch[1]}"[^>]*/>`), '');
      presRels = presRels.replace(new RegExp(`<Relationship[^>]*Id="${relMatch[1]}"[^>]*/>`), '');
    }
    for (const path of [`ppt/slides/${name}`, `ppt/slides/_rels/${name}.rels`]) {
      if (zip.file(path)) zip.remove(path);
    }
    contentTypes = contentTypes.replace(new RegExp(`<Override[^>]*/ppt/slides/${escaped}[^>]*/>`), '');
  };

  for (const name of slideOrder) {
    const xml = xmlByName.get(name)!;
    const rels = await getRels(name);
    if (name === verseTemplateName) {
      for (const slideData of verseSlides) addSlide(doReplace(xml, slideData), rels);
    } else {
      addSlide(doReplace(xml, globalData), rels);
    }
  }
  for (const name of slideOrder) removeSlide(name);

  zip.file('[Content_Types].xml', contentTypes);
  zip.file('ppt/_rels/presentation.xml.rels', presRels);
  zip.file('ppt/presentation.xml', presentation);

  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
}

export function suggestBibleFileName(): string {
  const date = new Date().toISOString().slice(0, 10);
  return `KCCP_말씀슬라이드_${date}.pptx`;
}
