// Reads a 수련회 conti's 악보 pages with the models the 주일예배 page uses.
//
// A retreat's 악보 PDF holds every 집회's songs — twenty-odd pages — so the
// pages go to the models a few at a time. A page's text layer names its song
// when it has one; a scanned page is first read for its title only, and a
// song whose lyrics are already known (last year's retreat, the 찬양
// 라이브러리) is never read further. Only the pages left are read in full.
import { recognizeAdaptiveBatch } from '../lib/ai/adaptiveRecognition';
import { getSyncedAiSettings, type AiSettings } from '../lib/ai/aiSettings';
import { createRecognitionDeadline } from '../lib/ai/recognitionBudget';
import type { ModelReliability } from '../lib/ai/modelReliability';
import type { ParsedScore } from '../lib/ai/scoreParser';
import { fetchModelReliabilities } from '../lib/learning/learningClient';
import { mergeWebLyrics } from '../lib/lyrics/mergeWebLyrics';
import { SAME_TITLE_THRESHOLD, titleSimilarity } from '../lib/utils/contiAlignment';
import { matchKnownTitle, scoreLyricsText, titleInPageText } from './scores';
import type { ScoreSong } from './types';

/** Pages sent to the models in one request. */
const PAGES_PER_REQUEST = 6;
/** PNG width a page is read at, as on the 주일예배 page. */
export const SCORE_RENDER_WIDTH = 1600;

export interface ScorePage {
  /** For a song whose title could not be read, e.g. "악보.pdf p.3". */
  label: string;
  /** The page's text layer; empty for a scan. */
  text: string;
  /** The page as a PNG data URL. */
  render: () => Promise<string>;
}

export interface ScoreReadOptions {
  /** The conti's table titles: a page read as one of these takes that title. */
  tableTitles: string[];
  /** Titles last year's retreat or the 찬양 라이브러리 has lyrics for. */
  knownTitles: string[];
  /** Whether a song's lyrics still have to be read off its page. */
  needsLyrics: (title: string) => boolean;
  /**
   * Read a page whose title stayed unknown too. Without a song table every
   * page is a song to list; with one, a page that is none of its songs is
   * not worth a request.
   */
  readUntitled: boolean;
  onProgress?: (message: string) => void;
}

export interface ScoreReadResult {
  /** In page order, one per score page whose title or lyrics were read. */
  songs: ScoreSong[];
  /** Why the models stopped, when they did. */
  error?: string;
}

function inGroups<T>(items: T[], size: number): T[][] {
  const groups: T[][] = [];
  for (let at = 0; at < items.length; at += size) groups.push(items.slice(at, at + size));
  return groups;
}

export async function readRetreatScores(pages: ScorePage[], options: ScoreReadOptions): Promise<ScoreReadResult> {
  const { tableTitles, knownTitles, needsLyrics, readUntitled, onProgress } = options;
  const titles: (string | undefined)[] = pages.map(
    (page) => titleInPageText(page.text, tableTitles) ?? titleInPageText(page.text, knownTitles, 3),
  );
  const notScore = new Set<number>();
  const lyrics = new Map<number, string>();
  let error: string | undefined;

  const images = new Map<number, Promise<string>>();
  const image = (index: number) => {
    if (!images.has(index)) images.set(index, pages[index].render());
    return images.get(index)!;
  };
  let setup: Promise<[AiSettings, ModelReliability[]]> | undefined;
  const models = () => (setup ??= Promise.all([getSyncedAiSettings(), fetchModelReliabilities().catch(() => [])]));

  const read = async (indexes: number[], mode: 'titles' | 'full', each: (index: number, score: ParsedScore) => void) => {
    let done = 0;
    for (const group of inGroups(indexes, PAGES_PER_REQUEST)) {
      onProgress?.(`악보 ${mode === 'titles' ? '제목' : '가사'} 읽는 중… (${done}/${indexes.length}쪽)`);
      try {
        const [settings, reliabilities] = await models();
        const urls = await Promise.all(group.map(image));
        const deadline = createRecognitionDeadline();
        const result = await recognizeAdaptiveBatch(
          urls,
          settings,
          mode,
          mode === 'full' ? group.map((index) => titles[index]) : undefined,
          reliabilities,
          undefined,
          [],
          deadline.stageEndsAt(mode === 'titles' ? 'titles' : 'lyrics'),
        );
        group.forEach((index, at) => {
          const score = result.scores[at];
          if (!score) return;
          if (score.pageType === 'non_score') notScore.add(index);
          else each(index, score);
        });
      } catch (reason) {
        error = reason instanceof Error ? reason.message : String(reason);
        return;
      }
      done += group.length;
    }
  };
  const takeTitle = (index: number, score: ParsedScore) => {
    const title = score.title?.trim();
    if (!titles[index] && title) titles[index] = matchKnownTitle(title, tableTitles, knownTitles) ?? title;
  };

  const untitled = pages.map((_page, index) => index).filter((index) => !titles[index]);
  await read(untitled, 'titles', takeTitle);

  if (!error) {
    const toRead = pages
      .map((_page, index) => index)
      .filter((index) => !notScore.has(index))
      .filter((index) => {
        const title = titles[index];
        return title ? needsLyrics(title) : readUntitled;
      });
    for (const index of images.keys()) if (!toRead.includes(index)) images.delete(index);
    await read(toRead, 'full', (index, score) => {
      // Read with the title as a hint, a page that still names another song
      // is that song: a title found in a text layer can be a lyric.
      const title = score.title?.trim();
      if (title && titles[index] && titleSimilarity(title, titles[index]) < SAME_TITLE_THRESHOLD) titles[index] = undefined;
      takeTitle(index, score);
      // The same 띄어쓰기·맞춤법 pass the 주일예배 page gives a new song.
      const text = scoreLyricsText(mergeWebLyrics(score, null).score);
      if (text) lyrics.set(index, text);
    });
  }

  const songs = pages.flatMap((page, index): ScoreSong[] => {
    if (notScore.has(index)) return [];
    const text = lyrics.get(index) ?? '';
    const title = titles[index] ?? (text ? `악보 ${page.label}` : undefined);
    return title ? [{ title, lyrics: text }] : [];
  });
  return { songs, ...(error ? { error } : {}) };
}
