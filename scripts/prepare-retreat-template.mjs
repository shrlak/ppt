// Derives public/retreat-template.pptx and public/retreat-songs.json from the
// real 수련회 decks (the 2026 빛주사랑 겨울 수련회 files).
//
// The 수련회 generator draws nothing of its own: every slide it makes is one
// of the first night's slides — the sermon poster cover, the 수련회 title, the
// 찬양/기도회 section divider, a song title, a lyric slide, the 설교말씀
// divider, a verse slide, the 설교 title, a blank screen, 기도, 축도, the
// 광고 divider and an 광고 item — cloned with its own layout, master and
// background photo. This script keeps those 13 designs, swaps that night's
// wording for {{TOKEN}} placeholders, and drops everything else.
//
// Beside the template it writes every song those decks projected, slide by
// slide, so a song sung at last year's retreat comes back already split the
// way it was shown (src/retreat/songs.ts).
//
//   node scripts/prepare-retreat-template.mjs <첫째날.pptx> [other retreat decks…]
//
// The first deck is the template source; every deck given is read for songs.
// The source decks are not committed: they are real service files.
import { readFile, writeFile } from 'node:fs/promises';
import { posix, resolve } from 'node:path';
import JSZip from 'jszip';

const SLIDE_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.presentationml.slide+xml';

/**
 * Slides kept from the first night's deck, in the order src/retreat/template.ts
 * numbers them. `runs` replace one text run exactly (keeping its formatting,
 * so a title that mixes two sizes keeps both); `paragraphs` rewrite a whole
 * paragraph, optionally only inside the shape whose name contains `shape`,
 * and `keepFollowing` trims that shape to the matched paragraph (+ N after).
 */
const KEPT_SLIDES = [
  { source: 1, role: '표지 (설교 포스터)' },
  {
    source: 2,
    role: '수련회 제목',
    runs: [
      { text: '“2026', token: '{{TITLE_LINE1}}' },
      { text: ' 빛주사랑 겨울 수련회”', token: '{{TITLE_LINE2}}' },
      { text: '피츠버그 한인 중앙교회 대학청년부', token: '{{SUBTITLE}}' },
    ],
  },
  { source: 3, role: '순서 구분 (찬양/기도회/찬양집회)', runs: [{ text: '찬양', token: '{{SECTION}}' }] },
  { source: 4, role: '곡 제목', runs: [{ text: '주 안에서 기뻐해', token: '{{SONG_TITLE}}' }] },
  {
    source: 5,
    role: '가사',
    paragraphs: [
      { text: '주 안에서 기뻐해', shape: ';183;', token: '{{LINE}}', keepFollowing: 0 },
      { text: '주 안에서 기뻐해', shape: ';184;', token: '{{SONG_TITLE}}' },
    ],
  },
  { source: 28, role: '설교말씀', runs: [{ text: '마태복음 14장 22-33절', token: '{{PASSAGE_KO}}' }] },
  {
    source: 29,
    role: '말씀 본문',
    runs: [
      { text: '22', token: '{{VERSE_NO}}' },
      {
        text: ' 예수께서 즉시 제자들을 재촉하사 자기가 무리를 보내는 동안에 배를 타고 앞서 건너편으로 가게 하시고',
        token: ' {{VERSE_KO}}',
      },
      { text: '마태복음 14장 22-33절', token: '{{PASSAGE_KO}}' },
      { text: 'Matthew 14:22-33', token: '{{PASSAGE_EN}}' },
      {
        text: '22 Immediately he made the disciples get into the boat and go before him to the other side, while he dismissed the crowds.',
        token: '{{VERSE_EN}}',
      },
    ],
  },
  { source: 41, role: '설교 제목', runs: [{ text: '“Go Beyond the Visible”', token: '{{SERMON_TITLE}}' }] },
  { source: 42, role: '빈 화면' },
  { source: 58, role: '기도', runs: [{ text: '기도', token: '{{LABEL}}' }] },
  { source: 59, role: '축도', runs: [{ text: '축도', token: '{{LABEL}}' }] },
  { source: 60, role: '광고 구분', runs: [{ text: 'OT | 광고', token: '{{LABEL}}' }] },
  {
    source: 61,
    role: '광고 항목',
    runs: [{ text: '1. &lt;환영합니다&gt;', token: '{{ANN_TITLE}}' }],
    paragraphs: [
      { text: '아침식사 후 큐티 (pg. 10, 23)', token: '{{ANN_LINE}}', keepFollowing: 0 },
      { text: '2026 빛주사랑 겨울 수련회', token: '{{FOOTER_TITLE}}' },
      { text: '불과 폭풍 속에서도, 주와 함께 걷는 길 (이사야 43:1-2)', token: '{{FOOTER_THEME}}' },
    ],
  },
];

