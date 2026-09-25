// Derives public/praise-template.pptx and public/praise-english.json from a
// real 찬양집회 deck (the 2025 EM & KM Praise Night file).
//
// The 찬양집회 generator draws nothing of its own: the cover, the song title
// slide, the bilingual lyrics slide and the 기도 slide are that deck's own
// slides, kept with their master, layouts, embedded Nanum Gothic fonts and
// background photos. This script keeps those four designs, replaces that
// night's wording with {{TOKEN}} placeholders, and drops everything else
// (every other slide, the speaker notes, and the media only they used).
//
// The cover photo has the event date painted into the image itself
// ("09/27/2025"), so the cover also gets a mask the colour of the photo's
// background over that date and a {{COVER_DATE}} text box on top of it — each
// year's deck then carries its own date without anyone editing the picture.
//
// Alongside the template it writes the English lyrics that deck already
// paired with each Korean slide, so a song sung last year comes back
// bilingual without typing the English again (see src/praise/englishLibrary.ts).
//
//   node scripts/prepare-praise-template.mjs <찬양집회.pptx>
//
// The source deck itself is not committed: it is a real service file.
import { readFile, writeFile } from 'node:fs/promises';
import { posix, resolve } from 'node:path';
import JSZip from 'jszip';

const SLIDE_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.presentationml.slide+xml';

/** Slides to keep, in the order src/praise/template.ts numbers them. */
const KEPT_SLIDES = [
  { source: 1, role: '표지' },
  { source: 2, role: '곡 제목' },
  { source: 3, role: '가사' },
  { source: 31, role: '기도' },
];

const TOKEN_RULES = {
  2: [
    { text: '춤추는 세대', token: '{{TITLE_KO}}' },
    { text: 'Dancing Generation', token: '{{TITLE_EN}}' },
  ],
  3: [
    { text: '춤추는 세대 | Dancing Generation', token: '{{HEADER}}' },
    // One lyric paragraph is the pattern every line (and the spacer between
    // the Korean and the English) is cloned from; the rest are dropped.
    { text: '주 자비 춤추게 하네', token: '{{LINE}}', keepFollowing: 0 },
  ],
};

/**
 * The date painted on the cover photo, in EMU. Measured off the 1024×768
 * image: the digits span x 380–628, y 681–702 px, on a flat #010C05
 * background (8929.6875 EMU per px on a 9144000-wide slide). The mask is a
 * little larger than the digits so no anti-aliased edge shows around it.
 */
const COVER_DATE_BOX = { x: 2946797, y: 5929313, cx: 3250406, cy: 500062 };
const COVER_BACKGROUND = '010C05';

const DISCARD_PREFIXES = ['ppt/notesSlides/', 'ppt/notesMasters/', 'ppt/comments/'];
const DISCARD_PARTS = ['ppt/commentAuthors.xml', 'docProps/thumbnail.jpeg', 'ppt/metadata'];
const DISCARD_REL_TYPES = ['notesSlide', 'notesMaster', 'comments', 'commentAuthors', 'thumbnail', 'presentationmetadata'];

function xmlEscape(value) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function decodeXml(value) {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function collapse(value) {
  return value.replace(/\s+/g, ' ').trim();
}

function paragraphText(paragraphXml) {
  let text = '';
  for (const run of paragraphXml.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)) text += decodeXml(run[1]);
  return text;
}

function tokenizeParagraph(paragraphXml, token) {
  const firstRun = paragraphXml.match(/<a:r>[\s\S]*?<\/a:r>/);
  if (!firstRun) throw new Error('문단에 run이 없습니다.');
  const runProps = firstRun[0].match(/<a:rPr\b[^>]*\/>|<a:rPr\b[\s\S]*?<\/a:rPr>/)?.[0] ?? '';
  const paraProps = paragraphXml.match(/<a:pPr\b[^>]*\/>|<a:pPr\b[\s\S]*?<\/a:pPr>/)?.[0] ?? '';
  const endProps = paragraphXml.match(/<a:endParaRPr\b[^>]*\/>|<a:endParaRPr\b[\s\S]*?<\/a:endParaRPr>/)?.[0] ?? '';
  return `<a:p>${paraProps}<a:r>${runProps}<a:t>${xmlEscape(token)}</a:t></a:r>${endProps}</a:p>`;
}

