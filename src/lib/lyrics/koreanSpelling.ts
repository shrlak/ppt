// What happens to lyric text on its way into the editor.
//
// Two sources feed the editor, and they need opposite treatment:
//
//   · RECOGNIZED — what the models read off the 악보. A score prints lyrics
//     under noteheads, so the spacing on the page is musical, not
//     orthographic: words are hyphenated across notes and particles drift off
//     onto their own syllable. That text gets a full 띄어쓰기·맞춤법 pass
//     (normalizeRecognizedLyricLines).
//   · SCRAPED — what a published lyrics page says. That page is already
//     written in prose, by someone who had the real words in front of them,
//     so it goes in 그대로 — verbatim (cleanScrapedLyricLines). Only transport
//     noise is removed: invisible characters, decomposed jamo and the exotic
//     spaces an HTML copy carries. Not one visible character is rewritten.
//
// The split matters because "correcting" published lyrics is how a normalizer
// does damage: the page is the better authority on wording, and a rule that
// second-guesses it turns a right answer into a wrong one.
//
// Everything here is deterministic and unit-testable without a model, so the
// same input always yields the same text.
//
// The recognition rules are deliberately conservative. Each one either repairs
// a transport artifact (spacing, jamo composition, hyphens) or fixes a
// spelling whose written form is unambiguously wrong under 한글 맞춤법 —
// nothing rewrites a word choice. Lyrics say what the songwriter wrote, and a
// normalizer that "improves" wording would quietly change the song.
//
// IMPORTANT: neither pass ever runs on library entries or on anything the user
// typed. Both are left exactly as they are.

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
 * Endings that cannot begin a word, so a token that is exactly one of them was
 * split off the verb it ends. Kept to forms with no standalone reading at all:
 * 「세요」 is only ever an ending, while 「해요」 is a whole verb, so joining
 * that one would decide a 띄어쓰기 question the score never asked.
 */
const STANDALONE_ENDINGS = [
  '습니다', '습니까', '읍니다', 'ㅂ니다', '십니다', '십니까',
  '세요', '셔요', '소서', '옵소서',
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
  // 되/돼: 「되요」「되서」 are never right — 돼 is 되어 contracted, and only
  // the contracted form can stand in front of these endings.
  [/됬/g, '됐'],
  [/되요(?=[\s.,!?]|$)/g, '돼요'],
  [/되서(?=[\s.,!?]|$)/g, '돼서'],
  [/않되/g, '안 되'],
  [/뵈요(?=[\s.,!?]|$)/g, '봬요'],
  // -습니다: 「-읍니다」 is the pre-1988 spelling of the same ending.
  [/읍니다/g, '습니다'],
  [/십시요(?=[\s.,!?]|$)/g, '십시오'],
  // Fixed vocabulary with a single correct form.
  [/웬지/g, '왠지'],
  [/왠일/g, '웬일'],
  [/왠만/g, '웬만'],
  [/오랫만/g, '오랜만'],
  [/어떻해/g, '어떡해'],
  [/몇일/g, '며칠'],
  [/이예요/g, '이에요'],
  [/구지(?=\s)/g, '굳이'],
  [/역활/g, '역할'],
  [/설레임/g, '설렘'],
  [/바램(?=[\s.,!?]|$)/g, '바람'],
  // -이 adverbs whose 「-히」 spelling is wrong for every one of them.
  [/깨끗히/g, '깨끗이'],
  [/틈틈히/g, '틈틈이'],
  [/곰곰히/g, '곰곰이'],
  [/일일히/g, '일일이'],
  [/번번히/g, '번번이'],
];

/**
 * Repair the transport, and nothing else.
 *
 * Composes jamo, drops invisible characters and turns the exotic spaces of an
 * HTML copy into ordinary ones. Every one of these is invisible on screen, so
 * the text that comes out reads exactly as the text that went in — which is
 * what lets scraped lyrics through unchanged.
 */