const DISCARD_PREFIXES = ['ppt/notesSlides/', 'ppt/notesMasters/', 'ppt/comments/'];
const DISCARD_PARTS = ['ppt/commentAuthors.xml', 'docProps/thumbnail.jpeg', 'ppt/metadata'];
const DISCARD_REL_TYPES = ['notesSlide', 'notesMaster', 'comments', 'commentAuthors', 'thumbnail', 'presentationmetadata'];

const PARAGRAPH = /<a:p>[\s\S]*?<\/a:p>|<a:p\/>/g;
const SHAPE = /<p:sp>[\s\S]*?<\/p:sp>/g;

function xmlEscape(value) {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function decodeXml(value) {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

const collapse = (value) => value.replace(/\s+/g, ' ').trim();

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

/** Replace whole runs whose text is exactly a rule's text (first match per rule). */
function applyRunRules(xml, rules, label) {
  let out = xml;
  for (const rule of rules) {
    const needle = `<a:t>${rule.text}</a:t>`;
    const at = out.indexOf(needle);
    if (at < 0) throw new Error(`${label}에서 찾지 못한 글자: ${rule.text}`);
    out = out.slice(0, at) + `<a:t>${xmlEscape(rule.token)}</a:t>` + out.slice(at + needle.length);
  }
  return out;
}

function applyParagraphRules(slideXml, rules, label) {
  let out = slideXml;
  const applied = new Set();
  for (const shape of [...slideXml.matchAll(SHAPE)].reverse()) {
    const shapeXml = shape[0];
    const name = shapeXml.match(/name="([^"]*)"/)?.[1] ?? '';
    const paragraphs = [...shapeXml.matchAll(PARAGRAPH)];
    if (paragraphs.length === 0) continue;
    const matched = paragraphs.map((paragraph) =>
      rules.find(
        (rule) =>
          (!rule.shape || name.includes(rule.shape)) &&
          collapse(paragraphText(paragraph[0])) === collapse(rule.text),
      ),
    );
    if (matched.every((rule) => !rule)) continue;
    const trimAt = matched.findIndex((rule) => rule?.keepFollowing !== undefined);
    let rebuilt;
    if (trimAt >= 0) {
      const rule = matched[trimAt];
      applied.add(rule);
      rebuilt = [
        tokenizeParagraph(paragraphs[trimAt][0], rule.token),
        ...paragraphs.slice(trimAt + 1, trimAt + 1 + rule.keepFollowing).map((p) => p[0]),
      ].join('');
    } else {
      rebuilt = paragraphs
        .map((paragraph, index) => {
          const rule = matched[index];
          if (!rule) return paragraph[0];
          applied.add(rule);
          return tokenizeParagraph(paragraph[0], rule.token);
        })
        .join('');
    }
    const first = paragraphs[0].index;
    const last = paragraphs[paragraphs.length - 1];
    out =
      out.slice(0, shape.index) +
      shapeXml.slice(0, first) +
      rebuilt +
      shapeXml.slice(last.index + last[0].length) +
      out.slice(shape.index + shapeXml.length);
  }
  const missing = rules.filter((rule) => !applied.has(rule));
  if (missing.length > 0) throw new Error(`${label}에서 찾지 못한 문단: ${missing.map((rule) => rule.text).join(' / ')}`);
  return out;
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
  if (!section) throw new Error('슬라이드 목록을 찾지 못했습니다.');
  const names = [];
  for (const match of section[1].matchAll(/r:id="([^"]+)"/g)) {
    const target =
      rels.match(new RegExp(`Id="${escapeRegExp(match[1])}"[^>]*Target="slides/(slide\\d+\\.xml)"`)) ??
      rels.match(new RegExp(`Target="slides/(slide\\d+\\.xml)"[^>]*Id="${escapeRegExp(match[1])}"`));
    if (!target) throw new Error(`${match[1]} 관계를 찾지 못했습니다.`);
    names.push(target[1]);
  }
  return names;
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
    .replace(/<p:ext uri="GoogleSlidesCustomDataVersion2">[\s\S]*?<\/p:ext>/, '');
  zip.file('ppt/presentation.xml', presentation);
  zip.file('ppt/_rels/presentation.xml.rels', presRels);

  const pruned = await pruneUnreachableParts(zip, contentTypes);
  zip.file('[Content_Types].xml', pruned.contentTypes);
  const bytes = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  await writeFile(outputPath, bytes);
  return { bytes, removed: pruned.removed };
}

