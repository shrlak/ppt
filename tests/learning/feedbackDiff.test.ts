import { describe, expect, it } from 'vitest';
import {
  canonicalScore,
  diffFeedback,
  feedbackCandidate,
  isUnchanged,
  verificationFor,
} from '../../src/lib/learning/feedbackDiff';
import type { ParsedScore } from '../../src/lib/ai/scoreParser';
import type { ScoredLyricsCandidate } from '../../src/lib/lyrics/webLyrics';

const draft: ParsedScore = {
  title: '가나다라 마바사',
  key: 'E',
  order: ['I', 'V', 'C'],
  sections: [
    { label: 'V', lines: ['가나다라 마바사 아자차', '카타파하 그 이름 높이'] },
    { label: 'C', lines: ['높이 높이 노래해'] },
  ],
};

/** The same reading with one syllable corrected — the usual kind of edit. */
const corrected: ParsedScore = {
  ...draft,
  sections: [
    { label: 'V', lines: ['가나다라 마바사 아자차', '카타파하 그 이름 높여'] },
    { label: 'C', lines: ['높이 높이 노래해'] },
  ],
};

describe('diffFeedback', () => {
  it('marks unchanged confirmed output verified and changed output edited', () => {
    expect(verificationFor(diffFeedback(draft, draft))).toBe('verified');
    expect(verificationFor(diffFeedback(draft, corrected))).toBe('edited');
  });

  it('points at the exact line that changed, and no others', () => {
    const diff = diffFeedback(draft, corrected);
    expect(diff.sectionChanges).toEqual([{ label: 'V', labelChanged: false, changedLineIndexes: [1] }]);
    expect(diff.titleChanged).toBe(false);
    expect(diff.orderChanged).toBe(false);
  });

  it('does not treat spacing or punctuation as a correction', () => {
    // Counting these would mark almost every save as edited and destroy the
    // signal the whole loop depends on.
    const respaced: ParsedScore = {
      ...draft,
      title: ' 가나다라  마바사! ',
      sections: draft.sections.map((section) => ({
        label: section.label,
        lines: section.lines.map((line) => line.replace(/\s+/g, '  ')),
      })),
    };
    expect(isUnchanged(diffFeedback(draft, respaced))).toBe(true);
  });

  it('notices a retitled, re-keyed or reordered save', () => {
    expect(diffFeedback(draft, { ...draft, title: '전혀 다른 제목' }).titleChanged).toBe(true);
    expect(diffFeedback(draft, { ...draft, key: 'G' }).keyChanged).toBe(true);
    expect(diffFeedback(draft, { ...draft, order: ['I', 'C', 'V'] }).orderChanged).toBe(true);
    expect(diffFeedback(draft, { ...draft, artist: '어느 사역팀' }).artistChanged).toBe(true);
  });

  it('reports a renamed part as a label change, not a rewrite', () => {
    const relabelled: ParsedScore = {
      ...draft,
      sections: [{ ...draft.sections[0], label: 'V1' }, draft.sections[1]],
    };
    expect(diffFeedback(draft, relabelled).sectionChanges).toEqual([
      { label: 'V1', labelChanged: true, changedLineIndexes: [] },
    ]);
  });

  it('reports an added or deleted part in full', () => {
    const added: ParsedScore = {
      ...draft,
      sections: [...draft.sections, { label: 'B', lines: ['새로 넣은 브릿지', '두 번째 줄'] }],
    };
    expect(diffFeedback(draft, added).sectionChanges).toEqual([
      { label: 'B', labelChanged: true, changedLineIndexes: [0, 1] },
    ]);
    const removed: ParsedScore = { ...draft, sections: [draft.sections[0]] };
    expect(diffFeedback(draft, removed).sectionChanges).toEqual([
      { label: 'C', labelChanged: true, changedLineIndexes: [0] },
    ]);
  });

  it('carries no lyric text, so a diff is safe to store and show', () => {
    const serialized = JSON.stringify(diffFeedback(draft, corrected));
    expect(serialized).not.toContain('가나다라');
    expect(serialized).not.toContain('높여');
  });
});

describe('canonicalScore', () => {
  it('hashes the same answer the same way however it was typed', () => {
    expect(canonicalScore(draft)).toBe(
      canonicalScore({
        ...draft,
        order: ['i', 'v', 'c'],
        sections: draft.sections.map((section) => ({
          label: section.label.toLowerCase(),
          lines: section.lines.map((line) => ` ${line} `),
        })),
      }),
    );
  });

  it('changes when the saved lyrics change', () => {
    expect(canonicalScore(draft)).not.toBe(canonicalScore(corrected));
  });
});

describe('feedbackCandidate', () => {
  it('keeps a web candidate’s provenance and leaves its lyric text behind', () => {
    const candidate: ScoredLyricsCandidate = {
      id: 'ccm:1',
      title: '가나다라 마바사',
      artist: '어느 사역팀',
      sections: [{ label: 'V', lines: ['남의 사이트 가사'] }],
      order: ['I', 'V'],
      sourceUrl: 'https://ccm.co.kr/song/1',
      sourceHost: 'ccm.co.kr',
      source: 'ccm',
      score: 0.9,
      titleScore: 1,
      artistScore: 1,
      lyricsScore: 0.8,
      decision: 'review',
    };
    const stored = feedbackCandidate(candidate);
    expect(stored).toMatchObject({ id: 'ccm:1', host: 'ccm.co.kr', decision: 'review' });
    // Which page was offered is worth keeping; copying its words is not ours.
    expect(JSON.stringify(stored)).not.toContain('남의 사이트 가사');
  });
});
