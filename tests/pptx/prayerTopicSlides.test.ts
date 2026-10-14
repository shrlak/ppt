import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { applyPrayerTopics } from '../../src/lib/pptx/prayerTopicSlides';
import { mergePptxDecks } from '../../src/lib/pptx/pptxMerge';
import { assertPptxIntegrity } from '../../src/lib/pptx/pptxPackage';
import { slideOrderOf } from '../../src/lib/pptx/pptxSlices';
import { parsePrayerTopics } from '../../src/lib/utils/prayerTopics';
import { SUNDAY_TOPICS } from '../support/prayerTopicsSample';

const publicDir = join(__dirname, '..', '..', 'public');
const frontSlides = readFileSync(join(publicDir, 'front-slides.pptx'));
const backSlides = readFileSync(join(publicDir, 'back-slides.pptx'));
const noTopicsBox = readFileSync(join(__dirname, '..', 'fixtures', 'placeholder-front-slide.pptx'));

async function slideTexts(deck: ArrayBuffer | Uint8Array): Promise<string[]> {
  const zip = await JSZip.loadAsync(deck);
  const names = await slideOrderOf(zip);
  return Promise.all(names.map((name) => zip.file(`ppt/slides/${name}`)!.async('string')));
}

/** The text of each paragraph of a slide's 기도제목 box. */
function topicParagraphs(slideXml: string): string[] {
  const shape = slideXml.match(/<p:sp>(?:(?!<\/p:sp>)[\s\S])*name="기도제목"[\s\S]*?<\/p:sp>/)![0];
  return [...shape.matchAll(/<a:p>[\s\S]*?<\/a:p>/g)].map((p) =>
    [...p[0].matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((t) => t[1]).join(''),
  );
}

describe('applyPrayerTopics', () => {
  const topics = parsePrayerTopics(SUNDAY_TOPICS);

  it('fills two 기도 준비 slides with four topics, two to a slide, ahead of the rest of the front deck', async () => {
    const result = await applyPrayerTopics(frontSlides, topics);
    expect(result).toMatchObject({ applied: true, pages: 2, firstSlide: 1 });
    await expect(assertPptxIntegrity(result.data)).resolves.toBeUndefined();

    const slides = await slideTexts(result.data);
    expect(slides).toHaveLength(6);
    for (const slide of slides.slice(0, 2)) {
      expect(slide).toContain('지금은 기도로 예배를 준비하는');
      expect(slide).toContain('showMasterSp="0"');
      expect(slide).not.toContain('기도제목 1');
    }
    expect(topicParagraphs(slides[0])).toEqual([
      '1. 회개와 마음의 정결',
      topics[0].points[0],
      topics[0].points[1],
      '2. 예배를 위한 기도',
      topics[1].points[0],
      topics[1].points[1],
    ]);
    expect(topicParagraphs(slides[1])[0]).toBe('3. 설교자와 예배 봉사자를 위한 기도');
    expect(topicParagraphs(slides[1])[3]).toBe('4. 새가족을 위한 기도');
    // The cover and the 신앙고백 follow as they were.
    expect(slides[2]).toContain('빛주사랑');
    expect(slides[3]).toContain('신앙고백');

    // Titles are bold with no bullet; points keep the deck's ● at the text size.
    const first = slides[0];
    expect(first).toMatch(/<a:buNone\/><\/a:pPr><a:r><a:rPr lang="ko-KR"[^>]*sz="2000" b="1"><a:solidFill><a:srgbClr val="FFFFFF"\/>[\s\S]*?<a:t>1\. 회개와 마음의 정결<\/a:t>/);
    expect(first).toContain('<a:buSzPts val="2000"/><a:buFont typeface="Arial"/><a:buChar char="●"/>');
    // The box runs down to 0.4" above the bottom of the 7.5" slide.
    expect(first).toContain('<a:off x="685800" y="1828800"/><a:ext cx="7772400" cy="4663440"/>');

    const output = process.env.WRITE_PRAYER_TOPICS_DECK;
    if (output) {
      mkdirSync(join(output, '..'), { recursive: true });
      writeFileSync(output, await mergePptxDecks(result.data, backSlides));
    }
  });

  it('puts three topics on one slide, drawn smaller', async () => {
    const result = await applyPrayerTopics(frontSlides, topics.slice(0, 3));
    expect(result.pages).toBe(1);
    const slides = await slideTexts(result.data);
    expect(slides).toHaveLength(5);
    expect(topicParagraphs(slides[0]).filter((text) => /^\d\. /.test(text))).toHaveLength(3);
    expect(slides[0]).not.toContain('sz="2000"');
  });

  it('lists topics with no points as the deck’s own ● lines', async () => {
    const result = await applyPrayerTopics(frontSlides, parsePrayerTopics('- 교회의 연합\n- 다음 세대'));
    const [slide] = await slideTexts(result.data);
    expect(topicParagraphs(slide)).toEqual(['교회의 연합', '다음 세대']);
    expect(slide.match(/<a:buChar char="●"\/>/g)).toHaveLength(2);
    expect(slide).not.toContain('b="1"');
  });

  it('escapes what was typed', async () => {
    const result = await applyPrayerTopics(frontSlides, [{ title: '나라 & 민족 <위해>', points: [] }]);
    const [slide] = await slideTexts(result.data);
    expect(slide).toContain('나라 &amp; 민족 &lt;위해&gt;');
  });

  it('leaves the deck untouched with no topics, or with no 기도제목 box to write them into', async () => {
    const untouched = { pages: 0, firstSlide: 0, applied: false };
    expect(await applyPrayerTopics(frontSlides, [])).toEqual({ data: frontSlides, ...untouched });
    expect(await applyPrayerTopics(noTopicsBox, topics)).toEqual({ data: noTopicsBox, ...untouched });
  });
});