const PARAGRAPH = /<a:p>[\s\S]*?<\/a:p>|<a:p\/>/g;
const SHAPE = /<p:sp>[\s\S]*?<\/p:sp>/g;

function applyTokenRules(slideXml, rules) {
  let out = slideXml;
  const applied = new Set();
  for (const shape of [...slideXml.matchAll(SHAPE)].reverse()) {
    const shapeXml = shape[0];
    const paragraphs = [...shapeXml.matchAll(PARAGRAPH)];
    if (paragraphs.length === 0) continue;
    const matched = paragraphs.map((paragraph) =>
      rules.find((rule) => collapse(paragraphText(paragraph[0])) === collapse(rule.text)),
    );
    if (matched.every((rule) => !rule)) continue;

    const trimAt = matched.findIndex((rule) => rule?.keepFollowing !== undefined);
    let rebuilt;
    if (trimAt >= 0) {
      const rule = matched[trimAt];
      applied.add(rule.token);
      rebuilt = [
        tokenizeParagraph(paragraphs[trimAt][0], rule.token),
        ...paragraphs.slice(trimAt + 1, trimAt + 1 + rule.keepFollowing).map((p) => p[0]),
      ].join('');
    } else {
      rebuilt = paragraphs
        .map((paragraph, index) => {
          const rule = matched[index];
          if (!rule) return paragraph[0];
          applied.add(rule.token);
          return tokenizeParagraph(paragraph[0], rule.token);
        })
        .join('');
    }
    const first = paragraphs[0].index;
    const last = paragraphs[paragraphs.length - 1];
    const newShapeXml = shapeXml.slice(0, first) + rebuilt + shapeXml.slice(last.index + last[0].length);
    out = out.slice(0, shape.index) + newShapeXml + out.slice(shape.index + shapeXml.length);
  }
  return { xml: out, applied };
}