// ---- songs -----------------------------------------------------------------

function slideShapes(xml) {
  return [...xml.matchAll(SHAPE)]
    .map((shape) =>
      [...shape[0].matchAll(PARAGRAPH)].map((p) => paragraphText(p[0]).replace(/\s+/g, ' ').trim()),
    )
    .map((paragraphs) => paragraphs.filter(Boolean))
    .filter((paragraphs) => paragraphs.length > 0);
}

/**
 * A song is a slide carrying only its title, followed by lyric slides that
 * carry the lyrics plus that title in the corner. Anything else (dividers
 * with no lyric slide after them, verses, 광고) ends the current song.
 */
function readSongs(slideXmls) {
  const songs = [];
  let current = null;
  for (const xml of slideXmls) {
    const shapes = slideShapes(xml);
    if (shapes.length === 1 && shapes[0].length === 1) {
      current = { title: shapes[0][0], slides: [] };
      songs.push(current);
      continue;
    }
    if (current && shapes.length === 2) {
      const corner = shapes.findIndex((paragraphs) => paragraphs.length === 1 && paragraphs[0] === current.title);
      if (corner >= 0) {
        current.slides.push(shapes[1 - corner]);
        continue;
      }
    }
    current = null;
  }
  return songs.filter((song) => song.slides.length > 0 && song.title.length <= 40);
}

async function main() {
  const paths = process.argv.slice(2);
  if (paths.length === 0) {
    throw new Error('사용법: node scripts/prepare-retreat-template.mjs <첫째날.pptx> [다른 수련회 PPT…]');
  }

  // Songs from every deck; where one was sung twice, the fuller copy wins.
  const byTitle = new Map();
  for (const path of paths) {
    const zip = await JSZip.loadAsync(await readFile(path));
    const xmls = [];
    for (const name of await slideOrderOf(zip)) xmls.push(await zip.file(`ppt/slides/${name}`).async('string'));
    for (const song of readSongs(xmls)) {
      const size = (entry) => entry.slides.flat().length;
      const previous = byTitle.get(song.title);
      if (!previous || size(song) > size(previous)) byTitle.set(song.title, song);
    }
  }
  const songs = [...byTitle.values()].sort((a, b) => a.title.localeCompare(b.title, 'ko'));
  const songsPath = resolve('public/retreat-songs.json');
  await writeFile(songsPath, `${JSON.stringify(songs, null, 2)}\n`);
  console.log(`${songsPath}: ${songs.length}곡`);
  for (const song of songs) console.log(`  ${song.title} (${song.slides.length}장)`);

  const zip = await JSZip.loadAsync(await readFile(paths[0]));
  const order = await slideOrderOf(zip);
  const slides = [];
  for (const { source, role, runs = [], paragraphs = [] } of KEPT_SLIDES) {
    const name = order[source - 1];
    if (!name) throw new Error(`원본에 ${source}번 슬라이드가 없습니다.`);
    const label = `${source}번 슬라이드(${role})`;
    let xml = await zip.file(`ppt/slides/${name}`).async('string');
    if (paragraphs.length > 0) xml = applyParagraphRules(xml, paragraphs, label);
    if (runs.length > 0) xml = applyRunRules(xml, runs, label);
    const relsFile = zip.file(`ppt/slides/_rels/${name}.rels`);
    slides.push({ xml, rels: relsFile ? stripRelationships(await relsFile.async('string')) : null });
    console.log(`  ${String(source).padStart(3)}번 → ${role}`);
  }
  const output = resolve('public/retreat-template.pptx');
  const { bytes, removed } = await writeDeck(zip, slides, output);
  console.log(`  쓰이지 않는 파트 ${removed.length}개 제거`);
  console.log(`${output} (${slides.length}장, ${(bytes.length / 1024 / 1024).toFixed(1)}MB)`);
}

await main();
