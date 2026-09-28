// English lyrics from the web, for a 찬양집회 song the conti gives in Korean
// only: the proxy searches "<곡 제목> 영어 가사" and returns, for each post it
// read, the Korean and English lyric blocks in the order the post printed
// them (worker/src/praiseEnglishWeb.js). This file decides what they say.
//
// Most such posts print the song as Korean stanza, English stanza, Korean
// stanza… so blocks are paired back up into Korean/English stanzas, and each
// of this conti's Korean slides then takes the English of the stanza whose
// Korean it matches — the same matching that fills a song from last year's
// deck (englishLibrary.ts), so it does not matter which parts the post
// repeats or in what order. A post that gives only the English is laid over
// the song part by part (or line by line) when its shape agrees with the
// conti's; when it does not, nothing is guessed — the English is handed to
// the operator to paste, and to the AI as its source. A lyrics site such as
// Genius prints the English original under headings ([Verse 1], [Chorus]),
// so its stanzas are laid over the conti's parts of the same name.
import type { Song } from '../lib/utils/types';
import { parsePartHeading } from '../lib/lyrics/lyricsStructure';
import { planSectionSlides } from '../lib/utils/slidePlanner';
import { fillEnglishFromLibrary, koreanFoundIn, type EnglishSlide } from './englishLibrary';
import { normalizeLyricLine, planPraiseSong, slideKey } from './planner';
import type { PraiseEnglish } from './types';

const PROXY_URL = import.meta.env.VITE_RECOGNITION_PROXY_URL?.trim() || undefined;
const LOOKUP_TIMEOUT_MS = 25_000;

export interface WebEnglishBlock {
  lang: 'ko' | 'en';
  lines: string[];
  /** A heading printed right above it ("Verse 1", "후렴"), when there was one. */
  label?: string;
}

export interface WebEnglishCandidate {
  url: string;
  host: string;
  /** The post's heading. */
  title: string;
  /** The English title the post names the song by; '' when it names none. */
  englishTitle: string;
  score: number;
  blocks: WebEnglishBlock[];
}

export function hasWebEnglishLookup(): boolean {
  return Boolean(PROXY_URL);
}

function sanitizeBlocks(value: unknown): WebEnglishBlock[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((raw) => {
    if (!raw || typeof raw !== 'object') return [];
    const { lang, lines, label } = raw as Record<string, unknown>;
    if (lang !== 'ko' && lang !== 'en') return [];
    const clean = (Array.isArray(lines) ? lines : [])
      .filter((line): line is string => typeof line === 'string')
      .map((line) => line.trim())
      .filter(Boolean);
    if (clean.length === 0) return [];
    return [{ lang, lines: clean, ...(typeof label === 'string' && label.trim() ? { label: label.trim() } : {}) }];
  });
}

export function sanitizeWebEnglishCandidates(value: unknown): WebEnglishCandidate[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((raw) => {
    if (!raw || typeof raw !== 'object') return [];
    const item = raw as Record<string, unknown>;
    const url = typeof item.url === 'string' && /^https:\/\//.test(item.url) ? item.url : '';
    const blocks = sanitizeBlocks(item.blocks);
    if (!url || blocks.length === 0) return [];
    return [
      {
        url,
        host: typeof item.host === 'string' ? item.host : url.replace(/^https:\/\/([^/]+).*$/, '$1'),
        title: typeof item.title === 'string' ? item.title : '',
        englishTitle: typeof item.englishTitle === 'string' ? item.englishTitle.trim() : '',
        score: typeof item.score === 'number' ? item.score : 0,
        blocks,
      },
    ];
  });
}

/**
 * Ask the proxy to search the web for `title`'s English lyrics. With the
 * song's English title, the English original's lyrics page (Genius, or
 * "<English title> lyrics" on Google) is looked up too.
 */
export async function fetchWebEnglish(title: string, englishTitle = ''): Promise<WebEnglishCandidate[]> {
  if (!PROXY_URL) throw new Error('웹 검색 서버가 연결되어 있지 않습니다.');
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), LOOKUP_TIMEOUT_MS);
  const params = new URLSearchParams({ title: title.trim() });
  if (englishTitle.trim()) params.set('en', englishTitle.trim());
  try {
    const response = await fetch(`${PROXY_URL.replace(/\/$/, '')}/praise/english?${params}`, {
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`웹 검색 실패: HTTP ${response.status}`);
    let payload: { candidates?: unknown };
    try {
      payload = (await response.json()) as { candidates?: unknown };
    } catch {
      throw new Error('웹 검색 서버가 응답하지 않았습니다');
    }
    return sanitizeWebEnglishCandidates(payload?.candidates);
  } finally {
    window.clearTimeout(timer);
  }
}

