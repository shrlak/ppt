// Deciding whether a page found on the web is actually THIS song.
//
// The old lookup returned one page and the editor used it. That is safe only
// while every title is unique, which Korean worship titles emphatically are
// not: several different songs are called 은혜의 노래, and a title-only match
// would quietly replace a conti's lyrics with a different song's.
//
// So a candidate is scored on three independent kinds of evidence — the page's
// title, its artist, and how much of the RECOGNIZED lyrics it actually
// contains — and only a candidate that is both strong and clearly ahead of the
// runner-up may fill anything in by itself.

// The title is what the conti gives us for certain, so it carries most of the
// weight: the lookup is title-first. Lyric evidence is what keeps a same-title,
// different-song page out, and it is measured on character PAIRS rather than
// single characters — Korean lyrics share most of their syllables, so single
// characters overlap ~0.4 even between unrelated songs, while pairs only
// overlap when the text really is the same (see lyricEvidence).

/** Weight of the page title in the total score. */
const TITLE_WEIGHT = 0.55;
/** Weight of the source's own trustworthiness. */
const TRUST_WEIGHT = 0.05;
/** Artist and lyric weights when the score printed an artist to compare. */
const WITH_ARTIST = { title: 0.5, artist: 0.1, lyrics: 0.35 };
/** With no artist known, its weight goes to the evidence we do have. */
const WITHOUT_ARTIST = { title: TITLE_WEIGHT, artist: 0, lyrics: 0.4 };
/**
 * Nothing was read off the 악보 at all — the title is the only evidence, and
 * looking a song up by its title is exactly what was asked for.
 */
const TITLE_ONLY = { title: 0.95, artist: 0, lyrics: 0 };

/** At or above this — and clearly ahead — a candidate may fill in by itself. */
export const AUTO_SCORE = 0.8;
/** Lead over the best candidate of a DIFFERENT song an auto candidate must have. */
export const AUTO_MARGIN = 0.1;
/** At or above this a candidate is worth offering to the user. */
export const REVIEW_SCORE = 0.6;
/**
 * Least lyric evidence that counts as the same song.
 *
 * Without this a page could win on title and artist alone, which is exactly
 * the case where two different songs are confused. Measured on the repo's own
 * lyric library: a recognized sample with 40% of its syllables misread still
 * scores ≥ 0.55 against its own song, while 99% of other songs score ≤ 0.35.
 */
export const MIN_LYRIC_EVIDENCE = 0.35;

/** Pair overlap that counts as full lyric evidence (see lyricEvidence). */
const FULL_PAIR_OVERLAP = 0.4;

/**
 * Two pages hold the same song when this much of their character pairs agree.
 * Different sites print the same song with different spacing and headings,
 * but not with different words.
 */
export const SAME_SONG_OVERLAP = 0.5;

/** Most sample characters the client sends, and the proxy compares against. */
export const MAX_SAMPLE_CHARS = 300;

/** Comparison form: letters, digits and Hangul only. */
export function normalizeForMatch(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^0-9a-zㄱ-ㆎ가-힣]+/g, '');
}

/** Trim a recognized-lyric sample to what may cross the wire. */
export function normalizeSample(value) {
  return normalizeForMatch(value).slice(0, MAX_SAMPLE_CHARS);
}

function characterCounts(text) {
  const counts = new Map();
  for (const character of text) counts.set(character, (counts.get(character) ?? 0) + 1);
  return counts;
}

/**
 * How much of `needle` appears in `haystack`, 0–1.
 *
 * Normalized by the needle rather than by the longer side: a page holding a
 * whole song plus a write-up should still score 1 for containing the verse we
 * recognized.
 */
export function containment(needle, haystack) {
  if (!needle) return 0;
  const wanted = characterCounts(needle);
  const available = characterCounts(haystack);
  let shared = 0;
  for (const [character, count] of wanted) shared += Math.min(count, available.get(character) ?? 0);
  return shared / needle.length;
}

function pairCounts(text) {
  const counts = new Map();
  for (let index = 0; index < text.length - 1; index += 1) {
    const pair = text.slice(index, index + 2);
    counts.set(pair, (counts.get(pair) ?? 0) + 1);
  }
  return counts;
}

/** How much of `needle`'s character pairs appear in `haystack`, 0–1. */
export function pairContainment(needle, haystack) {
  const wanted = pairCounts(needle);
  const available = pairCounts(haystack);
  let shared = 0;
  let total = 0;
  for (const [pair, count] of wanted) {
    shared += Math.min(count, available.get(pair) ?? 0);
    total += count;
  }
  return total === 0 ? 0 : shared / total;
}

/**
 * How strongly the recognized sample says this page is the same song, 0–1.
 *
 * OCR misreads a syllable here and there, which breaks the two pairs around
 * it, so even a correct page rarely contains more than ~60% of a noisy
 * sample's pairs. FULL_PAIR_OVERLAP is therefore scored as certain.
 */
