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

/** Weight of the page title in the total score. */
const TITLE_WEIGHT = 0.45;
/** Weight of the source's own trustworthiness. */
const TRUST_WEIGHT = 0.05;
/** Artist and lyric weights when the score printed an artist to compare. */
const WITH_ARTIST = { artist: 0.2, lyrics: 0.3 };
/** With no artist known, its weight goes to the evidence we do have. */
const WITHOUT_ARTIST = { artist: 0, lyrics: 0.5 };

/** At or above this — and clearly ahead — a candidate may fill in by itself. */
export const AUTO_SCORE = 0.85;
/** Lead over the runner-up an auto candidate must have. */
export const AUTO_MARGIN = 0.1;
/** At or above this a candidate is worth offering to the user. */
export const REVIEW_SCORE = 0.65;
/**
 * Least lyric overlap that counts as evidence this is the same song.
 *
 * Without this a page could win on title and artist alone, which is exactly
 * the case where two different songs are confused.
 */
export const MIN_LYRIC_EVIDENCE = 0.2;

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
 * Score one candidate against what recognition read off the 악보.
 *
 * Never returns 'auto': being good is not enough, a candidate also has to be
 * clearly better than the alternatives, and only rankLyricsCandidates can see
 * those. A title-only match therefore cannot auto-fill by construction.
 */
export function scoreLyricsCandidate(query, candidate) {
  const sample = normalizeSample(query.sample);
  const knowsArtist = !!normalizeForMatch(query.artist) && !!normalizeForMatch(candidate.artist);
  const weights = knowsArtist ? WITH_ARTIST : WITHOUT_ARTIST;

  const titleScore = nameSimilarity(query.title, candidate.title);
  const artistScore = knowsArtist ? nameSimilarity(query.artist, candidate.artist) : 0;
  const lyricsScore = sample ? containment(sample, normalizeForMatch(candidate.lines.join(''))) : 0;
  const sourceTrust = Number.isFinite(candidate.sourceTrust) ? candidate.sourceTrust : 0.5;

  const score =
    TITLE_WEIGHT * titleScore +
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
 * when it is both strong and clearly ahead.
 *
 * The margin is what makes this safe with several near-identical pages: when
 * two candidates are within AUTO_MARGIN of each other, at least one of them is
 * probably the wrong song, and the user gets to choose instead.
 */
export function rankLyricsCandidates(query, candidates, limit = 3) {
  const scored = candidates
    .map((candidate) => scoreLyricsCandidate(query, candidate))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
  const leader = scored[0];
  if (!leader || leader.decision === 'reject') return scored;
  const runnerUp = scored[1]?.score ?? 0;
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