/** The mask and the {{COVER_DATE}} box laid over the date in the cover photo. */
function coverDateShapes() {
  const { x, y, cx, cy } = COVER_DATE_BOX;
  const xfrm = `<a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>`;
  const mask =
    `<p:sp><p:nvSpPr><p:cNvPr id="9001" name="PraiseCoverDateMask"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>` +
    `<p:spPr>${xfrm}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>` +
    `<a:solidFill><a:srgbClr val="${COVER_BACKGROUND}"/></a:solidFill><a:ln><a:noFill/></a:ln></p:spPr>` +
    `<p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:endParaRPr lang="en-US"/></a:p></p:txBody></p:sp>`;
  const date =
    `<p:sp><p:nvSpPr><p:cNvPr id="9002" name="PraiseCoverDate"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>` +
    `<p:spPr>${xfrm}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/><a:ln><a:noFill/></a:ln></p:spPr>` +
    `<p:txBody><a:bodyPr wrap="none" lIns="0" tIns="0" rIns="0" bIns="0" anchor="ctr" anchorCtr="0"><a:noAutofit/></a:bodyPr>` +
    `<a:lstStyle/><a:p><a:pPr algn="ctr"><a:buNone/></a:pPr>` +
    `<a:r><a:rPr lang="en-US" sz="2000" spc="600"><a:solidFill><a:srgbClr val="F2F2F2"/></a:solidFill>` +
    `<a:latin typeface="Georgia"/><a:ea typeface="Georgia"/><a:cs typeface="Georgia"/></a:rPr>` +
    `<a:t>{{COVER_DATE}}</a:t></a:r></a:p></p:txBody></p:sp>`;
  return mask + date;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function removeContentTypeOverride(contentTypes, partPath) {
  const name = partPath.startsWith('/') ? partPath : `/${partPath}`;
  return contentTypes.replace(new RegExp(`<Override[^>]*PartName="${escapeRegExp(name)}"[^>]*/>`, 'g'), '');
}

function setContentTypeOverride(contentTypes, partPath, contentType) {
  return removeContentTypeOverride(contentTypes, partPath).replace(
    '</Types>',
    `<Override PartName="/${partPath}" ContentType="${contentType}"/></Types>`,
  );
}

function stripRelationships(relsXml) {
  let out = relsXml;
  for (const kind of DISCARD_REL_TYPES) {
    out = out.replace(new RegExp(`<Relationship[^>]*Type="[^"]*/${kind}"[^>]*/>`, 'g'), '');
  }
  return out;
}

function relsPathFor(partPath) {
  const dir = posix.dirname(partPath);
  return `${dir === '.' ? '' : `${dir}/`}_rels/${posix.basename(partPath)}.rels`;
}

async function pruneUnreachableParts(zip, contentTypes) {
  const reachable = new Set(['[Content_Types].xml', '_rels/.rels']);
  const queue = ['_rels/.rels'];
  while (queue.length > 0) {
    const relsPath = queue.shift();
    const file = zip.file(relsPath);
    if (!file) continue;
    const xml = await file.async('string');
    const base = posix.dirname(posix.dirname(relsPath));
    for (const match of xml.matchAll(/<Relationship\b[^>]*>/g)) {
      const tag = match[0];
      if (/TargetMode="External"/.test(tag)) continue;
      const target = tag.match(/Target="([^"]+)"/)?.[1];
      if (!target || /^[a-z]+:/i.test(target)) continue;
      const resolved = target.startsWith('/')
        ? target.slice(1)
        : posix.normalize(posix.join(base === '.' ? '' : base, target));
      if (reachable.has(resolved)) continue;
      reachable.add(resolved);
      const childRels = relsPathFor(resolved);
      if (zip.file(childRels)) {
        reachable.add(childRels);
        queue.push(childRels);
      }
    }
  }
  let out = contentTypes;
  const removed = [];
  for (const path of Object.keys(zip.files)) {
    if (zip.files[path].dir || reachable.has(path)) continue;
    zip.remove(path);
    out = removeContentTypeOverride(out, path);
    removed.push(path);
  }
  return { contentTypes: out, removed };
}

async function slideOrderOf(zip) {
  const presentation = await zip.file('ppt/presentation.xml').async('string');
  const rels = await zip.file('ppt/_rels/presentation.xml.rels').async('string');
  const section = presentation.match(/<p:sldIdLst>([\s\S]*?)<\/p:sldIdLst>/);
  if (!section) throw new Error('원본에서 슬라이드 목록을 찾지 못했습니다.');
  const names = [];
  for (const match of section[1].matchAll(/r:id="([^"]+)"/g)) {
    const target = rels.match(new RegExp(`Id="${escapeRegExp(match[1])}"[^>]*Target="slides/(slide\\d+\\.xml)"`));
    if (!target) throw new Error(`${match[1]} 관계를 찾지 못했습니다.`);
    names.push(target[1]);
  }
  return names;
}

async function readTokenizedSlide(zip, name, rules, label) {
  const xml = await zip.file(`ppt/slides/${name}`).async('string');
  const relsFile = zip.file(`ppt/slides/_rels/${name}.rels`);
  const { xml: tokenized, applied } = applyTokenRules(xml, rules);
  const missing = rules.filter((rule) => !applied.has(rule.token));
  if (missing.length > 0) {
    throw new Error(`${label}에서 찾지 못한 문구: ${missing.map((rule) => rule.text).join(' / ')}`);
  }
  return { xml: tokenized, rels: relsFile ? stripRelationships(await relsFile.async('string')) : null };
}

