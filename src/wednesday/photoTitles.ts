// Puts a week's songs in from their 악보 사진 alone: one song per photo, its
// title read off the page by the same models the 주일예배 page reads a conti
// with, and the photo itself as the song's slide until the search finds its
// 찬양 PPT.
//
// The pure half (file names, known titles, which photos are one song) is
// apart from the model call so it can be checked without a browser.
import { recognizeAdaptiveBatch } from '../lib/ai/adaptiveRecognition';
import { getSyncedAiSettings } from '../lib/ai/aiSettings';
import { createRecognitionDeadline } from '../lib/ai/recognitionBudget';
import { fetchModelReliabilities } from '../lib/learning/learningClient';
import { normalizeTitle } from '../lib/storage/library';

/** The width a photo is read at, as a conti page is on the 주일예배 page. */
export const PHOTO_READ_WIDTH = 1600;
/** Photos sent to the models in one request. */
const PHOTOS_PER_REQUEST = 6;
/**
 * How alike a reading and a title must be to be the same song: the same
 * letters, or one syllable misread in a title of a few words.
 */
const SAME_SONG_THRESHOLD = 0.8;

export interface PhotoToRead {
  name: string;
  mimeType: 'image/png' | 'image/jpeg';
  data: ArrayBuffer;
  width: number;
  height: number;
}

export interface PhotoTitles {
  /** Per photo, in order: the title read off it, or undefined. */
  titles: (string | undefined)[];
  /** Why the models could not read them, when they could not. */
  error?: string;
}

/**
 * Names a phone, a messenger or a scanner gives a picture, which say nothing
 * about the song: IMG_1234, KakaoTalk_20261005_…, 스크린샷 2026-10-05, 1.jpg.
 */
const GENERIC_NAME =
  /^(?:img|image|dsc|dcim|pxl|photo|picture|scan|screenshot|screen shot|kakaotalk|messages?|download|capture|untitled|사진|이미지|스크린샷|캡처|화면 캡처|스캔|제목 ?없음|새 파일)(?=$|[\s_\-.(\d])/i;

/** What a person adds to a file name around the title: 악보, the key, a copy number. */
const FILE_NAME_NOISE =
  /\s*(?:\(\d+\)|\[\d+\]|-\s*복사본|복사본|악보|코드|ppt|pdf|(?:[A-G][#b]?m?\s*(?:key|키)|(?:key|키)\s*[A-G][#b]?m?)|\(\s*[A-G][#b]?m?\s*\))\s*/gi;

/**
 * The song title a photo's file name spells, when it spells one. A title is
 * Korean: a name with no Hangul is a camera's, and a messenger's name is
 * recognised and refused even when it has some.
 */
export function titleFromFileName(name: string): string | undefined {
  const base = name.replace(/\.[a-z0-9]+$/i, '').replace(/[_]+/g, ' ').trim();
  if (!base || GENERIC_NAME.test(base)) return undefined;
  const title = base
    .replace(FILE_NAME_NOISE, ' ')
    .replace(/[(\[]\s*[)\]]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!/[가-힣]/.test(title)) return undefined;
  // What is left once the noise is gone must still be words, not "1 2".
  if (normalizeTitle(title).replace(/\d/g, '').length < 2) return undefined;
  return title;
}

function letterPairs(text: string): Map<string, number> {
  const pairs = new Map<string, number>();
  for (let at = 0; at < text.length - 1; at++) {
    const pair = text.slice(at, at + 2);
    pairs.set(pair, (pairs.get(pair) ?? 0) + 1);
  }
  return pairs;
}

/**
 * How alike two titles read, 0..1, by the letter pairs they share. One title
 * inside the other is not enough on its own: 은혜 is inside 주님의 은혜, and
 * that is another song.
 */
function readsAlike(a: string, b: string): number {
  const left = normalizeTitle(a);
  const right = normalizeTitle(b);
  if (!left || !right) return 0;
  if (left === right) return 1;
  const pairs = letterPairs(right);
  let shared = 0;
  for (const [pair, count] of letterPairs(left)) shared += Math.min(count, pairs.get(pair) ?? 0);
  return (2 * shared) / Math.max(1, left.length - 1 + right.length - 1);
}

/**
 * The spelling a reading stands for: a title already known — the 수요예배
 * library's or the 찬양 라이브러리's — when one reads the same, or the
 * reading itself. A note the page prints after the title, "(Live)", is not
 * part of it.
 */
export function knownTitleFor(read: string, known: readonly string[]): string {
  const title = read.replace(/\s*[(\[][^)\]]*[)\]]\s*$/, '').trim() || read.trim();
  let best: { title: string; score: number } | undefined;
  for (const candidate of known) {
    const score = readsAlike(title, candidate);
    if (score >= SAME_SONG_THRESHOLD && (!best || score > best.score)) best = { title: candidate, score };
  }
  return best?.title ?? title;
}

/**
 * Which photos are one song: a 악보 two pages long arrives as two photos in a
 * row, and both read as the same title. A photo whose title could not be read
 * stays a song of its own — it may be the first page of the next song, and a
 * wrong join is harder to undo than a separate card.
 */
export function groupPhotosBySong(titles: readonly (string | undefined)[]): number[][] {
  const groups: number[][] = [];
  titles.forEach((title, index) => {
    const previous = groups[groups.length - 1];
    const before = previous ? titles[previous[0]] : undefined;
    if (title && before && sameTitle(title, before)) previous.push(index);
    else groups.push([index]);
  });
  return groups;
}

function sameTitle(a: string, b: string): boolean {
  return readsAlike(a, b) >= SAME_SONG_THRESHOLD;
}

/** A photo as the models take it: a JPEG data URL no wider than PHOTO_READ_WIDTH. */
async function photoDataUrl(photo: PhotoToRead): Promise<string> {
  const bitmap = await createImageBitmap(new Blob([photo.data], { type: photo.mimeType }));
  try {
    const scale = Math.min(1, PHOTO_READ_WIDTH / bitmap.width);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext('2d');
    if (!context) throw new Error('사진을 읽지 못했습니다.');
    // A transparent PNG reads as black on a JPEG; the page is white paper.
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', 0.88);
  } finally {
    bitmap.close();
  }
}

/**
 * Read each photo's song title with the recognition models. Never throws: a
 * photo whose title could not be read comes back undefined, with the reason
 * once, and the operator types that title instead.
 */
export async function readPhotoTitles(photos: readonly PhotoToRead[], known: readonly string[]): Promise<PhotoTitles> {
  const titles: (string | undefined)[] = photos.map(() => undefined);
  if (photos.length === 0) return { titles };
  try {
    const [settings, reliabilities] = await Promise.all([
      getSyncedAiSettings(),
      fetchModelReliabilities().catch(() => []),
    ]);
    const urls = await Promise.all(photos.map(photoDataUrl));
    const deadline = createRecognitionDeadline();
    for (let at = 0; at < urls.length; at += PHOTOS_PER_REQUEST) {
      const result = await recognizeAdaptiveBatch(
        urls.slice(at, at + PHOTOS_PER_REQUEST),
        settings,
        'titles',
        undefined,
        reliabilities,
        undefined,
        [],
        deadline.stageEndsAt('titles'),
      );
      result.scores.forEach((score, offset) => {
        const read = score && score.pageType !== 'non_score' ? score.title?.trim() : undefined;
        if (read) titles[at + offset] = knownTitleFor(read, known);
      });
    }
    return { titles };
  } catch (error) {
    return { titles, error: error instanceof Error ? error.message : String(error) };
  }
}
