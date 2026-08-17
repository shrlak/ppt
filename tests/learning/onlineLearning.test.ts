import { describe, expect, it } from 'vitest';
import {
  applySafeCorrections,
  buildLearningMemory,
  extractCorrection,
  promptExamplesFor,
  resolveTitleAlias,
  safeCorrections,
  type LearningMemory,
} from '../../src/lib/learning/onlineLearning';
import type { FeedbackExample } from '../../src/lib/learning/feedbackDiff';
import type { ParsedScore } from '../../src/lib/ai/scoreParser';

/** One verified correction of a single line in part V. */
function record(options: {
  baselineTitle?: string;
  finalTitle?: string;
  before?: string;
  after?: string;
  pageHash?: string;
}): FeedbackExample {
  const before = options.before ?? '';
  const after = options.after ?? '';
  const baseline: ParsedScore = {
    title: options.baselineTitle,
    order: ['I', 'V'],
    sections: before ? [{ label: 'V', lines: [before] }] : [],
  };
  const final: ParsedScore = {
    title: options.finalTitle ?? options.baselineTitle,
    order: ['I', 'V'],
    sections: after ? [{ label: 'V', lines: [after] }] : [],
  };
  return {
    id: `${options.pageHash ?? 'page'}-${before}-${after}`,
    pageHash: options.pageHash ?? 'page-a',
    finalHash: `${after}-hash`,
    createdAt: '2026-08-14T00:00:00.000Z',
    observations: [],
    baseline,
    final,
    webCandidates: [],
    diff: {
      titleChanged: (options.baselineTitle ?? '') !== (options.finalTitle ?? options.baselineTitle ?? ''),
      artistChanged: false,
      keyChanged: false,
      orderChanged: false,
      sectionChanges: before && after !== before ? [{ label: 'V', labelChanged: false, changedLineIndexes: [0] }] : [],
    },
    verification: 'edited',
    evaluations: [],
  };
}

const aliasMemory: LearningMemory = {
  titleAliases: [{ from: '은해의노래', to: '은혜의 노래', support: 2 }],
  corrections: [],
  examples: [],
};

describe('resolveTitleAlias', () => {
  it('uses a verified title alias for lookup without replacing unrelated titles', () => {
    expect(resolveTitleAlias('은해의 노래', aliasMemory)).toBe('은혜의 노래');
    expect(resolveTitleAlias('은해로운 하루', aliasMemory)).toBe('은해로운 하루');
  });

  it('ignores an alias only one correction supports', () => {
    const weak: LearningMemory = { ...aliasMemory, titleAliases: [{ from: '은해의노래', to: '은혜의 노래', support: 1 }] };
    expect(resolveTitleAlias('은해의 노래', weak)).toBe('은해의 노래');
  });

  it('leaves a blank title alone', () => {
    expect(resolveTitleAlias('   ', aliasMemory)).toBe('   ');
  });
});

describe('buildLearningMemory', () => {
  it('activates a title alias only after the same correction happens twice', () => {
    const once = buildLearningMemory([record({ baselineTitle: '은해의 노래', finalTitle: '은혜의 노래' })]);
    expect(resolveTitleAlias('은해의 노래', once)).toBe('은해의 노래');

    const twice = buildLearningMemory([
      record({ baselineTitle: '은해의 노래', finalTitle: '은혜의 노래', pageHash: 'page-a' }),
      record({ baselineTitle: '은해의 노래', finalTitle: '은혜의 노래', pageHash: 'page-b' }),
    ]);
    expect(resolveTitleAlias('은해의 노래', twice)).toBe('은혜의 노래');
  });

  it('does not learn an alias from a title nobody changed', () => {
    const memory = buildLearningMemory([
      record({ baselineTitle: '은혜의 노래', finalTitle: '은혜의 노래' }),
      record({ baselineTitle: '은혜의 노래', finalTitle: '은혜의 노래' }),
    ]);
    expect(memory.titleAliases).toEqual([]);
  });

  it('learns nothing from a draft', () => {
    const draft = { ...record({ baselineTitle: '은해의 노래', finalTitle: '은혜의 노래' }), verification: 'draft' };
    const memory = buildLearningMemory([draft as unknown as FeedbackExample, draft as unknown as FeedbackExample]);
    expect(memory.titleAliases).toEqual([]);
    expect(memory.corrections).toEqual([]);
  });
});

describe('extractCorrection', () => {
  it('narrows a change to the words that differ, with a word of context', () => {
    expect(extractCorrection('믿음과 삶을 살아내는 실력이', '믿음과 삶을 살아내는 능력이')).toMatchObject({
      before: '실력이',
      after: '능력이',
      contextBefore: '살아내는',
      contextAfter: '',
    });
  });

  it('has nothing to learn from two identical lines', () => {
    expect(extractCorrection('같은 줄', '같은 줄')).toBeNull();
    expect(extractCorrection('', '무언가')).toBeNull();
  });
});

