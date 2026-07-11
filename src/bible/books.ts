import type { BibleBook } from './types';

/** 성경 66권: 한/영 이름, 한글 약어, 장 수. Ported from kccp-bible-slide/src/data/books.ts. */
export const BIBLE_BOOKS: BibleBook[] = [
  { id: 1, nameKo: '창세기', nameEn: 'Genesis', abbrKo: ['창'], chapters: 50 },
  { id: 2, nameKo: '출애굽기', nameEn: 'Exodus', abbrKo: ['출'], chapters: 40 },
  { id: 3, nameKo: '레위기', nameEn: 'Leviticus', abbrKo: ['레'], chapters: 27 },
  { id: 4, nameKo: '민수기', nameEn: 'Numbers', abbrKo: ['민'], chapters: 36 },
  { id: 5, nameKo: '신명기', nameEn: 'Deuteronomy', abbrKo: ['신'], chapters: 34 },
  { id: 6, nameKo: '여호수아', nameEn: 'Joshua', abbrKo: ['수'], chapters: 24 },
  { id: 7, nameKo: '사사기', nameEn: 'Judges', abbrKo: ['삿'], chapters: 21 },
  { id: 8, nameKo: '룻기', nameEn: 'Ruth', abbrKo: ['룻'], chapters: 4 },
  { id: 9, nameKo: '사무엘상', nameEn: '1 Samuel', abbrKo: ['삼상'], chapters: 31 },
  { id: 10, nameKo: '사무엘하', nameEn: '2 Samuel', abbrKo: ['삼하'], chapters: 24 },
  { id: 11, nameKo: '열왕기상', nameEn: '1 Kings', abbrKo: ['왕상'], chapters: 22 },
  { id: 12, nameKo: '열왕기하', nameEn: '2 Kings', abbrKo: ['왕하'], chapters: 25 },
  { id: 13, nameKo: '역대상', nameEn: '1 Chronicles', abbrKo: ['대상'], chapters: 29 },
  { id: 14, nameKo: '역대하', nameEn: '2 Chronicles', abbrKo: ['대하'], chapters: 36 },
  { id: 15, nameKo: '에스라', nameEn: 'Ezra', abbrKo: ['스'], chapters: 10 },
  { id: 16, nameKo: '느헤미야', nameEn: 'Nehemiah', abbrKo: ['느'], chapters: 13 },
  { id: 17, nameKo: '에스더', nameEn: 'Esther', abbrKo: ['에'], chapters: 10 },
  { id: 18, nameKo: '욥기', nameEn: 'Job', abbrKo: ['욥'], chapters: 42 },
  { id: 19, nameKo: '시편', nameEn: 'Psalms', abbrKo: ['시'], chapters: 150 },
  { id: 20, nameKo: '잠언', nameEn: 'Proverbs', abbrKo: ['잠'], chapters: 31 },
  { id: 21, nameKo: '전도서', nameEn: 'Ecclesiastes', abbrKo: ['전'], chapters: 12 },
  { id: 22, nameKo: '아가', nameEn: 'Song of Solomon', abbrKo: ['아'], chapters: 8 },
  { id: 23, nameKo: '이사야', nameEn: 'Isaiah', abbrKo: ['사'], chapters: 66 },
  { id: 24, nameKo: '예레미야', nameEn: 'Jeremiah', abbrKo: ['렘'], chapters: 52 },
  { id: 25, nameKo: '예레미야애가', nameEn: 'Lamentations', abbrKo: ['애'], chapters: 5 },
  { id: 26, nameKo: '에스겔', nameEn: 'Ezekiel', abbrKo: ['겔'], chapters: 48 },
  { id: 27, nameKo: '다니엘', nameEn: 'Daniel', abbrKo: ['단'], chapters: 12 },
  { id: 28, nameKo: '호세아', nameEn: 'Hosea', abbrKo: ['호'], chapters: 14 },
  { id: 29, nameKo: '요엘', nameEn: 'Joel', abbrKo: ['욜'], chapters: 3 },
  { id: 30, nameKo: '아모스', nameEn: 'Amos', abbrKo: ['암'], chapters: 9 },
  { id: 31, nameKo: '오바댜', nameEn: 'Obadiah', abbrKo: ['옵'], chapters: 1 },
  { id: 32, nameKo: '요나', nameEn: 'Jonah', abbrKo: ['욘'], chapters: 4 },
  { id: 33, nameKo: '미가', nameEn: 'Micah', abbrKo: ['미'], chapters: 7 },
  { id: 34, nameKo: '나훔', nameEn: 'Nahum', abbrKo: ['나'], chapters: 3 },
  { id: 35, nameKo: '하박국', nameEn: 'Habakkuk', abbrKo: ['합'], chapters: 3 },
  { id: 36, nameKo: '스바냐', nameEn: 'Zephaniah', abbrKo: ['습'], chapters: 3 },
  { id: 37, nameKo: '학개', nameEn: 'Haggai', abbrKo: ['학'], chapters: 2 },
  { id: 38, nameKo: '스가랴', nameEn: 'Zechariah', abbrKo: ['슥'], chapters: 14 },
  { id: 39, nameKo: '말라기', nameEn: 'Malachi', abbrKo: ['말'], chapters: 4 },
  { id: 40, nameKo: '마태복음', nameEn: 'Matthew', abbrKo: ['마'], chapters: 28 },
  { id: 41, nameKo: '마가복음', nameEn: 'Mark', abbrKo: ['막'], chapters: 16 },
  { id: 42, nameKo: '누가복음', nameEn: 'Luke', abbrKo: ['눅'], chapters: 24 },
  { id: 43, nameKo: '요한복음', nameEn: 'John', abbrKo: ['요'], chapters: 21 },
  { id: 44, nameKo: '사도행전', nameEn: 'Acts', abbrKo: ['행'], chapters: 28 },
  { id: 45, nameKo: '로마서', nameEn: 'Romans', abbrKo: ['롬'], chapters: 16 },
  { id: 46, nameKo: '고린도전서', nameEn: '1 Corinthians', abbrKo: ['고전'], chapters: 16 },
  { id: 47, nameKo: '고린도후서', nameEn: '2 Corinthians', abbrKo: ['고후'], chapters: 13 },
  { id: 48, nameKo: '갈라디아서', nameEn: 'Galatians', abbrKo: ['갈'], chapters: 6 },
  { id: 49, nameKo: '에베소서', nameEn: 'Ephesians', abbrKo: ['엡'], chapters: 6 },
  { id: 50, nameKo: '빌립보서', nameEn: 'Philippians', abbrKo: ['빌'], chapters: 4 },
  { id: 51, nameKo: '골로새서', nameEn: 'Colossians', abbrKo: ['골'], chapters: 4 },
  { id: 52, nameKo: '데살로니가전서', nameEn: '1 Thessalonians', abbrKo: ['살전'], chapters: 5 },
  { id: 53, nameKo: '데살로니가후서', nameEn: '2 Thessalonians', abbrKo: ['살후'], chapters: 3 },
  { id: 54, nameKo: '디모데전서', nameEn: '1 Timothy', abbrKo: ['딤전'], chapters: 6 },
  { id: 55, nameKo: '디모데후서', nameEn: '2 Timothy', abbrKo: ['딤후'], chapters: 4 },
  { id: 56, nameKo: '디도서', nameEn: 'Titus', abbrKo: ['딛'], chapters: 3 },
  { id: 57, nameKo: '빌레몬서', nameEn: 'Philemon', abbrKo: ['몬'], chapters: 1 },
  { id: 58, nameKo: '히브리서', nameEn: 'Hebrews', abbrKo: ['히'], chapters: 13 },
  { id: 59, nameKo: '야고보서', nameEn: 'James', abbrKo: ['약'], chapters: 5 },
  { id: 60, nameKo: '베드로전서', nameEn: '1 Peter', abbrKo: ['벧전'], chapters: 5 },
  { id: 61, nameKo: '베드로후서', nameEn: '2 Peter', abbrKo: ['벧후'], chapters: 3 },
  { id: 62, nameKo: '요한일서', nameEn: '1 John', abbrKo: ['요일'], chapters: 5 },
  { id: 63, nameKo: '요한이서', nameEn: '2 John', abbrKo: ['요이'], chapters: 1 },
  { id: 64, nameKo: '요한삼서', nameEn: '3 John', abbrKo: ['요삼'], chapters: 1 },
  { id: 65, nameKo: '유다서', nameEn: 'Jude', abbrKo: ['유'], chapters: 1 },
  { id: 66, nameKo: '요한계시록', nameEn: 'Revelation', abbrKo: ['계'], chapters: 22 },
];

export const TRANSLATIONS = [
  { id: 'nkrv', name: '개역개정', language: 'ko' },
  { id: 'ko', name: '개역한글', language: 'ko' },
  { id: 'saenew', name: '새번역', language: 'ko' },
  { id: 'esv', name: 'ESV', language: 'en' },
  { id: 'niv', name: 'NIV', language: 'en' },
  { id: 'kjv', name: 'KJV', language: 'en' },
] as const;

/** 한글 약어(가장 긴 것부터) → BibleBook. 정렬 순서가 "삼상" vs "삼" 같은 접두 충돌을 막아준다. */
const BOOKS_BY_ABBR = new Map<string, BibleBook>();
for (const book of BIBLE_BOOKS) {
  for (const abbr of book.abbrKo) BOOKS_BY_ABBR.set(abbr, book);
}

export function findBookByAbbr(abbr: string): BibleBook | undefined {
  return BOOKS_BY_ABBR.get(abbr);
}

/** Longest-match-first list of Korean abbreviations, for tokenizing "행1:8" etc. */
export const SORTED_ABBRS = [...BOOKS_BY_ABBR.keys()].sort((a, b) => b.length - a.length);