// ---- pairing a post's blocks ---------------------------------------------------

/** Consecutive blocks in one language. */
function languageRuns(blocks: WebEnglishBlock[]): { lang: 'ko' | 'en'; start: number; end: number }[] {
  const runs: { lang: 'ko' | 'en'; start: number; end: number }[] = [];
  blocks.forEach((block, index) => {
    const last = runs[runs.length - 1];
    if (last && last.lang === block.lang) last.end = index + 1;
    else runs.push({ lang: block.lang, start: index, end: index + 1 });
  });
  return runs;
}

/**
 * The post's Korean/English stanzas, paired the way the post printed them.
 *
 * Two layouts are recognised. Interleaved — a Korean stanza, its English, the
 * next Korean stanza… (or English first) — pairs each block with its
 * neighbour; which neighbour is decided over the whole post: the side on
 * which the song's own Korean stanzas most often have English next to them
 * (Korean first when it is even, as Korean blogs usually print it). Grouped —
 * all the Korean, then all the English, stanza for stanza — pairs them by
 * position, when the two runs have the same number of stanzas. Anything else
 * yields no pairs rather than a guess.
 */
export function pairWebBlocks(blocks: WebEnglishBlock[], songLines: string[]): EnglishSlide[] {
  const isSong = (block: WebEnglishBlock) => block.lang === 'ko' && koreanFoundIn(block.lines, songLines);
  const runs = languageRuns(blocks);
  const pairs: EnglishSlide[] = [];
  const used = new Set<number>();

  // Grouped: a run of the song's Korean stanzas, then as many English ones.
  // The post's own Korean at either end of the run — its heading, a word of
  // introduction — is not a stanza, so it is not counted.
  for (let r = 0; r + 1 < runs.length; r++) {
    const [first, second] = [runs[r], runs[r + 1]];
    const ko = first.lang === 'ko' ? first : second;
    const en = first.lang === 'ko' ? second : first;
    if (used.has(en.start)) continue;
    let start = ko.start;
    let end = ko.end;
    while (start < end && !isSong(blocks[start])) start += 1;
    while (end > start && !isSong(blocks[end - 1])) end -= 1;
    const length = end - start;
    if (length < 2 || length !== en.end - en.start) continue;
    const songStanzas = blocks.slice(start, end).filter(isSong).length;
    if (songStanzas * 2 < length) continue;
    for (let i = 0; i < length; i++) {
      pairs.push({ ko: [...blocks[start + i].lines], en: [...blocks[en.start + i].lines] });
      used.add(start + i);
      used.add(en.start + i);
    }
  }

  // Interleaved: single blocks alternating between the languages. One side
  // of a pair must be a block on its own; the other need only be the end of
  // its run facing it. A post's own Korean — its heading, a sentence
  // introducing the song — often runs straight into the first stanza, and a
  // stray English line (a credit, a repeated tag) often follows the last,
  // and the stanza next to them is still a pair. Two runs meeting — all the
  // Korean, then all the English — are not: which goes with which is the
  // grouped rule's to say.
  const runOf = (index: number) => runs.find((candidate) => candidate.start <= index && index < candidate.end);
  const single = (index: number) => {
    const run = runOf(index);
    return Boolean(run && run.end - run.start === 1);
  };
  const facing = (index: number, offset: 1 | -1) => {
    const run = runOf(index);
    return Boolean(run && (offset === 1 ? index === run.end - 1 : index === run.start));
  };
  const pairsWith = (index: number, offset: 1 | -1) => {
    const other = index + offset;
    if (other < 0 || other >= blocks.length || blocks[other].lang !== 'en' || used.has(other)) return false;
    return facing(index, offset) && facing(other, offset === 1 ? -1 : 1) && (single(index) || single(other));
  };
  let after = 0;
  let before = 0;
  blocks.forEach((block, index) => {
    if (used.has(index) || !isSong(block)) return;
    if (pairsWith(index, 1)) after += 1;
    if (pairsWith(index, -1)) before += 1;
  });
  if (after === 0 && before === 0) return pairs;
  const offset = after >= before ? 1 : -1;
  blocks.forEach((block, index) => {
    if (used.has(index) || !isSong(block) || !pairsWith(index, offset)) return;
    pairs.push({ ko: [...block.lines], en: [...blocks[index + offset].lines] });
    used.add(index);
    used.add(index + offset);
  });
  return pairs;
}

