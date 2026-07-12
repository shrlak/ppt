import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { parseAnnouncements, buildAnnouncementDeck } from '../src/lib/announcementBuilder';

const serviceTemplate = readFileSync(join(__dirname, '..', 'public', 'service-template.pptx'));
const sampleText = readFileSync(join(__dirname, 'fixtures', 'announcements-sample.txt'), 'utf-8');

describe('parseAnnouncements', () => {
  it('parses the real sample text into 5 items with titles', () => {
    const items = parseAnnouncements(sampleText);
    expect(items).toHaveLength(5);
    expect(items.map((i) => i.title)).toEqual([
      '새가족 환영',
      '여름수련회 안내',
      '여름 성경공부 참가자 모집',
      '중보기도 모임',
      '양육 프로그램',
    ]);
  });

  it('discards the preamble before the first numbered item', () => {
    const items = parseAnnouncements(sampleText);
    const allBody = items.flatMap((i) => i.bodyLines).join(' ');
    expect(allBody).not.toContain('주일광고');
  });

  it('splits sub-bullets into separate body lines, preserving the dash', () => {
    const items = parseAnnouncements(sampleText);
    const retreat = items[1];
    expect(retreat.bodyLines[0]).toContain('여름수련회가 진행됩니다');
    expect(retreat.bodyLines).toContainEqual('- 본문: 요한복음 20:21');
    expect(retreat.bodyLines).toContainEqual('- 시간: 10:00AM-6:00PM');
  });

  it('flattens nested sub-bullets from a multi-section item', () => {
    const items = parseAnnouncements(sampleText);
    const prayer = items[3];
    expect(prayer.bodyLines).toContainEqual('- 화요기도회');
    expect(prayer.bodyLines).toContainEqual('- 예배전 중보기도모임');
    expect(prayer.bodyLines.length).toBeGreaterThanOrEqual(5);
  });

  it('returns an empty array for text with no numbered items', () => {
    expect(parseAnnouncements('그냥 아무 텍스트입니다.')).toEqual([]);
  });

  it('handles a single simple item', () => {
    const items = parseAnnouncements('1. <공지 제목>\n본문 내용입니다.');
    expect(items).toEqual([{ title: '공지 제목', bodyLines: ['본문 내용입니다.'] }]);
  });
});

describe('buildAnnouncementDeck', () => {
  const items = parseAnnouncements(sampleText);

  it('creates one slide per item, numbered sequentially with the title in <>', async () => {
    const out = await buildAnnouncementDeck(serviceTemplate, 33, items);
    const zip = await JSZip.loadAsync(out);
    const slideFiles = Object.keys(zip.files).filter((f) => /^ppt\/slides\/slide\d+\.xml$/.test(f));
    expect(slideFiles).toHaveLength(5);

    const slide1 = await zip.file('ppt/slides/slide1.xml')!.async('string');
    expect(slide1).toContain('1. &lt;새가족 환영&gt;');
    expect(slide1).toContain('오늘 처음 오신 분들을 진심으로 환영합니다');

    const slide2 = await zip.file('ppt/slides/slide2.xml')!.async('string');
    expect(slide2).toContain('2. &lt;여름수련회 안내&gt;');
    expect(slide2).toContain('본문: 요한복음 20:21');

    // The fixed corner label ("광고"/"Announcements") is preserved unchanged.
    expect(slide1).toContain('광고');
    expect(slide1).toContain('Announcements');
  });

  it('keeps presentation.xml and Content_Types consistent with the slide count', async () => {
    const out = await buildAnnouncementDeck(serviceTemplate, 33, items);
    const zip = await JSZip.loadAsync(out);
    const presentation = await zip.file('ppt/presentation.xml')!.async('string');
    expect(presentation.match(/<p:sldId /g)).toHaveLength(5);
    const contentTypes = await zip.file('[Content_Types].xml')!.async('string');
    for (let n = 1; n <= 5; n++) {
      expect(contentTypes).toContain(`PartName="/ppt/slides/slide${n}.xml"`);
    }
  });

  it('rejects an empty item list', async () => {
    await expect(buildAnnouncementDeck(serviceTemplate, 33, [])).rejects.toThrow();
  });

  it('keeps the template size for short bodies and shrinks overflowing ones to fit', async () => {
    const short = { title: '짧은 광고', bodyLines: ['한 줄짜리 공지입니다.'] };
    const long = {
      title: '긴 광고',
      bodyLines: Array.from(
        { length: 8 },
        (_, i) => `${i + 1}번째 줄은 슬라이드 폭보다 훨씬 길어서 소프트 랩이 일어나는 긴 안내 문장입니다. 자세한 내용은 각 부서 담당자에게 문의해 주세요.`,
      ),
    };
    const out = await buildAnnouncementDeck(serviceTemplate, 33, [short, long]);
    const zip = await JSZip.loadAsync(out);

    const shortXml = await zip.file('ppt/slides/slide1.xml')!.async('string');
    const longXml = await zip.file('ppt/slides/slide2.xml')!.async('string');
    const bodySize = (xml: string): number => {
      // Third shape holds the body; its runs carry the fitted size.
      const shapes = [...xml.matchAll(/<p:sp>[\s\S]*?<\/p:sp>/g)];
      return Number(shapes[2][0].match(/sz="(\d+)"/)![1]);
    };

    expect(bodySize(shortXml)).toBe(2500);
    const longSz = bodySize(longXml);
    expect(longSz).toBeLessThan(2500);
    expect(longSz).toBeGreaterThanOrEqual(1200);
  });
});