export function lyricEvidence(sample, pageText) {
  if (!sample) return 0;
  return Math.min(1, pairContainment(sample, pageText) / FULL_PAIR_OVERLAP);
}

/** True when two candidates print the same song (different sites, same words). */
export function sameSongLyrics(a, b) {
  const left = normalizeForMatch((a.lines ?? []).join(''));
  const right = normalizeForMatch((b.lines ?? []).join(''));
  if (!left || !right) return false;
  const [shorter, longer] = left.length <= right.length ? [left, right] : [right, left];
  return pairContainment(shorter, longer) >= SAME_SONG_OVERLAP;
}

/** 0–1 similarity of two names, by shared characters over the longer one. */
export function nameSimilarity(a, b) {
  const left = normalizeForMatch(a);
  const right = normalizeForMatch(b);
  if (!left || !right) return 0;
  if (left === right) return 1;
  const counts = characterCounts(right);
  let shared = 0;
  for (const [character, count] of characterCounts(left)) {
    shared += Math.min(count, counts.get(character) ?? 0);
  }
  return shared / Math.max(left.length, right.length);
}

/**
 * Score one candidate against what the conti says: its title first, then the
 * artist and the lyrics the models read, when there are any.
 *
 * Never returns 'auto': being good is not enough, a candidate also has to be
 * clearly better than any different song, and only rankLyricsCandidates can
 * see those.
 */
export function scoreLyricsCandidate(query, candidate) {
  const sample = normalizeSample(query.sample);
  const knowsArtist = !!normalizeForMatch(query.artist) && !!normalizeForMatch(candidate.artist);
  const weights = !sample ? TITLE_ONLY : knowsArtist ? WITH_ARTIST : WITHOUT_ARTIST;

  const titleScore = nameSimilarity(query.title, candidate.title);
  const artistScore = knowsArtist ? nameSimilarity(query.artist, candidate.artist) : 0;
  const lyricsScore = lyricEvidence(sample, normalizeForMatch(candidate.lines.join('')));
  const sourceTrust = Number.isFinite(candidate.sourceTrust) ? candidate.sourceTrust : 0.5;

  const score =
    weights.title * titleScore +
    weights.artist * artistScore +
    weights.lyrics * lyricsScore +
    TRUST_WEIGHT * sourceTrust;

  // With a sample in hand, lyric evidence is required: the whole point of the
  // sample is to catch a same-title different-song page.
  const lacksEvidence = !!sample && lyricsScore < MIN_LYRIC_EVIDENCE;
  const decision = lacksEvidence ? 'reject' : score >= REVIEW_SCORE ? 'review' : 'reject';

  return {
    id: candidate.id,
    title: candidate.title,
    artist: candidate.artist,
    lines: candidate.lines,
    url: candidate.url,
    host: candidate.host,
    source: candidate.source,
    sourceTrust,
    score,
    titleScore,
    artistScore,
    lyricsScore,
    decision,
  };
}

/**
 * Score every candidate, best first, and promote the leader to 'auto' only
 * when it is both strong and clearly ahead of every DIFFERENT song.
 *
 * The margin is what makes this safe with several same-title songs: when two
 * different songs are within AUTO_MARGIN of each other, the user chooses. Two
 * sites printing the same words are not a rival — they corroborate each other
 * — so they are skipped when looking for the runner-up.
 */
export function rankLyricsCandidates(query, candidates, limit = 3) {
  const scored = candidates
    .map((candidate) => scoreLyricsCandidate(query, candidate))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
  const leader = scored[0];
  if (!leader || leader.decision === 'reject') return scored;
  const rival = scored
    .slice(1)
    .find((other) => other.decision !== 'reject' && !sameSongLyrics(leader, other));
  const runnerUp = rival?.score ?? 0;
  if (leader.score >= AUTO_SCORE && leader.score - runnerUp >= AUTO_MARGIN) {
    scored[0] = { ...leader, decision: 'auto' };
  }
  return scored;
}

/** The wire form: everything the editor needs, and no raw HTML. */
export function publicCandidate(scored) {
  return {
    id: scored.id,
    title: scored.title,
    artist: scored.artist,
    lines: scored.lines,
    url: scored.url,
    host: scored.host,
    source: scored.source,
    sourceTrust: scored.sourceTrust,
    score: scored.score,
    titleScore: scored.titleScore,
    artistScore: scored.artistScore,
    lyricsScore: scored.lyricsScore,
    decision: scored.decision,
  };
}

/** A Bugs hit the deployment has no permission to read: a link, nothing more. */
export function linkOnlyCandidate(url, host) {
  return { id: `bugs:${host}`, source: 'bugs', linkOnly: true, url, host };
}