// ---- English only ---------------------------------------------------------------

function wordCount(line: string): number {
  return line.split(/\s+/).filter((word) => /[A-Za-z]{2,}/.test(word)).length;
}

/**
 * The song's English stanzas from a post that prints English only, each
 * stanza once: repeats of a chorus are dropped, and blocks that are headings
 * or captions (one or two short lines) are not stanzas.
 */
export function englishStanzas(blocks: WebEnglishBlock[]): string[][] {
  const stanzas: string[][] = [];
  const seen = new Set<string>();
  for (const block of blocks) {
    if (block.lang !== 'en') continue;
    const lines = block.lines.filter((line) => wordCount(line) >= 2);
    if (lines.length < 2) continue;
    const key = lines.map(normalizeLyricLine).join('/');
    if (seen.has(key)) continue;
    seen.add(key);
    stanzas.push(lines);
  }
  return stanzas;
}

/** Share `english` across slides in proportion to their Korean lines, in order. */
function shareAcross(slides: string[][], english: string[]): string[][] {
  const total = slides.reduce((sum, lines) => sum + lines.length, 0);
  let at = 0;
  let cumulative = 0;
  return slides.map((lines, index) => {
    cumulative += lines.length;
    const end = index === slides.length - 1 ? english.length : Math.round((cumulative / total) * english.length);
    const part = english.slice(at, Math.max(at, end));
    at = Math.max(at, end);
    return part;
  });
}

/**
 * An English-only post laid over the song, when its shape agrees with the
 * conti's: one stanza per part (each part's English shared across that
 * part's slides), or exactly one English line per Korean line. Null when
 * neither holds — the English is then the operator's to place.
 */
export function alignEnglishOnly(song: Song, stanzas: string[][]): Record<string, string[]> | null {
  const parts = planSectionSlides(song);
  if (parts.length === 0 || stanzas.length === 0) return null;
  const result: Record<string, string[]> = {};
  if (stanzas.length === parts.length) {
    parts.forEach((part, index) => {
      shareAcross(part.slides, stanzas[index]).forEach((english, slide) => {
        if (english.length > 0) result[slideKey(part.slides[slide])] = english;
      });
    });
    return result;
  }
  const slides = parts.flatMap((part) => part.slides);
  const koLines = slides.reduce((sum, lines) => sum + lines.length, 0);
  const english = stanzas.flat();
  if (english.length !== koLines) return null;
  let at = 0;
  for (const lines of slides) {
    result[slideKey(lines)] = english.slice(at, at + lines.length);
    at += lines.length;
  }
  return result;
}

/** A conti part's label as family and number: "V" → "V1", "C2" → "C2", "PC" → "PC1". */
function partKey(label: string): string {
  const match = /^([A-Z]+)(\d*)$/.exec(label.trim().toUpperCase());
  return match ? `${match[1]}${match[2] || '1'}` : label.trim().toUpperCase();
}

/** A page's heading ("Verse 1", "Chorus", "후렴", "2절") as the same key; null when it names no part. */
function headingKey(label: string): string | null {
  const heading = parsePartHeading(label.replace(/:.*$/, '').trim());
  return heading ? `${heading.family}${heading.index ?? 1}` : null;
}

/**
 * An English-only page laid over the song by its headings: each conti part
 * takes the first English stanza printed under a heading of the same name
 * (V/V1 ← Verse 1, V2 ← Verse 2, C ← Chorus, PC ← Pre-Chorus, B ← Bridge),
 * shared across that part's slides. That is how a lyrics site prints an
 * English original, and it does not matter how often it repeats the chorus
 * or which parts the conti leaves out.
 *
 * A stanza far longer or shorter than the part it would go under is not
 * that part's English, so it is left out. Null unless at least two parts
 * (or a one-part song's only part) find their English this way.
 */