async function writeDeck(zip, slides, outputPath) {
  let contentTypes = await zip.file('[Content_Types].xml').async('string');
  for (const name of await slideOrderOf(zip)) {
    zip.remove(`ppt/slides/${name}`);
    zip.remove(`ppt/slides/_rels/${name}.rels`);
    contentTypes = removeContentTypeOverride(contentTypes, `ppt/slides/${name}`);
  }
  for (const path of Object.keys(zip.files)) {
    if (zip.files[path].dir) continue;
    if (DISCARD_PARTS.includes(path) || DISCARD_PREFIXES.some((prefix) => path.startsWith(prefix))) {
      zip.remove(path);
      contentTypes = removeContentTypeOverride(contentTypes, path);
    }
  }
  slides.forEach(({ xml, rels }, index) => {
    const n = index + 1;
    zip.file(`ppt/slides/slide${n}.xml`, xml);
    if (rels) zip.file(`ppt/slides/_rels/slide${n}.xml.rels`, rels);
    contentTypes = setContentTypeOverride(contentTypes, `ppt/slides/slide${n}.xml`, SLIDE_CONTENT_TYPE);
  });

  const packageRels = zip.file('_rels/.rels');
  if (packageRels) zip.file('_rels/.rels', stripRelationships(await packageRels.async('string')));

  let presRels = stripRelationships(
    (await zip.file('ppt/_rels/presentation.xml.rels').async('string')).replace(
      /<Relationship[^>]*Type="[^"]*\/relationships\/slide"[^>]*\/>/g,
      '',
    ),
  );
  const sldIds = [];
  slides.forEach((_, index) => {
    const n = index + 1;
    const rid = `rId${900 + n}`;
    presRels = presRels.replace(
      '</Relationships>',
      `<Relationship Id="${rid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${n}.xml"/></Relationships>`,
    );
    sldIds.push(`<p:sldId id="${256 + n}" r:id="${rid}"/>`);
  });
  const presentation = (await zip.file('ppt/presentation.xml').async('string'))
    .replace(/<p:sldIdLst>[\s\S]*?<\/p:sldIdLst>/, `<p:sldIdLst>${sldIds.join('')}</p:sldIdLst>`)
    .replace(/<p:notesMasterIdLst>[\s\S]*?<\/p:notesMasterIdLst>/, '')
    .replace(/<p:notesMasterIdLst\s*\/>/, '')
    // Google Slides' round-trip marker points at ppt/metadata, dropped above.
    .replace(/<p:ext uri="GoogleSlidesCustomDataVersion2">[\s\S]*?<\/p:ext>/, '');
  zip.file('ppt/presentation.xml', presentation);
  zip.file('ppt/_rels/presentation.xml.rels', presRels);

  const pruned = await pruneUnreachableParts(zip, contentTypes);
  zip.file('[Content_Types].xml', pruned.contentTypes);
  const bytes = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  await writeFile(outputPath, bytes);
  return { bytes, removed: pruned.removed };
}

// ---- English lyrics seed ------------------------------------------------

const HANGUL = /[가-힣ㄱ-ㆎ]/;

/** Every text shape on a slide: whether it is the title placeholder, and its paragraphs. */
function slideShapes(xml) {
  return [...xml.matchAll(SHAPE)].map((shape) => ({
    isTitle: /<p:ph type="(?:title|ctrTitle)"/.test(shape[0]),
    paragraphs: [...shape[0].matchAll(PARAGRAPH)].map((p) => paragraphText(p[0]).replace(/\s+$/, '')),
  }));
}

/**
 * A song's title slide carries only the (one- or two-line) title; a lyric
 * slide carries a header naming that title plus a body. Anything else — the
 * sermon, 말씀 and 기도 slides between sets — ends the current song.
 */
