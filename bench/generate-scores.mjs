// Generate synthetic 악보 (sheet-music) pages for the recognition accuracy
// benchmark. Each page is rendered from a real library song (title, key,
// order, sections) laid out like a scanned worship score: heading with the
// key, the 진행 순서 line, then five-line staves with note heads and the
// lyric syllables hyphenated underneath — exactly the structures the AI has
// to read back. The generator is deterministic (seeded per song index), so a
// trial is reproducible, and it writes a manifest.json with the ground truth
// every page was rendered from.
//
// Usage: node bench/generate-scores.mjs [--count 50] [--out bench/out] [--width 1240]
// Requires a Korean font (Noto Sans KR / Noto Sans CJK KR) and the
// repo-configured Playwright Chromium.
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require('@playwright/test');

const args = Object.fromEntries(
  process.argv.slice(2).map((arg, i, all) => (arg.startsWith('--') ? [arg.slice(2), all[i + 1]] : [])).filter((p) => p.length),
);
const COUNT = Number(args.count ?? 50);
const OUT = args.out ?? 'bench/out';
const WIDTH = Number(args.width ?? 1240);

/** Deterministic PRNG so page layouts are reproducible across trials. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Hyphenate a lyric line the way scores split syllables across notes. */
function hyphenate(line) {
  return line
    .split(/\s+/)
    .map((word) => {
      const chars = [...word];
      // Split multi-syllable Hangul words note-by-note: 찬양해 → 찬-양-해.
      if (chars.length >= 2 && chars.every((ch) => /[가-힣]/.test(ch))) return chars.join('-');
      return word;
    })
    .join(' ');
}

function escapeHtml(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** One five-line staff with note heads, as inline SVG. */
function staffSvg(rand, width) {
  const height = 64;
  const lineGap = 9;
  const top = 10;
  const lines = Array.from(
    { length: 5 },
    (_, i) => `<line x1="0" y1="${top + i * lineGap}" x2="${width}" y2="${top + i * lineGap}" stroke="#222" stroke-width="1"/>`,
  ).join('');
  const notes = [];
  const count = 8 + Math.floor(rand() * 6);
  for (let i = 0; i < count; i++) {
    const x = 40 + ((width - 80) / count) * i + rand() * 14;
    const y = top + Math.floor(rand() * 9) * (lineGap / 2);
    const stemUp = y > top + 2 * lineGap;
    notes.push(
      `<ellipse cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" rx="5.2" ry="4" fill="#111" transform="rotate(-18 ${x.toFixed(1)} ${y.toFixed(1)})"/>`,
      `<line x1="${(x + (stemUp ? 5 : -5)).toFixed(1)}" y1="${y.toFixed(1)}" x2="${(x + (stemUp ? 5 : -5)).toFixed(1)}" y2="${(y + (stemUp ? -26 : 26)).toFixed(1)}" stroke="#111" stroke-width="1.4"/>`,
    );
  }
  const clef = `<text x="8" y="${top + 4 * lineGap - 2}" font-size="40" font-family="serif">𝄞</text>`;
  return `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${lines}${clef}${notes.join('')}</svg>`;
}

function pageHtml(song, seed, width) {
  const rand = mulberry32(seed);
  const bodyFont = 18 + Math.floor(rand() * 4);
  const staffWidth = width - 120;
  const sections = song.sections
    .map((section) => {
      const rows = section.lines
        .map(
          (line) => `
            <div class="staff-row">
              ${staffSvg(rand, staffWidth)}
              <div class="lyric">${escapeHtml(hyphenate(line))}</div>
            </div>`,
        )
        .join('');
      return `
        <div class="section">
          <div class="section-label">${escapeHtml(section.label)}</div>
          <div class="section-body">${rows}</div>
        </div>`;
    })
    .join('');

  return `<!doctype html><html><head><meta charset="utf-8"><style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { width: ${width}px; background: #fff; color: #111;
           font-family: 'Noto Sans KR', 'Noto Sans CJK KR', sans-serif; padding: 44px 48px 60px; }
    .head { text-align: center; margin-bottom: 6px; position: relative; }
    .title { font-size: 34px; font-weight: 700; }
    .key { position: absolute; right: 0; top: 8px; font-size: 20px; font-weight: 700; }
    .order { text-align: center; font-size: 19px; letter-spacing: 1px; margin: 10px 0 26px; font-weight: 700; }
    .section { display: flex; gap: 14px; margin-bottom: 18px; }
    .section-label { width: 44px; font-size: 21px; font-weight: 700; padding-top: 14px; }
    .section-body { flex: 1; }
    .staff-row { margin-bottom: 8px; }
    .lyric { font-size: ${bodyFont}px; margin: 2px 0 10px 42px; letter-spacing: 0.5px; }
  </style></head><body>
    <div class="head">
      <div class="title">${escapeHtml(song.title)}</div>
      ${song.key ? `<div class="key">Key: ${escapeHtml(song.key)}</div>` : ''}
    </div>
    <div class="order">${song.order.map(escapeHtml).join(' - ')}</div>
    ${sections}
  </body></html>`;
}

async function main() {
  const library = JSON.parse(readFileSync('public/library.json', 'utf8'));
  const usable = library.filter(
    (entry) =>
      Array.isArray(entry.sections) &&
      entry.sections.length > 0 &&
      Array.isArray(entry.order) &&
      entry.order.length > 0 &&
      entry.sections.every((section) => Array.isArray(section.lines) && section.lines.length > 0),
  );
  // Deterministic spread across the library so trials always use the same songs.
  const step = Math.max(1, Math.floor(usable.length / COUNT));
  const songs = Array.from({ length: Math.min(COUNT, usable.length) }, (_, i) => usable[(i * step) % usable.length]);

  mkdirSync(join(OUT, 'pages'), { recursive: true });
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || undefined,
  });
  const page = await browser.newPage({ viewport: { width: WIDTH, height: 1600 } });

  const manifest = [];
  for (let i = 0; i < songs.length; i++) {
    const song = songs[i];
    const truth = {
      index: i,
      file: `pages/score-${String(i).padStart(2, '0')}.png`,
      title: song.title,
      key: song.key ?? '',
      order: song.order,
      sections: song.sections.map((section) => ({
        label: section.label,
        lines: section.lines.map((line) => line.trim()).filter(Boolean),
      })),
    };
    await page.setContent(pageHtml(truth, i + 1, WIDTH), { waitUntil: 'networkidle' });
    await page.screenshot({ path: join(OUT, truth.file), fullPage: true });
    manifest.push(truth);
    if ((i + 1) % 10 === 0) console.log(`rendered ${i + 1}/${songs.length}`);
  }
  await browser.close();
  writeFileSync(join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2));
  console.log(`generated ${manifest.length} score pages in ${OUT}`);
}

await main();
