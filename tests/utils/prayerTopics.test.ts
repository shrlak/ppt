import { describe, expect, it } from 'vitest';
import {
  MAX_TOPICS_PER_SLIDE,
  TOPIC_BASE_SZ,
  TOPIC_SPLIT_SZ,
  parsePrayerTopics,
  planPrayerTopicPages,
  wrappedLineCount,
  type PrayerTopic,
} from '../../src/lib/utils/prayerTopics';
import { SUNDAY_TOPICS } from '../support/prayerTopicsSample';

/** Topic numbers on each slide, e.g. [[1, 2], [3, 4]]. */
function numbersPerSlide(topics: PrayerTopic[]): number[][] {
  return planPrayerTopicPages(topics).map((page) => page.blocks.map((block) => block.number));
}

describe('parsePrayerTopics', () => {
  it('reads numbered topics with the - points under each', () => {
    const topics = parsePrayerTopics(SUNDAY_TOPICS);
    expect(topics.map((topic) => topic.title)).toEqual([
      '회개와 마음의 정결',
      '예배를 위한 기도',
      '설교자와 예배 봉사자를 위한 기도',
      '새가족을 위한 기도',
    ]);
    expect(topics.every((topic) => topic.points.length === 2)).toBe(true);
    expect(topics[0].points[0]).toBe(
      '지난 한 주간 하나님보다 앞세웠던 생각과 욕심, 불순종을 돌아보고 진심으로 회개하도록',
    );
  });

  it('leaves out a header above the first topic and takes Markdown, ①, 1) and • as they come', () => {
    const topics = parsePrayerTopics(
      '7/12 주일예배 기도제목\n\n**1. 회개**\n• 진심으로 회개하도록\n* **정결한** 마음으로\n\n2) 예배\n예배에 집중하도록\n\n③ 새가족',
    );
    expect(topics).toEqual([
      { title: '회개', points: ['진심으로 회개하도록', '정결한 마음으로'] },
      { title: '예배', points: ['예배에 집중하도록'] },
      { title: '새가족', points: [] },
    ]);
  });

  it('reads a list with no numbers one topic per line', () => {
    expect(parsePrayerTopics('- 교회의 연합\n- 다음 세대\n')).toEqual([
      { title: '교회의 연합', points: [] },
      { title: '다음 세대', points: [] },
    ]);
    expect(parsePrayerTopics('교회의 연합\n- 서로 사랑하도록\n다음 세대')).toEqual([
      { title: '교회의 연합', points: ['서로 사랑하도록'] },
      { title: '다음 세대', points: [] },
    ]);
  });

  it('does not take a time or a decimal for a topic number', () => {
    expect(parsePrayerTopics('10:30 기도회\n1.5배 더')).toEqual([
      { title: '10:30 기도회', points: [] },
      { title: '1.5배 더', points: [] },
    ]);
  });

  it('finds nothing in blank text', () => {
    expect(parsePrayerTopics('  \n\n ')).toEqual([]);
  });
});

describe('wrappedLineCount', () => {
  it('moves a word that does not fit to the next line whole', () => {
    expect(wrappedLineCount('가나다 라마바', 7)).toBe(1);
    expect(wrappedLineCount('가나다 라마바', 6)).toBe(2);
    expect(wrappedLineCount('가나다라마바사아자차', 4)).toBe(3);
  });
});

describe('planPrayerTopicPages', () => {
  const topics = parsePrayerTopics(SUNDAY_TOPICS);

  it('puts one to three topics on one slide, and four two to a slide', () => {
    expect(numbersPerSlide(topics.slice(0, 1))).toEqual([[1]]);
    expect(numbersPerSlide(topics.slice(0, 2))).toEqual([[1, 2]]);
    expect(numbersPerSlide(topics.slice(0, 3))).toEqual([[1, 2, 3]]);
    expect(numbersPerSlide(topics)).toEqual([
      [1, 2],
      [3, 4],
    ]);
  });

  it('draws two topics at the deck’s 20pt and shrinks a fuller slide, never below the split size', () => {
    const pages = planPrayerTopicPages(topics);
    expect(pages.map((page) => page.sz)).toEqual([TOPIC_BASE_SZ, TOPIC_BASE_SZ]);
    const three = planPrayerTopicPages(topics.slice(0, 3));
    expect(three[0].sz).toBeLessThan(TOPIC_BASE_SZ);
    expect(three[0].sz).toBeGreaterThanOrEqual(TOPIC_SPLIT_SZ);
  });

  it('never puts four short topics on one slide', () => {
    const short = parsePrayerTopics('1. 회개\n2. 예배\n3. 설교자\n4. 새가족');
    expect(numbersPerSlide(short)).toEqual([
      [1, 2],
      [3, 4],
    ]);
  });

  it('adds slides for longer topics and keeps them even, fuller at the front', () => {
    const long = topics.map((topic) => ({ ...topic, points: [...topic.points, ...topic.points] }));
    const pages = numbersPerSlide(long.slice(0, 3));
    expect(pages.length).toBeGreaterThan(1);
    expect(pages.flat()).toEqual([1, 2, 3]);
    const five = numbersPerSlide([...topics, topics[0]]);
    expect(five.map((page) => page.length)).toEqual([3, 2]);
    expect(five.every((page) => page.length <= MAX_TOPICS_PER_SLIDE)).toBe(true);
  });

  it('carries a topic too long for one slide over to the next under its own title', () => {
    const points = Array.from({ length: 12 }, (_, i) => `${topics[0].points[i % 2]} (${i + 1})`);
    const pages = planPrayerTopicPages([{ title: '회개와 마음의 정결', points }]);
    expect(pages.length).toBeGreaterThan(1);
    expect(pages.every((page) => page.blocks[0].title === '회개와 마음의 정결' && page.blocks[0].number === 1)).toBe(true);
    expect(pages.flatMap((page) => page.blocks.flatMap((block) => block.points))).toEqual(points);
    expect(pages.every((page) => page.sz >= TOPIC_SPLIT_SZ)).toBe(true);
    // Shared out evenly rather than one full slide and a last point left over.
    const counts = pages.map((page) => page.blocks[0].points.length);
    expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(1);
  });

  it('plans nothing for no topics', () => {
    expect(planPrayerTopicPages([])).toEqual([]);
  });
});
