import { describe, expect, it } from 'vitest';
import {
  applyAnnouncementToEntries,
  matchAnnouncement,
  parseAnnouncedSong,
  parseWorshipAnnouncement,
} from '../../src/lib/utils/announcement';
import type { ContiSongEntry } from '../../src/lib/utils/types';

/** The worship team's notice as it is posted to the group chat. */
const NOTICE = `🌱2026년 10월 04일 주일예배🌱

📖 본문: 로마서 8장 31-39절

📖 주제: 끝까지 흔들리지 않을 이유

라인업:
👤 인도자 – 조인서
🎸 어쿠 – 조인서
🎹 메인 - 이지현 (03)
🎸일렉 | 베이스 - 윤다열 | 양세현
🥁드럼 - 정세빈

🗓연습시간:
토요일 4:00-6:00 @ 본당
주일 1:00–1:30 @ 본당

🎶찬양곡:
1️⃣ 주님의 은혜 넘치네 (G)
2️⃣ 그 사랑 (G)
3️⃣ 우리가 넉넉히 이기느니라 (A)
4️⃣ 임재 (G)

🤝공동체 고백:
🎵 우리는 주의 움직이는 교회 (G)

🔑키워드: 소망, 그리스도, 사랑

🔗레퍼런스: https://youtube.com/playlist?list=PLYh22uyW-aqU&si=F7ZYgpVDWU-QgIRU

***이번 주 1:40분부터 다 함께 예배 전 기도 드립니다!***`;

describe('parseWorshipAnnouncement', () => {
  const notice = parseWorshipAnnouncement(NOTICE);

  it('reads the 찬양곡 in order, with their keys', () => {
    expect(notice?.songs).toEqual([
      { title: '주님의 은혜 넘치네', key: 'G' },
      { title: '그 사랑', key: 'G' },
      { title: '우리가 넉넉히 이기느니라', key: 'A' },
      { title: '임재', key: 'G' },
    ]);
  });

  it('keeps the 공동체 고백 apart from the 찬양곡', () => {
    expect(notice?.confession).toEqual({ title: '우리는 주의 움직이는 교회', key: 'G' });
  });

  it('reads the date, 본문 and 주제', () => {
    expect(notice?.date).toBe('2026.10.04');
    expect(notice?.scripture).toBe('로마서 8장 31-39절');
    expect(notice?.theme).toBe('끝까지 흔들리지 않을 이유');
  });

  it('never takes the line-up, practice times or keywords for songs', () => {
    const titles = notice?.songs.map((song) => song.title).join(' ') ?? '';
    for (const word of ['인도자', '어쿠', '토요일', '키워드', '소망', '레퍼런스', '기도']) {
      expect(titles).not.toContain(word);
    }
  });

  it('reads other ways of numbering and writing keys', () => {
    const other = parseWorshipAnnouncement(
      ['찬양 순서', '1. 첫째 곡 - G', '2) 둘째 곡 [F#m]', '3. 셋째 곡 (F -> G)', '• 넷째 곡', '공동체 고백: 고백송 (E)'].join('\n'),
    );
    expect(other?.songs).toEqual([
      { title: '첫째 곡', key: 'G' },
      { title: '둘째 곡', key: 'F#m' },
      { title: '셋째 곡', key: 'F -> G' },
      { title: '넷째 곡' },
    ]);
    expect(other?.confession).toEqual({ title: '고백송', key: 'E' });
  });

  it('reads a list written on the label line', () => {
    expect(parseWorshipAnnouncement('찬양곡: 그 사랑 (G), 임재 (G)')?.songs).toEqual([
      { title: '그 사랑', key: 'G' },
      { title: '임재', key: 'G' },
    ]);
  });

  it('has nothing to decide without a 찬양곡 list', () => {
    expect(parseWorshipAnnouncement('📖 본문: 로마서 8장\n라인업:\n👤 인도자 – 조인서')).toBeNull();
    expect(parseWorshipAnnouncement('')).toBeNull();
  });
});

describe('parseAnnouncedSong', () => {
  it('keeps parentheses that are not a key in the title', () => {
    expect(parseAnnouncedSong('내게로부터 눈을 들어 (시선) (A)')).toEqual({ title: '내게로부터 눈을 들어 (시선)', key: 'A' });
    expect(parseAnnouncedSong('영접송 (내 맘을 엽니다)')).toEqual({ title: '영접송 (내 맘을 엽니다)' });
  });
});