function readSongs(slideXmls) {
  const songs = [];
  let current = null;
  for (const xml of slideXmls) {
    if (/<p:pic>/.test(xml) || /r:embed=/.test(xml.split('<p:spTree>')[0] ?? '')) {
      current = null;
      continue;
    }
    const shapes = slideShapes(xml).filter((shape) => shape.paragraphs.some((p) => p.trim()));
    if (shapes.length === 1 && shapes[0].paragraphs.filter((p) => p.trim()).length <= 2) {
      const [ko, en] = shapes[0].paragraphs.filter((p) => p.trim()).map((p) => p.trim());
      current = { title: ko, englishTitle: en && en !== ko ? en : '', slides: [] };
      songs.push(current);
      continue;
    }
    if (!current || shapes.length !== 2) {
      current = null;
      continue;
    }
    const header = shapes.find(
      (shape) =>
        shape.paragraphs.filter((p) => p.trim()).length === 1 &&
        (shape.paragraphs[0].trim() === current.title || shape.paragraphs[0].trim().startsWith(`${current.title} |`)),
    );
    const body = shapes.find((shape) => shape !== header);
    if (!header || !body) {
      current = null;
      continue;
    }
    const lines = body.paragraphs.map((p) => p.trim());
    const blank = lines.findIndex((line, index) => line === '' && index > 0 && lines.slice(index).some(Boolean));
    let ko;
    let en;
    if (blank > 0 && lines.slice(0, blank).some((l) => HANGUL.test(l)) && !lines.slice(blank).some((l) => HANGUL.test(l))) {
      ko = lines.slice(0, blank).filter(Boolean);
      en = lines.slice(blank + 1).filter(Boolean);
    } else if (lines.some((l) => HANGUL.test(l))) {
      ko = lines.filter(Boolean);
      en = [];
    } else {
      ko = [];
      en = lines.filter(Boolean);
    }
    current.slides.push({ ko, en });
  }
  return songs.filter((song) => song.slides.length > 0);
}

async function buildSeed(zip, order) {
  const xmls = [];
  for (const name of order) xmls.push(await zip.file(`ppt/slides/${name}`).async('string'));
  // A song sung twice in one night is remembered once.
  const byTitle = new Map();
  for (const song of readSongs(xmls)) {
    if (!byTitle.has(song.title)) byTitle.set(song.title, song);
  }
  return [...byTitle.values()];
}

async function main() {
  const [sourcePath] = process.argv.slice(2);
  if (!sourcePath) throw new Error('사용법: node scripts/prepare-praise-template.mjs <찬양집회.pptx>');
  const source = await readFile(sourcePath);

  const seedZip = await JSZip.loadAsync(source);
  const seed = await buildSeed(seedZip, await slideOrderOf(seedZip));
  const seedPath = resolve('public/praise-english.json');
  await writeFile(seedPath, `${JSON.stringify(seed, null, 2)}\n`);
  console.log(`${seedPath}: ${seed.length}곡`);
  for (const song of seed) {
    console.log(`  ${song.title}${song.englishTitle ? ` | ${song.englishTitle}` : ''} (${song.slides.length}장)`);
  }

  const zip = await JSZip.loadAsync(source);
  const order = await slideOrderOf(zip);
  const slides = [];
  for (const { source: position, role } of KEPT_SLIDES) {
    const name = order[position - 1];
    if (!name) throw new Error(`원본에 ${position}번 슬라이드가 없습니다.`);
    const slide = await readTokenizedSlide(zip, name, TOKEN_RULES[position] ?? [], `${position}번 슬라이드(${role})`);
    if (position === 1) slide.xml = slide.xml.replace('</p:spTree>', `${coverDateShapes()}</p:spTree>`);
    slides.push(slide);
    console.log(`  ${String(position).padStart(3)}번 → ${role}`);
  }
  const output = resolve('public/praise-template.pptx');
  const { bytes, removed } = await writeDeck(zip, slides, output);
  console.log(`  쓰이지 않는 파트 ${removed.length}개 제거`);
  console.log(`${output} (${slides.length}장, ${(bytes.length / 1024 / 1024).toFixed(1)}MB)`);
}

await main();
