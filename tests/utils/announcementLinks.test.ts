import { describe, expect, it } from 'vitest';
import { splitOutLinks } from '../../src/lib/utils/announcementLinks';

describe('splitOutLinks', () => {
  it('takes a labelled link line out whole', () => {
    expect(splitOutLinks(['- 대상: 대학청년부', '- 신청: https://forms.gle/AbCd123', '- 문의: 방태준 목사'])).toEqual({
      bodyLines: ['- 대상: 대학청년부', '- 문의: 방태준 목사'],
      links: ['https://forms.gle/AbCd123'],
    });
    expect(splitOutLinks(['Zoom 링크 → https://zoom.us/j/123']).bodyLines).toEqual([]);
  });

  it('drops a line that held nothing but the link', () => {
    expect(splitOutLinks(['아래 링크로 신청해 주세요!', 'https://forms.gle/xyz789'])).toEqual({
      bodyLines: ['아래 링크로 신청해 주세요!'],
      links: ['https://forms.gle/xyz789'],
    });
    expect(splitOutLinks(['- https://forms.gle/xyz789']).bodyLines).toEqual([]);
  });

  it('keeps the sentence around a link, without the brackets or gap it leaves', () => {
    expect(splitOutLinks(['자세한 내용은 홈페이지(https://kcpc.org)를 참고해 주세요.'])).toEqual({
      bodyLines: ['자세한 내용은 홈페이지를 참고해 주세요.'],
      links: ['https://kcpc.org'],
    });
    expect(splitOutLinks(['신청은 https://forms.gle/abc, 문의는 임원진에게'])).toEqual({
      bodyLines: ['신청은, 문의는 임원진에게'],
      links: ['https://forms.gle/abc'],
    });
    expect(splitOutLinks(['- 줌: https://zoom.us/j/123?pwd=abc (암호: 1234)'])).toEqual({
      bodyLines: ['- 줌: (암호: 1234)'],
      links: ['https://zoom.us/j/123?pwd=abc'],
    });
  });

  it('keeps a longer sentence that introduced the link, minus its colon', () => {
    expect(splitOutLinks(['신청은 아래 링크를 통해 해 주세요: https://forms.gle/abc']).bodyLines).toEqual([
      '신청은 아래 링크를 통해 해 주세요',
    ]);
  });

  it('reads short links, www. addresses and Markdown links, giving each a scheme', () => {
    expect(splitOutLinks(['- 신청: forms.gle/abc123', '홈페이지: www.kcpc.org', '[신청서 작성하기](https://bit.ly/3AbCd)'])).toEqual({
      bodyLines: ['신청서 작성하기'],
      links: ['https://forms.gle/abc123', 'https://www.kcpc.org', 'https://bit.ly/3AbCd'],
    });
    expect(splitOutLinks(['Https://forms.gle/abc']).links).toEqual(['https://forms.gle/abc']);
  });

  it('ends a link where Korean text runs straight on from it', () => {
    expect(splitOutLinks(['https://forms.gle/abc에서 신청해 주세요']).links).toEqual(['https://forms.gle/abc']);
  });

  it('lists a link written twice once', () => {
    expect(splitOutLinks(['신청: https://forms.gle/abc', '다시 한번: https://forms.gle/abc.']).links).toEqual([
      'https://forms.gle/abc',
    ]);
  });

  it('leaves ordinary text alone', () => {
    const lines = [
      '- 본문: 요한복음 20:21',
      '- 시간: 10:00AM-6:00PM',
      '아침식사 후 큐티 (pg. 10)',
      '- 문의: kim@gmail.com',
      '- 일정 : 4주 과정 - 7/9, 7/16, 7/23, 7/30',
      'ESV/개역개정 본문을 함께 읽습니다.',
    ];
    expect(splitOutLinks(lines)).toEqual({ bodyLines: lines, links: [] });
  });
});