describe('safeCorrections', () => {
  const correction = {
    before: '실력이',
    after: '능력이',
    contextBefore: '살아내는',
    contextAfter: '',
  };

  it('waits for three examples before applying a correction automatically', () => {
    expect(safeCorrections({ ...aliasMemory, corrections: [{ ...correction, support: 2, seen: 2 }] })).toEqual([]);
    expect(safeCorrections({ ...aliasMemory, corrections: [{ ...correction, support: 3, seen: 3 }] })).toHaveLength(1);
  });

  it('refuses a correction that is usually not the outcome', () => {
    // Seen ten times and corrected three: far more often the original was right.
    expect(safeCorrections({ ...aliasMemory, corrections: [{ ...correction, support: 3, seen: 10 }] })).toEqual([]);
  });
});

describe('applySafeCorrections', () => {
  const memory: LearningMemory = {
    titleAliases: [],
    corrections: [
      { before: '실력이', after: '능력이', contextBefore: '살아내는', contextAfter: '', support: 4, seen: 4 },
    ],
    examples: [],
  };
  const score: ParsedScore = {
    order: ['I', 'V'],
    sections: [{ label: 'V', lines: ['믿음과 삶을 살아내는 실력이', '자신없는 내 모습'] }],
  };

  it('fixes a repeat misreading where its context matches', () => {
    expect(applySafeCorrections(score, memory).sections[0].lines[0]).toBe('믿음과 삶을 살아내는 능력이');
  });

  it('leaves the same words alone in a different context', () => {
    const elsewhere: ParsedScore = {
      order: ['I', 'V'],
      sections: [{ label: 'V', lines: ['나의 실력이 아니라'] }],
    };
    expect(applySafeCorrections(elsewhere, memory).sections[0].lines[0]).toBe('나의 실력이 아니라');
  });

  it('never touches a line the web already settled', () => {
    const line = '믿음과 삶을 살아내는 실력이';
    expect(applySafeCorrections(score, memory, new Set([line])).sections[0].lines[0]).toBe(line);
  });

  it('refuses a rule that would turn a line into something else', () => {
    // Learned from a mis-aligned diff: applying it would rewrite lyrics
    // nobody checked, so the similarity floor rejects it.
    const wild: LearningMemory = {
      ...memory,
      corrections: [
        {
          before: '믿음과 삶을 살아내는 실력이',
          after: '전혀 다른 문장으로 바꿔치기',
          contextBefore: '',
          contextAfter: '',
          support: 5,
          seen: 5,
        },
      ],
    };
    expect(applySafeCorrections(score, wild).sections[0].lines[0]).toBe('믿음과 삶을 살아내는 실력이');
  });

  it('is a no-op when nothing has cleared the bar yet', () => {
    expect(applySafeCorrections(score, { titleAliases: [], corrections: [], examples: [] })).toBe(score);
  });
});

describe('promptExamplesFor', () => {
  const memory: LearningMemory = {
    titleAliases: [],
    corrections: [],
    examples: [
      { before: '다른 곡의 잘못된 줄', after: '다른 곡의 올바른 줄', title: '다른 곡', label: 'V' },
      { before: '이 곡의 잘못된 줄', after: '이 곡의 올바른 줄', title: '은혜의 노래', label: 'C' },
      { before: '같은 파트의 잘못된 줄', after: '같은 파트의 올바른 줄', title: '또 다른 곡', label: 'C' },
      { before: '넷째 잘못된 줄', after: '넷째 올바른 줄', title: '넷째 곡', label: 'B' },
    ],
  };

  it('returns at most three examples and never includes a full stored song', () => {
    const examples = promptExamplesFor({ title: '은혜의 노래', partLabels: ['V', 'C'] }, memory, 3);
    expect(examples).toHaveLength(3);
    expect(examples.every((example) => example.after.length <= 120)).toBe(true);
  });

  it('prefers this song, then this part, then anything', () => {
    const examples = promptExamplesFor({ title: '은혜의 노래', partLabels: ['C'] }, memory, 3);
    expect(examples[0].title).toBe('은혜의 노래');
    expect(examples[1].label).toBe('C');
  });

  it('drops a duplicate pair rather than spending a slot on it', () => {
    const duplicated: LearningMemory = {
      ...memory,
      examples: [memory.examples[0], memory.examples[0], memory.examples[1]],
    };
    expect(promptExamplesFor({}, duplicated, 3)).toHaveLength(2);
  });

  it('has nothing to show from an empty memory', () => {
    expect(promptExamplesFor({ title: '은혜의 노래' }, { titleAliases: [], corrections: [], examples: [] })).toEqual(
      [],
    );
  });
});