describe('matchAnnouncement', () => {
  const conti = [
    { title: '주 신실하심 놀라워', key: 'G' },
    { title: '그 사랑', key: 'G' },
    { title: '우리가 넉넉히 이기느니라', key: 'A' },
    { title: '임재', key: 'G' },
  ];

  it('finds a song the conti calls by another name in its slot', () => {
    const { pairs, dropped } = matchAnnouncement(conti, parseWorshipAnnouncement(NOTICE)!.songs);
    expect(pairs.map((pair) => pair.item?.title)).toEqual(conti.map((song) => song.title));
    expect(dropped).toEqual([]);
  });

  it('follows the notice order when it differs from the conti', () => {
    const { pairs } = matchAnnouncement(conti, [{ title: '임재' }, { title: '그 사랑' }]);
    expect(pairs.map((pair) => pair.item?.title)).toEqual(['임재', '그 사랑']);
  });

  it('forgives a letter slipped in a title', () => {
    const { pairs } = matchAnnouncement(conti, [{ title: '주 신실하신 놀라워', key: 'G' }]);
    expect(pairs[0].item?.title).toBe('주 신실하심 놀라워');
  });

  it('does not pair songs whose keys tell them apart', () => {
    const { pairs, dropped } = matchAnnouncement(
      [{ title: 'A곡', key: 'G' }, { title: 'D곡', key: 'G' }],
      [{ title: 'A곡', key: 'G' }, { title: 'E곡', key: 'A' }],
    );
    expect(pairs[1].item).toBeUndefined();
    expect(dropped.map((song) => song.title)).toEqual(['D곡']);
  });
});

describe('applyAnnouncementToEntries', () => {
  const entries: ContiSongEntry[] = [
    { title: '주 신실하심 놀라워', key: 'G', pageIndex: 4, description: '은혜의 찬양', order: ['I', 'V1', 'C'] },
    { title: '그 사랑', key: 'G', pageIndex: 5 },
    { title: '우리가 넉넉히 이기느니라', key: 'A', pageIndex: 6 },
    { title: '임재', key: 'G', pageIndex: 7 },
  ];

  it("takes the notice's names and keys and the conti's pages, notes and 진행", () => {
    const result = applyAnnouncementToEntries(entries, parseWorshipAnnouncement(NOTICE)!, [4, 5, 6, 7, 8, 9]);
    expect(result.entries.map((e) => [e.title, e.key, e.pageIndex])).toEqual([
      ['주님의 은혜 넘치네', 'G', 4],
      ['그 사랑', 'G', 5],
      ['우리가 넉넉히 이기느니라', 'A', 6],
      ['임재', 'G', 7],
    ]);
    expect(result.entries[0].description).toBe('은혜의 찬양');
    expect(result.entries[0].order).toEqual(['I', 'V1', 'C']);
    expect(result.renamed).toEqual([{ from: '주 신실하심 놀라워', to: '주님의 은혜 넘치네' }]);
    expect(result.added).toEqual([]);
    expect(result.dropped).toEqual([]);
  });

  it('gives a song only the notice lists the next page no song holds', () => {
    const notice = parseWorshipAnnouncement('찬양곡:\n1. 그 사랑 (G)\n2. 영접송 (G)')!;
    const result = applyAnnouncementToEntries(entries, notice, [4, 5, 6, 7, 8, 9]);
    expect(result.entries.map((e) => [e.title, e.pageIndex])).toEqual([
      ['그 사랑', 5],
      ['영접송', 4],
    ]);
    expect(result.added).toEqual(['영접송']);
  });

  it('leaves the 공동체 고백 out of the songs even when the conti lists it', () => {
    const withConfession = [...entries, { title: '우리는 주의 움직이는 교회', key: 'G', pageIndex: 9 }];
    const result = applyAnnouncementToEntries(withConfession, parseWorshipAnnouncement(NOTICE)!, [4, 5, 6, 7, 8, 9]);
    expect(result.entries.map((e) => e.title)).not.toContain('우리는 주의 움직이는 교회');
    expect(result.dropped).toEqual([]);
  });
});