function repairTransport(line: string): string {
  return line
    .normalize('NFC')
    .replace(INVISIBLE, '')
    .replace(/[  -   　]/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

/**
 * Join the hyphens a score uses to split a word across notes
 * ("Ce-le-brate" → "Celebrate", "찬-양-해" → "찬양해").
 *
 * The lookahead leaves the right-hand character unconsumed so a chain of
 * single-syllable splits collapses in one pass. This mirrors cleanLyricLine
 * in scoreParser.ts, which runs on every model answer; keeping a copy here
 * means every recognized reading gets the same treatment even when it reaches
 * the editor by another route.
 */
function joinNoteHyphens(line: string): string {
  return line.replace(/(\S)[ \t]*[-–—][ \t]*(?=\S)/g, '$1');
}

/** Index of a Hangul syllable's final consonant, or -1 for anything else. */
function finalJamoIndex(char: string): number {
  const code = char.codePointAt(0) ?? 0;
  if (code < 0xac00 || code > 0xd7a3) return -1;
  return (code - 0xac00) % 28;
}

/** Compatibility jamo (ㄱ, ㄴ, ㄹ…) to its position as a final consonant. */
const FINAL_JAMO_ORDER =
  'ㄱㄲㄳㄴㄵㄶㄷㄹㄺㄻㄼㄽㄾㄿㅀㅁㅂㅄㅅㅆㅇㅈㅊㅋㅌㅍㅎ';

/**
 * Fold a lone consonant back onto the syllable it was split from
 * ("하 ㄹ" → "할"). A bare compatibility jamo is never text on its own, and it
 * can only land on a syllable that has no final consonant yet.
 */
function composeStrandedJamo(previous: string, jamo: string): string | null {
  const last = previous[previous.length - 1];
  if (finalJamoIndex(last) !== 0) return null;
  const final = FINAL_JAMO_ORDER.indexOf(jamo) + 1;
  if (final === 0) return null;
  return previous.slice(0, -1) + String.fromCodePoint((last.codePointAt(0) as number) + final);
}

/**
 * Close up the spacing a score's noteheads opened.
 *
 * Only a token with no standalone reading at all moves, and only onto a
 * preceding Hangul word — so "나 를" closes up while "나 를지어다" (not a
 * particle) and English text are left alone. Words are never split apart
 * here: a score produces too many spaces, not too few, and deciding where a
 * space is *missing* needs to know the part of speech.
 */
function closeNoteSplits(line: string): string {
  const tokens = line.split(' ');
  const out: string[] = [];
  for (const token of tokens) {
    const previous = out[out.length - 1];
    if (previous && /[가-힣]$/.test(previous)) {
      if (STANDALONE_PARTICLES.includes(token) || STANDALONE_ENDINGS.includes(token)) {
        out[out.length - 1] = previous + token;
        continue;
      }
      if (/^[ㄱ-ㅎ]$/.test(token)) {
        const composed = composeStrandedJamo(previous, token);
        if (composed) {
          out[out.length - 1] = composed;
          continue;
        }
      }
    }
    out.push(token);
  }
  return out.join(' ');
}

/**
 * Normalize one recognized lyric line to 한국어 띄어쓰기·맞춤법.
 *
 * Order matters: repair the transport first so the Hangul-aware rules below
 * see whole syllables, then join note hyphens (which can create the very
 * splits the next step closes), then fix spacing and spelling.
 */
export function normalizeRecognizedLyricLine(line: string): string {
  let text = joinNoteHyphens(repairTransport(line));

  text = text
    // A space before closing punctuation is always a transport artifact.
    .replace(/\s+([,.!?;:])/g, '$1')
    .replace(/\s+([)\]}）」』])/g, '$1')
    .replace(/([([{（「『])\s+/g, '$1')
    // Normalize the ellipsis and repeated punctuation the web adds.
    .replace(/\.{3,}/g, '…')
    .replace(/([!?])\1{2,}/g, '$1');

  text = closeNoteSplits(text);

  for (const [pattern, replacement] of MISSPELLINGS) {
    text = text.replace(pattern, replacement);
  }

  return text.replace(/[ \t]{2,}/g, ' ').trim();
}

/** Normalize every recognized line, dropping lines that normalize to nothing. */
export function normalizeRecognizedLyricLines(lines: string[]): string[] {
  return lines.map(normalizeRecognizedLyricLine).filter((line) => line.length > 0);
}

/**
 * Take one scraped line as published.
 *
 * Transport repair only: the page's own 띄어쓰기, punctuation and word choice
 * are what the editor shows, because a published page is a better authority on
 * the words than any rule here.
 */
export function cleanScrapedLyricLine(line: string): string {
  return repairTransport(line);
}

/** Take every scraped line as published, dropping ones that were only noise. */
export function cleanScrapedLyricLines(lines: string[]): string[] {
  return lines.map(cleanScrapedLyricLine).filter((line) => line.length > 0);
}
