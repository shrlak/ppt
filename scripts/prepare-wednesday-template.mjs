// Derives public/wednesday-template.pptx and public/wednesday-thumbnail.pptx
// from the real 수요예배 decks.
//
// The Wednesday generator does not draw its own slides: every fixed slide
// (표지, 인트로, 경배와 찬양, 찬양 제목, 기도, 말씀, 설교, 합심기도, 마지막) is a
// slide out of an actual service deck, kept with its own master, layout, theme
// and media. This script keeps the distinct designs, replaces that week's
// wording with {{TOKEN}} placeholders (the convention
// public/bible-template.pptx already uses) and drops every part the kept
// slides do not use — which is most of the source deck's weight, since 23 of
// its 32 media parts are that week's 악보 pages.
//
// It is a one-off, and the two source decks are deliberately NOT committed:
// they are real service files, and their 악보 page images are copyrighted
// sheet music this repository does not carry (see the CI guard in
// .github/workflows/ci.yml). The script is committed so the assets can be
// rebuilt, or re-derived when the church changes the design:
//
//   node scripts/prepare-wednesday-template.mjs <service.pptx> [thumbnail.pptx]
//
// Text in PowerPoint is split across runs wherever the author's IME or the
// spell checker broke it ("2026" / "년 " / "9" / "월 "), so a placeholder can
// never be a plain string replacement in the source XML. Each rule below
// matches a *paragraph* by its assembled text and rewrites that paragraph down
// to a single run carrying the token, keeping the first run's formatting.
import { readFile, writeFile } from 'node:fs/promises';
import { posix, resolve } from 'node:path';
import JSZip from 'jszip';

const SLIDE_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.presentationml.slide+xml';

/**
 * Slides to keep, in the order the generated deck uses them, identified by
 * their 1-based position in the source deck's presentation order.
 *
 * 찬양 제목 comes from the source's slide 9 rather than slide 4: both carry the
 * same design, but slide 9's title box is the wide one (12420600 EMU vs
 * 8505855), so long song titles still fit on one line.
 */
const KEPT_SLIDES = [
  { source: 1, role: '표지' },
  { source: 2, role: '수요예배 인트로' },
  { source: 3, role: '경배와 찬양' },
  { source: 9, role: '찬양 제목' },
  { source: 31, role: '기도' },
  { source: 32, role: '말씀 divider' },
  { source: 33, role: '말씀 본문' },
  { source: 37, role: '설교 divider' },
  { source: 38, role: '기도' },
  { source: 39, role: '합심기도' },
  { source: 40, role: '마지막' },
];

/** The 표지's placeholders, shared by the service deck's slide 1 and the 썸네일. */
const COVER_RULES = [
  { text: '2026년 9월 16일', token: '{{DATE_KO}}' },
  { text: '나의 힘이 되신 여호와여', token: '{{SERMON_TITLE}}' },
  { text: '시편 18편 1-12절', token: '{{RANGE_KO}}' },
  { text: '고신석', token: '{{PREACHER}}' },
  { text: '목사', token: '{{PREACHER_TITLE}}' },
];

/**
 * Paragraph rewrites per source slide. `text` is the paragraph's assembled
 * text (whitespace-collapsed); `token` replaces it entirely.
 *
 * `keepFollowing` trims the shape down to the matched paragraph plus that many
 * paragraphs after it, dropping the rest. The 말씀 본문 body holds three verses
 * separated by empty spacer paragraphs (verse paragraphs are 100% line
 * spacing, spacers 120%); the verse builder clones both, so the template keeps
 * exactly one of each.
 */
const TOKEN_RULES = {
  1: COVER_RULES,
  2: [{ text: '2026. 9. 16', token: '{{DATE_DOT}}' }],
  9: [{ text: '하늘 위에 주님 밖에', token: '{{SONG_TITLE}}' }],
  32: [{ text: '시편 18편 1-12절', token: '{{RANGE_KO}}' }],
  33: [
    { text: '말 씀 (시편 18편 1-12절)', token: '말 씀 ({{RANGE_KO}})' },
    {
      text: '1 나의 힘이신 여호와여 내가 주를 사랑하나이다',
      token: '{{BODY}}',
      keepFollowing: 1,
    },
  ],
  37: [
    { text: '시편 18편 1-12절', token: '{{RANGE_KO}}' },
    { text: '나의 힘이 되신 여호와여', token: '{{SERMON_TITLE}}' },
    { text: '고 신 석 목사', token: '{{PREACHER_LINE}}' },
  ],
};

/** Parts that carry no slide content and would only drag along dangling relationships. */
const DISCARD_PREFIXES = ['ppt/notesSlides/', 'ppt/notesMasters/', 'ppt/comments/'];
const DISCARD_PARTS = ['ppt/commentAuthors.xml', 'docProps/thumbnail.jpeg'];
const DISCARD_REL_TYPES = ['notesSlide', 'notesMaster', 'comments', 'commentAuthors', 'thumbnail'];

