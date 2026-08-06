// 한국어 맞춤법 normalization for lyrics on their way into the editor.
//
// Recognized and scraped lyrics arrive with the artifacts of where they came
// from: a score splits words across notes, a web page carries zero-width
// characters and decomposed jamo, and both produce stray spaces around
// particles. This module cleans all of that up deterministically, so the same
// input always yields the same text and the whole thing is unit-testable
// without a model.
//
// The rules here are deliberately conservative. Every one of them either
// repairs a transport artifact (spacing, jamo composition, hyphens) or fixes
// a spelling whose written form is unambiguously wrong under 한글 맞춤법 —
// nothing rewrites a word choice. Lyrics say what the songwriter wrote, and a
// normalizer that "improves" wording would quietly change the song.
//
// IMPORTANT: this only ever runs on newly recognized or newly scraped lyrics
// (see applyKoreanSpelling call sites). Library entries and anything the user
// typed are left exactly as they are.

/** Zero-width and other invisible characters that survive a copy from the web. */
const INVISIBLE = /[​-‍﻿­⁠]/g;

/**
 * Particles that are never a word on their own. A score splits syllables
 * across notes ("주님 을 찬양"), so a token that is exactly one of these is an
 * artifact of that split and belongs on the preceding word.
 */
const STANDALONE_PARTICLES = [
  '은', '는', '이', '가', '을', '를', '와', '과', '도', '만',
  '의', '에', '에서', '에게', '에겐', '께', '께서', '으로', '로',
  '부터', '까지', '처럼', '보다', '이나', '나', '든지', '라도',
];

/**
 * Spellings that are simply wrong however the line is read, with the correct
 * form. Kept small on purpose: an entry earns its place only when the left
 * side is never a valid word in any context, so replacing it can't change
 * meaning. Ordinary word choices ("바래" for "바라") stay untouched — those
 * are the songwriter's, not a mistake to correct.
 */
const MISSPELLINGS: [RegExp, string][] = [
  // -ㄹ게: 「할께」 is a spelling of the sound, 「할게」 is the spelling.
  [/([가-힣])ㄹ께(?=[\s.,!?]|$)/g, '$1ㄹ게'],
  [/([가-힣])께요(?=[\s.,!?]|$)/g, '$1게요'],
  [/할께/g, '할게'],
  [/갈께/g, '갈게'],
  [/줄께/g, '줄게'],
  [/드릴께/g, '드릴게'],
  [/살께/g, '살게'],
  [/할꺼/g, '할 거'],
  // 되/돼 and the past tense that only has one spelling.
  [/됬/g, '됐'],
  [/뵈요(?=[\s.,!?]|$)/g, '봬요'],
  // Fixed vocabulary with a single correct form.
  [/웬지/g, '왠지'],
  [/오랫만/g, '오랜만'],
  [/어떻해/g, '어떡해'],
  [/몇일/g, '며칠'],
  [/이예요/g, '이에요'],
  [/구지(?=\s)/g, '굳이'],
  [/역활/g, '역할'],
  [/설레임/g, '설렘'],
  [/바램(?=[\s.,!?]|$)/g, '바람'],
];

/**
 * Join the hyphens a score uses to split a word across notes
 * ("Ce-le-brate" → "Celebrate", "찬-양-해" → "찬양해").
 *
 * The lookahead leaves the right-hand character unconsumed so a chain of
 * single-syllable splits collapses in one pass. This mirrors cleanLyricLine
 * in scoreParser.ts, which runs on every model answer; keeping a copy here
 * means scraped text gets the same treatment without importing the parser.
 */
function joinNoteHyphens(line: string): string {
  return line.replace(/(\S)[ \t]*[-–—][ \t]*(?=\S)/g, '$1');
}

/**
 * Reattach a particle that got stranded as its own token. Only an exact
 * particle match moves, and only onto a preceding Hangul word — so "나 를"
 * closes up while "나 를지어다" (not a particle) and English text are left
 * alone.
 */
function attachStrandedParticles(line: string): string {
  const tokens = line.split(' ');
  const out: string[] = [];
  for (const token of tokens) {
    const previous = out[out.length - 1];
    if (
      previous &&
      /[가-힣]$/.test(previous) &&
      STANDALONE_PARTICLES.includes(token)
    ) {
      out[out.length - 1] = previous + token;
      continue;
    }
    out.push(token);
  }
  return out.join(' ');
}

/**
 * Normalize one lyric line to 한국어 맞춤법.
 *
 * Order matters: compose jamo first so the Hangul-aware rules below see whole
 * syllables, then strip invisibles, then join note hyphens (which can create
 * the very particle splits the next step repairs), then fix spacing and
 * spelling.
 */
export function normalizeKoreanLyricLine(line: string): string {
  let text = line.normalize('NFC').replace(INVISIBLE, '');

  text = text
    // Full-width and non-breaking spaces behave like spaces everywhere else.
    .replace(/[ 　]/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .trim();

  text = joinNoteHyphens(text);

  text = text
    // A space before closing punctuation is always a transport artifact.
    .replace(/\s+([,.!?;:])/g, '$1')
    .replace(/\s+([)\]}）」』])/g, '$1')
    .replace(/([([{（「『])\s+/g, '$1')
    // Normalize the ellipsis and repeated punctuation the web adds.
    .replace(/\.{3,}/g, '…')
    .replace(/([!?])\1{2,}/g, '$1');

  text = attachStrandedParticles(text);

  for (const [pattern, replacement] of MISSPELLINGS) {
    text = text.replace(pattern, replacement);
  }

  return text.replace(/[ \t]{2,}/g, ' ').trim();
}

/** Normalize every line of a section, dropping lines that normalize to nothing. */
export function normalizeKoreanLyricLines(lines: string[]): string[] {
  return lines.map(normalizeKoreanLyricLine).filter((line) => line.length > 0);
}
