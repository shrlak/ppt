import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import JSZip from 'jszip';
import { assertPptxIntegrity, findBrokenRelationships } from '../../src/lib/pptx/pptxPackage';
import { slideOrderOf } from '../../src/lib/pptx/pptxSlices';
import { WEDNESDAY_SLIDES } from '../../src/wednesday/template';

const publicDir = join(__dirname, '..', '..', 'public');
const templateBytes = readFileSync(join(publicDir, 'wednesday-template.pptx'));
const thumbnailBytes = readFileSync(join(publicDir, 'wednesday-thumbnail.pptx'));

async function textsOf(zip: JSZip): Promise<string[]> {
  const names = await slideOrderOf(zip);
  const out: string[] = [];
  for (const name of names) {
    const xml = await zip.file(`ppt/slides/${name}`)!.async('string');
    // Runs are joined with nothing between them: PowerPoint splits a word
    // across runs wherever the author's IME did ("성" + "령으로"), so any
    // separator would show up inside words.
    out.push(
      [...xml.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)]
        .map((match) => match[1])
        .join('')
        .replace(/\s+/g, ' ')
        .trim(),
    );
  }
  return out;
}

describe('public/wednesday-template.pptx', () => {
  it('holds the eleven fixed 수요예배 designs in order', async () => {
    const zip = await JSZip.loadAsync(templateBytes);
    const texts = await textsOf(zip);

    expect(texts).toHaveLength(11);
    expect(texts[WEDNESDAY_SLIDES.cover - 1]).toContain('수요예배');
    expect(texts[WEDNESDAY_SLIDES.intro - 1]).toContain('피츠버그 한인 중앙 교회');
    expect(texts[WEDNESDAY_SLIDES.worship - 1]).toContain('경배와 찬양');
    expect(texts[WEDNESDAY_SLIDES.songTitle - 1]).toContain('찬 양');
    expect(texts[WEDNESDAY_SLIDES.prayer - 1]).toContain('기 도');
    expect(texts[WEDNESDAY_SLIDES.wordDivider - 1]).toContain('말 씀');
    expect(texts[WEDNESDAY_SLIDES.wordBody - 1]).toContain('개역개정');
    expect(texts[WEDNESDAY_SLIDES.sermonDivider - 1]).toContain('말 씀');
    expect(texts[WEDNESDAY_SLIDES.unifiedPrayer - 1]).toContain('합심기도');
    expect(texts[WEDNESDAY_SLIDES.closing - 1]).toContain('성령으로 봉사하는 교회');
  });

  it('carries every placeholder the builder substitutes', async () => {
    const zip = await JSZip.loadAsync(templateBytes);
    const texts = await textsOf(zip);
    const all = texts.join('\n');

    for (const token of [
      '{{DATE_KO}}',
      '{{DATE_DOT}}',
      '{{SERMON_TITLE}}',
      '{{RANGE_KO}}',
      '{{PREACHER}}',
      '{{PREACHER_TITLE}}',
      '{{PREACHER_LINE}}',
      '{{SONG_TITLE}}',
      '{{BODY}}',
    ]) {
      expect(all).toContain(token);
    }

    // The week the template was derived from must not leak into every deck.
    expect(all).not.toContain('2026년 9월 16일');
    expect(all).not.toContain('고신석');
    expect(all).not.toContain('시편 18편');
  });

  it('is a sound package with no notes or comment leftovers', async () => {
    await expect(assertPptxIntegrity(templateBytes)).resolves.toBeUndefined();
    const zip = await JSZip.loadAsync(templateBytes);
    expect(await findBrokenRelationships(zip)).toEqual([]);
    expect(Object.keys(zip.files).filter((path) => /notesSlide|notesMaster|comment/.test(path))).toEqual([]);
  });

  it('keeps the service deck slide size', async () => {
    const zip = await JSZip.loadAsync(templateBytes);
    const presentation = await zip.file('ppt/presentation.xml')!.async('string');
    expect(presentation).toContain('cx="13004800"');
    expect(presentation).toContain('cy="9753600"');
  });

  it('carries only the media the kept slides use', async () => {
    const zip = await JSZip.loadAsync(templateBytes);
    const media = Object.keys(zip.files).filter((path) => path.startsWith('ppt/media/'));
    // The source deck's 23 악보 page images belong to the song slides, which
    // this template does not keep — they must not ride along in every deck.
    expect(media.length).toBeLessThanOrEqual(10);
    expect(media).toContain('ppt/media/image1.emf');
  });

  it('keeps one verse paragraph and one spacer as the 말씀 본문 prototypes', async () => {
    const zip = await JSZip.loadAsync(templateBytes);
    const xml = await zip.file(`ppt/slides/slide${WEDNESDAY_SLIDES.wordBody}.xml`)!.async('string');
    const bodyShape = [...xml.matchAll(/<p:sp>[\s\S]*?<\/p:sp>/g)]
      .map((match) => match[0])
      .find((shape) => shape.includes('{{BODY}}'));
    expect(bodyShape).toBeDefined();

    const paragraphs = [...bodyShape!.matchAll(/<a:p>[\s\S]*?<\/a:p>|<a:p\/>/g)].map((match) => match[0]);
    expect(paragraphs).toHaveLength(2);
    // Verse paragraphs are single-spaced, the spacer between them is 120%.
    expect(paragraphs[0]).toContain('{{BODY}}');
    expect(paragraphs[0]).toContain('val="100000"');
    expect(paragraphs[1]).toContain('val="120000"');
    // The hanging indent that lines verse numbers up comes from lvl="1".
    expect(paragraphs[0]).toContain('lvl="1"');
  });
});

describe('public/wednesday-thumbnail.pptx', () => {
  it('is the 16:9 cover on its own, with the same placeholders', async () => {
    const zip = await JSZip.loadAsync(thumbnailBytes);
    const names = await slideOrderOf(zip);
    expect(names).toHaveLength(1);

    const xml = await zip.file(`ppt/slides/${names[0]}`)!.async('string');
    for (const token of ['{{DATE_KO}}', '{{SERMON_TITLE}}', '{{RANGE_KO}}', '{{PREACHER}}', '{{PREACHER_TITLE}}']) {
      expect(xml).toContain(token);
    }

    // The cover was authored 16:9 with its own layout; keeping that layout is
    // why the thumbnail is a separate asset instead of a resized extract.
    const presentation = await zip.file('ppt/presentation.xml')!.async('string');
    expect(presentation).toContain('cx="12192000"');
    expect(presentation).toContain('cy="6858000"');
  });

  it('is a sound package', async () => {
    await expect(assertPptxIntegrity(thumbnailBytes)).resolves.toBeUndefined();
    expect(await findBrokenRelationships(await JSZip.loadAsync(thumbnailBytes))).toEqual([]);
  });
});
