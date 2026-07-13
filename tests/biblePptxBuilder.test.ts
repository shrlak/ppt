import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { buildBiblePptx } from '../src/bible/pptxBuilder';
import type { VerseSlidePlan } from '../src/bible/versePlanner';
import { findBrokenRelationships } from '../src/lib/pptx/pptxPackage';

const template = readFileSync(join(__dirname, '..', 'public', 'bible-template.pptx'));

const plan: VerseSlidePlan = {
  globalData: {
    title: '로마서',
    etitle: 'Romans',
    rangeKo: '로마서 8:28-30',
    rangeEn: 'Romans 8:28-30',
    sermonTitle: '하나님과 화평을 누리자',
  },
  verseSlides: [
    { title: '로마서', etitle: 'Romans', chapter: '8', verse: '28', rangeKo: '로마서 8:28-30', rangeEn: 'Romans 8:28-30', body: '우리가 알거니와' },
    { title: '로마서', etitle: 'Romans', chapter: '8', verse: '29', rangeKo: '로마서 8:28-30', rangeEn: 'Romans 8:28-30', body: '하나님이 미리 아신 자들을' },
  ],
};

describe('buildBiblePptx', () => {
  it('produces a valid pptx with one slide per verse plus the non-verse slides', async () => {
    const out = await buildBiblePptx(template, plan);
    const zip = await JSZip.loadAsync(out);

    const slideFiles = Object.keys(zip.files).filter((f) => /^ppt\/slides\/slide\d+\.xml$/.test(f));
    expect(slideFiles.length).toBeGreaterThan(plan.verseSlides.length);

    const presentation = await zip.file('ppt/presentation.xml')!.async('string');
    expect(presentation.match(/<p:sldId /g)).toHaveLength(slideFiles.length);
    expect(zip.file('[Content_Types].xml')).not.toBeNull();
    expect(await findBrokenRelationships(zip)).toEqual([]);
    expect(Object.keys(zip.files).some((path) => path.startsWith('ppt/notesSlides/'))).toBe(false);
  });

  it('substitutes verse body text and range into the right slides', async () => {
    const out = await buildBiblePptx(template, plan);
    const zip = await JSZip.loadAsync(out);
    const slideFiles = Object.keys(zip.files).filter((f) => /^ppt\/slides\/slide\d+\.xml$/.test(f));

    const allText = (
      await Promise.all(slideFiles.map((f) => zip.file(f)!.async('string')))
    ).join('\n');
    expect(allText).toContain('우리가 알거니와');
    expect(allText).toContain('하나님이 미리 아신 자들을');
    expect(allText).toContain('로마서 8:28-30');
    expect(allText).toContain('하나님과 화평을 누리자');
    // Placeholders must not leak through unreplaced.
    expect(allText).not.toContain('{{BODY}}');
    expect(allText).not.toContain('{{SERMON_TITLE}}');
  });

  it('clears the sermon title placeholder instead of leaving it literal when blank', async () => {
    const blankTitlePlan: VerseSlidePlan = {
      ...plan,
      globalData: { ...plan.globalData, sermonTitle: '' },
    };
    const out = await buildBiblePptx(template, blankTitlePlan);
    const zip = await JSZip.loadAsync(out);
    const slideFiles = Object.keys(zip.files).filter((f) => /^ppt\/slides\/slide\d+\.xml$/.test(f));
    const allText = (await Promise.all(slideFiles.map((f) => zip.file(f)!.async('string')))).join('\n');
    expect(allText).not.toContain('{{SERMON_TITLE}}');
  });

  it('leaves no {{...}} placeholder tokens for used keys', async () => {
    const out = await buildBiblePptx(template, plan);
    const zip = await JSZip.loadAsync(out);
    const slideFiles = Object.keys(zip.files).filter((f) => /^ppt\/slides\/slide\d+\.xml$/.test(f));
    for (const f of slideFiles) {
      const xml = await zip.file(f)!.async('string');
      expect(xml).not.toMatch(/\{\{(TITLE|ETITLE|CHAP|PARA|RANGE_KO|RANGE_EN|BODY)\}\}/);
    }
  });
});