export function alignEnglishByLabels(song: Song, blocks: WebEnglishBlock[]): Record<string, string[]> | null {
  const byKey = new Map<string, string[]>();
  for (const block of blocks) {
    if (block.lang !== 'en' || !block.label) continue;
    const key = headingKey(block.label);
    const lines = block.lines.filter((line) => wordCount(line) >= 1);
    if (!key || byKey.has(key) || lines.length === 0) continue;
    byKey.set(key, lines);
  }
  if (byKey.size === 0) return null;
  const parts = planSectionSlides(song);
  const result: Record<string, string[]> = {};
  let matched = 0;
  for (const part of parts) {
    const english = byKey.get(partKey(part.label));
    if (!english) continue;
    const koLines = part.slides.reduce((sum, lines) => sum + lines.length, 0);
    if (english.length > koLines * 3 || english.length * 2 < koLines) continue;
    matched += 1;
    shareAcross(part.slides, english).forEach((lines, slide) => {
      if (lines.length > 0) result[slideKey(part.slides[slide])] = lines;
    });
  }
  return matched >= Math.min(2, parts.length) ? result : null;
}

// ---- putting it together ------------------------------------------------------

/** One title's web lookup, as the page tracks it. */
export type WebEnglishLookup =
  | { status: 'searching' }
  | { status: 'done'; candidates: WebEnglishCandidate[] }
  | { status: 'error'; message: string };

/** What a lookup did for one song, as its card shows it. */
export interface WebEnglishOutcome {
  url?: string;
  host?: string;
  /** Slides it filled (0 when the English could not be laid over the song). */
  filled: number;
  /** The English, for the operator to paste, when it could not be. */
  pasteText?: string;
}

export interface WebEnglishFill {
  english: PraiseEnglish;
  /** Korean slides that gained English. */
  filled: number;
  titleFilled: boolean;
  /** The post the English came from. */
  source?: { url: string; host: string };
  /** The post's English, as text to paste — for a post that could not be laid over the song. */
  pasteText?: string;
}

function songKoreanLines(song: Song): string[] {
  return planSectionSlides(song).flatMap((part) => part.slides.flat());
}

/**
 * Fill whatever English `song` is still missing from the posts found for it,
 * never overwriting English already there. The post that fills the most
 * slides wins; the English title is taken too when the song has none.
 */
export function englishFromWeb(song: Song, english: PraiseEnglish, candidates: WebEnglishCandidate[]): WebEnglishFill {
  const songLines = songKoreanLines(song);
  let best: WebEnglishFill = { english, filled: 0, titleFilled: false };
  let fallbackText: string | undefined;
  for (const candidate of candidates) {
    const pairs = pairWebBlocks(candidate.blocks, songLines);
    const entry = { title: song.title, englishTitle: candidate.englishTitle, slides: pairs };
    let result = pairs.length > 0 ? fillEnglishFromLibrary(song, english, [entry]) : null;
    if (!result || result.filled === 0) {
      const stanzas = englishStanzas(candidate.blocks);
      const aligned = alignEnglishByLabels(song, candidate.blocks) ?? alignEnglishOnly(song, stanzas);
      if (aligned) {
        const next: PraiseEnglish = { title: english.title, slides: { ...english.slides } };
        let filled = 0;
        for (const slide of planPraiseSong(song, { english }).slides) {
          if (slide.english.length > 0 || !aligned[slide.key]?.length) continue;
          next.slides[slide.key] = aligned[slide.key];
          filled += 1;
        }
        let titleFilled = false;
        if (!next.title.trim() && candidate.englishTitle) {
          next.title = candidate.englishTitle;
          titleFilled = true;
        }
        result = { english: next, filled, titleFilled };
      } else if (stanzas.length > 0 && fallbackText === undefined) {
        fallbackText = stanzas.map((lines) => lines.join('\n')).join('\n\n');
      }
    }
    if (result && result.filled > best.filled) {
      best = { ...result, source: { url: candidate.url, host: candidate.host } };
    }
  }
  if (best.filled === 0 && fallbackText) {
    const source = candidates.find((candidate) => englishStanzas(candidate.blocks).length > 0);
    return { ...best, pasteText: fallbackText, ...(source ? { source: { url: source.url, host: source.host } } : {}) };
  }
  return best;
}

/** The English a post gives for the song, as plain text — the AI's source when it is asked. */
export function webEnglishReference(candidates: WebEnglishCandidate[]): string[] {
  const best = candidates.find((candidate) => candidate.blocks.some((block) => block.lang === 'en'));
  if (!best) return [];
  return best.blocks.filter((block) => block.lang === 'en').flatMap((block) => block.lines).slice(0, 200);
}