function xmlEscape(value) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function collapse(value) {
  return value.replace(/\s+/g, ' ').trim();
}

/** The text a paragraph renders, assembled from its runs. */
function paragraphText(paragraphXml) {
  let text = '';
  for (const run of paragraphXml.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)) {
    text += run[1]
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&amp;/g, '&');
  }
  return text;
}

/** Rewrite a paragraph down to one run holding `token`, keeping its formatting. */
function tokenizeParagraph(paragraphXml, token) {
  const firstRun = paragraphXml.match(/<a:r>[\s\S]*?<\/a:r>/);
  if (!firstRun) throw new Error('문단에 run이 없습니다.');
  const runProps = firstRun[0].match(/<a:rPr\b[^>]*\/>|<a:rPr\b[\s\S]*?<\/a:rPr>/)?.[0] ?? '';
  const paraProps = paragraphXml.match(/<a:pPr\b[^>]*\/>|<a:pPr\b[\s\S]*?<\/a:pPr>/)?.[0] ?? '';
  return `<a:p>${paraProps}<a:r>${runProps}<a:t>${xmlEscape(token)}</a:t></a:r></a:p>`;
}

const PARAGRAPH = /<a:p>[\s\S]*?<\/a:p>|<a:p\/>/g;

/** Apply one slide's token rules, shape by shape, and report which matched. */
function applyTokenRules(slideXml, rules) {
  let out = slideXml;
  const applied = new Set();

  // Shapes right to left so each rewrite leaves earlier offsets valid.
  for (const shape of [...slideXml.matchAll(/<p:sp>[\s\S]*?<\/p:sp>/g)].reverse()) {
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
      const kept = [
        tokenizeParagraph(paragraphs[trimAt][0], rule.token),
        ...paragraphs.slice(trimAt + 1, trimAt + 1 + rule.keepFollowing).map((p) => p[0]),
      ];
      applied.add(rule.token);
      // Other rules in the same shape still apply to the paragraphs we keep.
      rebuilt = kept.join('');
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
    const newShapeXml =
      shapeXml.slice(0, first) + rebuilt + shapeXml.slice(last.index + last[0].length);
    out = out.slice(0, shape.index) + newShapeXml + out.slice(shape.index + shapeXml.length);
  }

  return { xml: out, applied };
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function removeContentTypeOverride(contentTypes, partPath) {
  const name = partPath.startsWith('/') ? partPath : `/${partPath}`;
  return contentTypes.replace(
    new RegExp(`<Override[^>]*PartName="${escapeRegExp(name)}"[^>]*/>`, 'g'),
    '',
  );
}

function setContentTypeOverride(contentTypes, partPath, contentType) {
  return removeContentTypeOverride(contentTypes, partPath).replace(
    '</Types>',
    `<Override PartName="/${partPath}" ContentType="${contentType}"/></Types>`,
  );
}

/** Drop relationship entries of the given types from a .rels document. */
function stripRelationships(relsXml) {
  let out = relsXml;
  for (const kind of DISCARD_REL_TYPES) {
    // Relationship types differ in their namespace path — a thumbnail's is
    // ".../package/2006/relationships/metadata/thumbnail" — so match on the
    // last segment rather than a fixed prefix.
    out = out.replace(new RegExp(`<Relationship[^>]*Type="[^"]*/${kind}"[^>]*/>`, 'g'), '');
  }
  return out;
}

function relsPathFor(partPath) {
  const dir = posix.dirname(partPath);
  return `${dir === '.' ? '' : `${dir}/`}_rels/${posix.basename(partPath)}.rels`;
}

/**
 * Remove every part the package can no longer reach. The source deck's 악보
 * page images (23 of its 32 media parts) become unreachable as soon as the
 * song slides are dropped, and `extractSlideSubset` never prunes, so anything
 * left here would ride along in every generated deck.
 */
async function pruneUnreachableParts(zip, contentTypes) {
  const reachable = new Set(['[Content_Types].xml', '_rels/.rels']);
  const queue = ['_rels/.rels'];

  while (queue.length > 0) {
    const relsPath = queue.shift();
    const file = zip.file(relsPath);
    if (!file) continue;
    const xml = await file.async('string');
    const base = posix.dirname(posix.dirname(relsPath)); // strip "_rels"
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
    if (zip.files[path].dir) continue;
    if (reachable.has(path)) continue;
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
    const target = rels.match(
      new RegExp(`Id="${escapeRegExp(match[1])}"[^>]*Target="slides/(slide\\d+\\.xml)"`),
    );
    if (!target) throw new Error(`${match[1]} 관계를 찾지 못했습니다.`);
    names.push(target[1]);
  }
  return names;
}

/** Read a slide out of the source, applying its token rules. */
async function readTokenizedSlide(zip, name, rules, label) {
  const xml = await zip.file(`ppt/slides/${name}`).async('string');
  const relsFile = zip.file(`ppt/slides/_rels/${name}.rels`);
  const { xml: tokenized, applied } = applyTokenRules(xml, rules);
  const missing = rules.filter((rule) => !applied.has(rule.token));
  if (missing.length > 0) {
    throw new Error(`${label}에서 찾지 못한 문구: ${missing.map((rule) => rule.text).join(' / ')}`);
  }
  return {
    xml: tokenized,
    rels: relsFile ? stripRelationships(await relsFile.async('string')) : null,
  };
}

/** Rebuild a package around the given slides, then prune and write it. */
async function writeDeck(zip, slides, outputPath) {
  let contentTypes = await zip.file('[Content_Types].xml').async('string');
  const order = await slideOrderOf(zip);

  for (const name of order) {
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

  // The package-level rels point at docProps/thumbnail.jpeg, which is dropped
  // above; leaving the relationship behind would fail the integrity check.
  const packageRels = zip.file('_rels/.rels');
  if (packageRels) zip.file('_rels/.rels', stripRelationships(await packageRels.async('string')));

  let presRels = stripRelationships(
    (await zip.file('ppt/_rels/presentation.xml.rels').async('string')).replace(
      /<Relationship[^>]*Type="[^"]*\/relationships\/slide"[^>]*\/>/g,
      '',
    ),
  );
  const sldIds = [];
  // Numeric relationship ids: readers in this repo (slideOrderOf) and
  // PowerPoint both expect the rIdN spelling, and 900+ stays clear of the
  // master/theme ids the source deck already uses.
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
    .replace(/<p:notesMasterIdLst\s*\/>/, '');

  zip.file('ppt/presentation.xml', presentation);
  zip.file('ppt/_rels/presentation.xml.rels', presRels);

  const pruned = await pruneUnreachableParts(zip, contentTypes);
  zip.file('[Content_Types].xml', pruned.contentTypes);

  const bytes = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  await writeFile(outputPath, bytes);
  return { bytes, removed: pruned.removed };
}

async function buildTemplate(sourcePath) {
  const zip = await JSZip.loadAsync(await readFile(sourcePath));
  const order = await slideOrderOf(zip);
  console.log(`원본 슬라이드 ${order.length}장`);

  // Read the kept slides before mutating the package: a design may be used
  // twice (기도 is slides 31 and 38) and both copies must survive.
  const slides = [];
  for (const { source, role } of KEPT_SLIDES) {
    const name = order[source - 1];
    if (!name) throw new Error(`원본에 ${source}번 슬라이드가 없습니다.`);
    const rules = TOKEN_RULES[source] ?? [];
    slides.push(await readTokenizedSlide(zip, name, rules, `${source}번 슬라이드(${role})`));
    console.log(`  ${String(source).padStart(2)}번 → ${role}${rules.length ? ` (토큰 ${rules.length}개)` : ''}`);
  }

  const output = resolve('public/wednesday-template.pptx');
  const { bytes, removed } = await writeDeck(zip, slides, output);
  console.log(`  쓰이지 않는 파트 ${removed.length}개 제거`);
  console.log(`${output} (${slides.length}장, ${(bytes.length / 1024 / 1024).toFixed(1)}MB)\n`);
}

async function buildThumbnail(sourcePath) {
  const zip = await JSZip.loadAsync(await readFile(sourcePath));
  const order = await slideOrderOf(zip);
  if (order.length !== 1) throw new Error(`썸네일 원본은 1장이어야 합니다 (${order.length}장).`);

  const slide = await readTokenizedSlide(zip, order[0], COVER_RULES, '썸네일 표지');
  const output = resolve('public/wednesday-thumbnail.pptx');
  const { bytes, removed } = await writeDeck(zip, [slide], output);
  console.log(`썸네일 원본 1장 (토큰 ${COVER_RULES.length}개, 쓰이지 않는 파트 ${removed.length}개 제거)`);
  console.log(`${output} (1장, ${(bytes.length / 1024 / 1024).toFixed(1)}MB)`);
}

async function main() {
  const [servicePath, thumbnailPath] = process.argv.slice(2);
  if (!servicePath) {
    throw new Error(
      '사용법: node scripts/prepare-wednesday-template.mjs <수요예배.pptx> [썸네일.pptx]',
    );
  }
  await buildTemplate(servicePath);
  if (thumbnailPath) await buildThumbnail(thumbnailPath);
}

await main();
