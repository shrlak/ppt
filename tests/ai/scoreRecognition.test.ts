import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyScoreToSong,
  recognizeScore,
  recognizeScoreBatch,
  recognizeScoreBatchEnsemble,
  recognizeScoreRaced,
} from '../../src/lib/ai/scoreRecognition';
import { DEFAULT_AI_SETTINGS, RECOGNITION_MODEL_CATALOG } from '../../src/lib/ai/aiSettings';
import { RecognitionError } from '../../src/lib/ai/recognitionError';
import type { Song } from '../../src/lib/utils/types';
import type { ParsedScore } from '../../src/lib/ai/scoreParser';

const GEMINI_MODEL_COUNT = RECOGNITION_MODEL_CATALOG.filter((entry) => entry.engine === 'gemini').length;
const NVIDIA_MODEL_COUNT = RECOGNITION_MODEL_CATALOG.filter((entry) => entry.engine === 'nvidia').length;
/** Lowest-priority model in the pool — the one every other model outranks. */
const LAST_MODEL = RECOGNITION_MODEL_CATALOG[RECOGNITION_MODEL_CATALOG.length - 1].model;

vi.mock('../../src/lib/ai/scoreAi', () => ({
  recognizeWithGemini: vi.fn(),
  recognizeBatchWithGemini: vi.fn(),
}));
vi.mock('../../src/lib/ai/scoreNvidia', () => ({
  recognizeWithNvidia: vi.fn(),
  recognizeBatchWithNvidia: vi.fn(),
}));

import { recognizeBatchWithGemini, recognizeWithGemini } from '../../src/lib/ai/scoreAi';
import { recognizeBatchWithNvidia, recognizeWithNvidia } from '../../src/lib/ai/scoreNvidia';

const stub: Song = {
  id: '1',
  title: '새 찬양 (p.3)',
  sections: [],
  order: ['I'],
  linesPerSlide: 4,
  pageIndex: 3,
};

const parsed: ParsedScore = {
  title: '주님의 사랑',
  key: 'E',
  order: ['I', 'V1', 'C', 'C'],
  sections: [
    { label: 'V1', lines: ['첫째 줄'] },
    { label: 'C', lines: ['후렴 줄'] },
  ],
};

const settings = {
  ...DEFAULT_AI_SETTINGS,
  geminiApiKey: 'test-key',
  openrouterApiKey: 'test-key',
};

describe('concurrent single-page recognition', () => {
  const result: ParsedScore = { title: 't', key: 'C', order: [], sections: [] };
  const emptyScore: ParsedScore = { order: [], sections: [] };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(recognizeWithGemini).mockRejectedValue(new Error('down'));
    vi.mocked(recognizeWithNvidia).mockRejectedValue(new Error('down'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('launches the complete model pool together and returns the first usable result', async () => {
    vi.mocked(recognizeWithNvidia).mockImplementation(async (_url, _key, model) => {
      if (model === 'nvidia/nemotron-nano-12b-v2-vl') return result;
      throw new Error('down');
    });

    const out = await recognizeScore('data:image/png;base64,x', settings);

    expect(out.engine).toBe('nvidia');
    expect(recognizeWithGemini).toHaveBeenCalledTimes(GEMINI_MODEL_COUNT);
    expect(recognizeWithNvidia).toHaveBeenCalledTimes(NVIDIA_MODEL_COUNT);
  });

  it('lets a later-listed provider win by finishing first', async () => {
    vi.mocked(recognizeWithNvidia).mockImplementation(async (_url, _key, model) => {
      if (model === LAST_MODEL) return result;
      throw new Error('down');
    });
    const out = await recognizeScore('data:image/png;base64,x', settings);
    expect(out.engine).toBe('nvidia');
    expect(recognizeWithGemini).toHaveBeenCalledTimes(GEMINI_MODEL_COUNT);
    expect(recognizeWithNvidia).toHaveBeenCalledTimes(NVIDIA_MODEL_COUNT);
  });

  it('ignores empty answers while the other concurrent models continue', async () => {
    vi.mocked(recognizeWithGemini).mockResolvedValue(emptyScore);
    vi.mocked(recognizeWithNvidia).mockImplementation(async (_url, _key, model) => {
      if (model === LAST_MODEL) return result;
      throw new Error('down');
    });
    const out = await recognizeScore('data:image/png;base64,x', settings);
    expect(out.engine).toBe('nvidia');
  });

  it('treats an explicit non-score classification as usable without inventing a song', async () => {
    const nonScore: ParsedScore = { pageType: 'non_score', order: [], sections: [] };
    vi.mocked(recognizeWithNvidia).mockResolvedValue(nonScore);
    const out = await recognizeScore('data:image/png;base64,x', settings);
    expect(out).toMatchObject({ engine: 'nvidia', score: { pageType: 'non_score' } });
  });

  it('throws once every concurrently started model fails', async () => {
    await expect(recognizeScore('data:image/png;base64,x', settings)).rejects.toThrow('down');
    expect(recognizeWithGemini).toHaveBeenCalledTimes(GEMINI_MODEL_COUNT);
    expect(recognizeWithNvidia).toHaveBeenCalledTimes(NVIDIA_MODEL_COUNT);
  });

  it('retries an individual model once after a transient server failure', async () => {
    vi.useFakeTimers();
    const oneModel = {
      ...settings,
      attempts: [{ engine: 'gemini' as const, model: 'gemini-3.6-flash' }],
    };
    vi.mocked(recognizeWithGemini)
      .mockRejectedValueOnce(new RecognitionError('Gemini 호출 실패: HTTP 503', 503))
      .mockResolvedValueOnce(result);

    const pending = recognizeScore('data:image/png;base64,x', oneModel);
    await vi.advanceTimersByTimeAsync(2000);

    await expect(pending).resolves.toMatchObject({ engine: 'gemini' });
    expect(recognizeWithGemini).toHaveBeenCalledTimes(2);
  });

  it('keeps the rescue API on the same all-model race', async () => {
    vi.mocked(recognizeWithNvidia).mockImplementation(async (_url, _key, model) => {
      if (model === LAST_MODEL) return result;
      throw new Error('down');
    });
    const out = await recognizeScoreRaced('data:image/png;base64,x', settings);
    expect(out.engine).toBe('nvidia');
    expect(recognizeWithGemini).toHaveBeenCalledTimes(GEMINI_MODEL_COUNT);
    expect(recognizeWithNvidia).toHaveBeenCalledTimes(NVIDIA_MODEL_COUNT);
  });
});

describe('concurrent batch recognition', () => {
  const first: ParsedScore = { title: '첫째 곡', order: [], sections: [] };
  const second: ParsedScore = { title: '둘째 곡', order: [], sections: [] };
  const empty: ParsedScore = { order: [], sections: [] };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(recognizeBatchWithGemini).mockRejectedValue(new Error('down'));
    vi.mocked(recognizeBatchWithNvidia).mockRejectedValue(new Error('down'));
  });

  it('launches every model together for the title pass', async () => {
    vi.mocked(recognizeBatchWithGemini).mockImplementation(async (_urls, _key, model) => {
      if (model === 'gemini-3.6-flash') return [first, second];
      throw new Error('down');
    });

    const out = await recognizeScoreBatch(['image-1', 'image-2'], settings, 'titles');

    expect(out.scores).toEqual([first, second]);
    expect(recognizeBatchWithGemini).toHaveBeenCalledTimes(GEMINI_MODEL_COUNT);
    expect(recognizeBatchWithNvidia).toHaveBeenCalledTimes(NVIDIA_MODEL_COUNT);
  });

  it('keeps a non-score page in the aligned title results for caller-side filtering', async () => {
    const nonScore: ParsedScore = {
      pageType: 'non_score',
      sermonTitle: '믿음으로 걷기',
      scripture: '히브리서 11장 1-3절',
      order: [],
      sections: [],
    };
    vi.mocked(recognizeBatchWithNvidia).mockResolvedValue([nonScore, second]);

    const out = await recognizeScoreBatch(['image-1', 'image-2'], settings, 'titles');

    expect(out.scores[0]).toMatchObject(nonScore);
    expect(out.scores[1].title).toBe('둘째 곡');
  });

  it('lets the models work together: the strongest reader wins a page even when a weaker model finished first', async () => {
    let resolveGemini!: (scores: ParsedScore[]) => void;
    let resolveOpenRouter!: (scores: ParsedScore[]) => void;
    const gemini = new Promise<ParsedScore[]>((resolve) => { resolveGemini = resolve; });
    const openRouter = new Promise<ParsedScore[]>((resolve) => { resolveOpenRouter = resolve; });
    vi.mocked(recognizeBatchWithGemini).mockImplementation((_urls, _key, model) =>
      model === 'gemini-3.6-flash' ? gemini : Promise.reject(new Error('down')),
    );
    vi.mocked(recognizeBatchWithNvidia).mockImplementation((_urls, _key, _mode, model) =>
      model === 'nvidia/nemotron-nano-12b-v2-vl' ? openRouter : Promise.reject(new Error('down')),
    );

    const pending = recognizeScoreBatch(['image-1', 'image-2'], settings, 'full');
    // The weaker model answers FIRST — but Gemini (higher in the pool) is
    // still reading, so its later answer must win the page.
    resolveOpenRouter([{ ...first, title: '빠른 첫째 곡' }, empty]);
    await Promise.resolve();
    resolveGemini([first, second]);
    const out = await pending;

    expect(out.scores[0].title).toBe('첫째 곡');
    expect(out.scores[1].title).toBe('둘째 곡');
    expect(out.engine).toBe('gemini');
  });

  it('does not wait for weaker models once every stronger model has settled', async () => {
    vi.mocked(recognizeBatchWithGemini).mockRejectedValue(new Error('down'));
    vi.mocked(recognizeBatchWithNvidia).mockImplementation(async (_urls, _key, _mode, model) => {
      if (model === 'nvidia/nemotron-nano-12b-v2-vl') return [first, second];
      throw new Error('down');
    });
    // The last model never settles — a lower-priority straggler must not block.
    vi.mocked(recognizeBatchWithNvidia).mockImplementation(async (_urls, _key, _mode, model) => {
      if (model === 'nvidia/nemotron-nano-12b-v2-vl') return [first, second];
      if (model === LAST_MODEL) return new Promise(() => {});
      throw new Error('down');
    });

    const out = await recognizeScoreBatch(['image-1', 'image-2'], settings, 'full');

    expect(out.engine).toBe('nvidia');
    expect(out.scores.map((score) => score.title)).toEqual(['첫째 곡', '둘째 곡']);
  });

  it('fills the fields the winning model missed from the other models (working together)', async () => {
    const geminiAnswer: ParsedScore = { title: '주님의 사랑', order: [], sections: [] };
    const openRouterAnswer: ParsedScore = {
      title: '다른 제목',
      key: 'G',
      order: ['I', 'V1', 'C'],
      sections: [{ label: 'V1', lines: ['가사 한 줄'] }],
    };
    vi.mocked(recognizeBatchWithGemini).mockImplementation(async (_urls, _key, model) => {
      if (model === 'gemini-3.6-flash') return [geminiAnswer];
      throw new Error('down');
    });
    vi.mocked(recognizeBatchWithNvidia).mockImplementation(async (_urls, _key, _mode, model) => {
      if (model === 'nvidia/nemotron-nano-12b-v2-vl') return [openRouterAnswer];
      throw new Error('down');
    });

    const out = await recognizeScoreBatch(['image-1'], settings, 'full');

    // Gemini's answer wins the page; the key, order, and lyrics it missed
    // come from the OpenRouter answer — but its title is not overwritten.
    expect(out.scores[0].title).toBe('주님의 사랑');
    expect(out.scores[0].key).toBe('G');
    expect(out.scores[0].order).toEqual(['I', 'V1', 'C']);
    expect(out.scores[0].sections).toEqual([{ label: 'V1', lines: ['가사 한 줄'] }]);
  });

  it('recovers stacked verses the winning model merged into one part', async () => {
    // Gemini read the page left-to-right and ran 1절 into 2절; a supporting
    // model kept the stacked rows apart. The split is the true reading of the
    // score, so it must survive even though Gemini won the page.
    const merged: ParsedScore = {
      title: '주 사랑이 나를 숨쉬게 해',
      lyricRowCount: 2,
      order: ['I', 'V', 'C'],
      sections: [
        {
          label: 'V',
          lines: ['주 사랑이 나를 숨쉬게 해', '주 사랑이 나를 이끄시네', '세상 그 어떤 어려움 속에도', '내가 갈 수 없는 그 곳으로'],
        },
        { label: 'C', lines: ['주님만이 내 아픔 아시며'] },
      ],
    };
    const split: ParsedScore = {
      title: '주 사랑이 나를 숨쉬게 해',
      order: ['I', 'V', 'V2', 'C'],
      sections: [
        { label: 'V', lines: ['주 사랑이 나를 숨쉬게 해', '세상 그 어떤 어려움 속에도'] },
        { label: 'V2', lines: ['주 사랑이 나를 이끄시네', '내가 갈 수 없는 그 곳으로'] },
        { label: 'C', lines: ['주님만이 내 아픔 아시며'] },
      ],
    };
    vi.mocked(recognizeBatchWithGemini).mockImplementation(async (_urls, _key, model) => {
      if (model === 'gemini-3.6-flash') return [merged];
      throw new Error('down');
    });
    vi.mocked(recognizeBatchWithNvidia).mockResolvedValue([split]);

    const out = await recognizeScoreBatch(['image-1'], settings, 'full');

    expect(out.scores[0].sections).toEqual(split.sections);
    // 진행 순서 has to learn the recovered label, or the slides never reach it.
    expect(out.scores[0].order).toEqual(['I', 'V', 'V2', 'C']);
  });

  it('does not add an order token the printed 진행 순서 already reaches by alias', async () => {
    // The page printed I-V1-V2-C and the winner read that order correctly; the
    // adopted split labels its first verse bare ("V"). V is already reachable
    // as V1, so 진행 순서 must be left exactly as printed.
    const merged: ParsedScore = {
      order: ['I', 'V1', 'V2', 'C'],
      sections: [
        { label: 'V', lines: ['첫 절 가사', '둘째 절 가사'] },
        { label: 'C', lines: ['후렴 가사'] },
      ],
    };
    const split: ParsedScore = {
      order: ['I', 'V1', 'V2', 'C'],
      sections: [
        { label: 'V', lines: ['첫 절 가사'] },
        { label: 'V2', lines: ['둘째 절 가사'] },
        { label: 'C', lines: ['후렴 가사'] },
      ],
    };
    vi.mocked(recognizeBatchWithGemini).mockImplementation(async (_urls, _key, model) => {
      if (model === 'gemini-3.6-flash') return [merged];
      throw new Error('down');
    });
    vi.mocked(recognizeBatchWithNvidia).mockResolvedValue([split]);

    const out = await recognizeScoreBatch(['image-1'], settings, 'full');

    expect(out.scores[0].sections).toEqual(split.sections);
    expect(out.scores[0].order).toEqual(['I', 'V1', 'V2', 'C']);
  });

  it('keeps the winning reading when another model split a genuinely different part', async () => {
    const winner: ParsedScore = {
      order: ['I', 'V'],
      sections: [{ label: 'V', lines: ['주님만이 내 아픔 아시며'] }],
    };
    const unrelated: ParsedScore = {
      order: ['I', 'V', 'V2'],
      sections: [
        { label: 'V', lines: ['전혀 다른 노래의 가사입니다'] },
        { label: 'V2', lines: ['이 페이지와 상관없는 두 번째 절'] },
      ],
    };
    vi.mocked(recognizeBatchWithGemini).mockImplementation(async (_urls, _key, model) => {
      if (model === 'gemini-3.6-flash') return [winner];
      throw new Error('down');
    });
    vi.mocked(recognizeBatchWithNvidia).mockResolvedValue([unrelated]);

    const out = await recognizeScoreBatch(['image-1'], settings, 'full');

    expect(out.scores[0].sections).toEqual(winner.sections);
    expect(out.scores[0].order).toEqual(['I', 'V']);
  });

  it('never fills lyric fields from a model that disagrees with a non-score verdict', async () => {
    const nonScore: ParsedScore = {
      pageType: 'non_score',
      sermonTitle: '믿음으로 걷기',
      order: [],
      sections: [],
    };
    const disagreeing: ParsedScore = {
      pageType: 'score',
      title: '엉뚱한 곡',
      order: ['I'],
      sections: [{ label: 'V1', lines: ['잘못 읽은 가사'] }],
    };
    vi.mocked(recognizeBatchWithGemini).mockImplementation(async (_urls, _key, model) => {
      if (model === 'gemini-3.6-flash') return [nonScore];
      throw new Error('down');
    });
    vi.mocked(recognizeBatchWithNvidia).mockImplementation(async (_urls, _key, _mode, model) => {
      if (model === 'nvidia/nemotron-nano-12b-v2-vl') return [disagreeing];
      throw new Error('down');
    });

    const out = await recognizeScoreBatch(['image-1'], settings, 'full');

    expect(out.scores[0].pageType).toBe('non_score');
    expect(out.scores[0].sermonTitle).toBe('믿음으로 걷기');
    expect(out.scores[0].title).toBeUndefined();
    expect(out.scores[0].sections).toEqual([]);
  });

  it('forwards title hints to every concurrent Gemini model', async () => {
    vi.mocked(recognizeBatchWithGemini).mockImplementation(async (_urls, _key, model) => {
      if (model === 'gemini-3.5-flash') return [first, second];
      throw new Error('down');
    });
    const hints = ['주 은혜임을', undefined];

    await recognizeScoreBatch(['image-1', 'image-2'], settings, 'full', hints);

    const calls = vi.mocked(recognizeBatchWithGemini).mock.calls;
    expect(calls).toHaveLength(GEMINI_MODEL_COUNT);
    expect(calls.every((call) => call[6] === hints)).toBe(true);
  });

  it('rejects when all concurrent models fail or return empty', async () => {
    vi.mocked(recognizeBatchWithGemini).mockResolvedValue([empty, empty]);
    await expect(recognizeScoreBatch(['image-1', 'image-2'], settings, 'full')).rejects.toThrow();
  });

  it('uses the same complete pool for the full-lyrics ensemble API', async () => {
    vi.mocked(recognizeBatchWithNvidia).mockImplementation(async (_urls, _key, _mode, model) => {
      if (model === 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free') return [first, second];
      throw new Error('down');
    });

    const out = await recognizeScoreBatchEnsemble(['image-1', 'image-2'], settings, 'full');

    expect(out.engine).toBe('nvidia');
    expect(recognizeBatchWithGemini).toHaveBeenCalledTimes(GEMINI_MODEL_COUNT);
    expect(recognizeBatchWithNvidia).toHaveBeenCalledTimes(NVIDIA_MODEL_COUNT);
  });
});

describe('applyScoreToSong', () => {
  it('fills a blank stub with the recognized title, key, order and sections', () => {
    const next = applyScoreToSong(stub, parsed);
    expect(next.title).toBe('주님의 사랑');
    expect(next.key).toBe('E');
    expect(next.order).toEqual(['I', 'V1', 'C', 'C']);
    expect(next.sections.map((s) => s.label)).toEqual(['V1', 'C']);
    expect(stub.sections).toEqual([]); // input not mutated
  });

  it('keeps a title and key the user already set', () => {
    const edited: Song = { ...stub, title: '내가 정한 제목', key: 'G' };
    const next = applyScoreToSong(edited, parsed);
    expect(next.title).toBe('내가 정한 제목');
    expect(next.key).toBe('G');
  });

  it('does not overwrite lyrics the user has already typed', () => {
    const edited: Song = {
      ...stub,
      sections: [{ label: 'V1', lines: ['이미 쓴 가사'] }],
      order: ['I', 'V1'],
    };
    const next = applyScoreToSong(edited, parsed);
    expect(next.sections).toEqual([{ label: 'V1', lines: ['이미 쓴 가사'] }]);
  });

  it('derives an order from sections when the result has none', () => {
    const next = applyScoreToSong(stub, { ...parsed, order: [] });
    expect(next.order).toEqual(['I', 'V1', 'C']);
  });

  it('sorts sections to match the printed order even when the engine listed them out of sequence', () => {
    // Recognition can read the lyric blocks top-to-bottom on the page and list
    // Chorus before Verse 2, even though the score's own 진행 순서 line says
    // V1 comes before V2 comes before C — the saved section list should follow
    // the printed order, not the engine's listing order.
    const outOfOrder: ParsedScore = {
      title: '주님의 사랑',
      order: ['I', 'V1', 'V2', 'C'],
      sections: [
        { label: 'C', lines: ['후렴 줄'] },
        { label: 'V2', lines: ['둘째 절'] },
        { label: 'V1', lines: ['첫째 절'] },
      ],
    };
    const next = applyScoreToSong(stub, outOfOrder);
    expect(next.sections.map((s) => s.label)).toEqual(['V1', 'V2', 'C']);
  });
});

describe('line-level consensus across the model pool', () => {
  /** Winner (top-priority Gemini) plus two supporting readings of one page. */
  const pool = (winner: ParsedScore, second: ParsedScore, third: ParsedScore) => {
    vi.mocked(recognizeBatchWithGemini).mockImplementation(async (_urls, _key, model) =>
      model === 'gemini-3.6-flash' ? [winner] : [second],
    );
    vi.mocked(recognizeBatchWithNvidia).mockResolvedValue([third]);
  };
  const one = (lines: string[]): ParsedScore => ({
    title: '믿음과 삶',
    order: ['I', 'V'],
    sections: [{ label: 'V', lines }],
  });

  it('lets two agreeing models outvote the winner on a misread line', async () => {
    // The slips that dominate what is left are a syllable or two inside an
    // otherwise correct line, and they differ per model — so agreement wins.
    pool(
      one(['믿음과 삶을 살아내는 능력이', '자신없는 내 모습']),
      one(['믿음과 삶을 살아내는 실력이', '자신없는 내 모습']),
      one(['믿음과 삶을 살아내는 실력이', '자신없는 내 모습']),
    );
    const out = await recognizeScoreBatch(['image-1'], settings, 'full');
    expect(out.scores[0].sections[0].lines[0]).toBe('믿음과 삶을 살아내는 실력이');
    // The line every model agreed on is left exactly as the winner had it.
    expect(out.scores[0].sections[0].lines[1]).toBe('자신없는 내 모습');
  });

  it('keeps the winner when the others do not agree with each other', async () => {
    pool(one(['주의 이야기 되네']), one(['주의 이끄심 되네']), one(['주의 이야기 되네']));
    const out = await recognizeScoreBatch(['image-1'], settings, 'full');
    expect(out.scores[0].sections[0].lines[0]).toBe('주의 이야기 되네');
  });

  it('never swaps in a line that reads as different lyrics altogether', async () => {
    // Two models agreeing on a line from elsewhere on the page must not be
    // able to overwrite a line the winner read from the right place.
    pool(
      one(['하나님의 사랑을 사모하는 자']),
      one(['어두움에 밝은 빛을 비춰주시고']),
      one(['어두움에 밝은 빛을 비춰주시고']),
    );
    const out = await recognizeScoreBatch(['image-1'], settings, 'full');
    expect(out.scores[0].sections[0].lines[0]).toBe('하나님의 사랑을 사모하는 자');
  });

  it('skips a supporting reading whose part has a different number of lines', async () => {
    // Line n of a shorter section is not line n of the winner's — comparing
    // them would vote across a shifted part.
    pool(one(['첫 줄 능력이', '둘째 줄']), one(['첫 줄 실력이']), one(['첫 줄 실력이']));
    const out = await recognizeScoreBatch(['image-1'], settings, 'full');
    expect(out.scores[0].sections[0].lines[0]).toBe('첫 줄 능력이');
  });

  it('is inert for a pool of two, where one vote can never beat the winner', async () => {
    vi.mocked(recognizeBatchWithGemini).mockImplementation(async (_urls, _key, model) =>
      model === 'gemini-3.6-flash' ? [one(['능력이'])] : [one(['실력이'])],
    );
    vi.mocked(recognizeBatchWithNvidia).mockRejectedValue(new Error('down'));
    const out = await recognizeScoreBatch(['image-1'], settings, 'full');
    expect(out.scores[0].sections[0].lines[0]).toBe('능력이');
  });
});

describe('lines the winning model stopped short of', () => {
  const winnerAnd = (winner: ParsedScore, other: ParsedScore) => {
    vi.mocked(recognizeBatchWithGemini).mockImplementation(async (_urls, _key, model) =>
      model === 'gemini-3.6-flash' ? [winner] : [other],
    );
    vi.mocked(recognizeBatchWithNvidia).mockRejectedValue(new Error('down'));
  };

  it('appends a dropped tail from a model that read further', async () => {
    // 그리스도의 계절: the winner ended the verse mid-phrase and lost the last line.
    winnerAnd(
      { order: ['I', 'V'], sections: [{ label: 'V', lines: ['민족의 가슴마다', '이 땅에 푸르고 푸른'] }] },
      {
        order: ['I', 'V'],
        sections: [{ label: 'V', lines: ['민족의 가슴마다', '이 땅에 푸르고 푸른', '오게 하소서 오게 하소서'] }],
      },
    );
    const out = await recognizeScoreBatch(['image-1'], settings, 'full');
    expect(out.scores[0].sections[0].lines).toEqual([
      '민족의 가슴마다',
      '이 땅에 푸르고 푸른',
      '오게 하소서 오게 하소서',
    ]);
  });

  it('keeps the winner’s wording for the lines it already had', async () => {
    // The fuller reading is not necessarily the better one — take its tail, not its text.
    winnerAnd(
      { order: ['I', 'V'], sections: [{ label: 'V', lines: ['살아내는 실력이'] }] },
      { order: ['I', 'V'], sections: [{ label: 'V', lines: ['살아내는 능력이', '자신없는 내 모습'] }] },
    );
    const out = await recognizeScoreBatch(['image-1'], settings, 'full');
    expect(out.scores[0].sections[0].lines).toEqual(['살아내는 실력이', '자신없는 내 모습']);
  });

  it('refuses to extend a reading that diverges before the tail', async () => {
    // Different lines in the shared positions means the two models are not
    // reading the same part, so the "extra" lines are not a dropped tail.
    winnerAnd(
      { order: ['I', 'V'], sections: [{ label: 'V', lines: ['하나님의 사랑을 사모하는 자'] }] },
      { order: ['I', 'V'], sections: [{ label: 'V', lines: ['어두움에 밝은 빛을', '너의 작은 신음에도'] }] },
    );
    const out = await recognizeScoreBatch(['image-1'], settings, 'full');
    expect(out.scores[0].sections[0].lines).toEqual(['하나님의 사랑을 사모하는 자']);
  });

  it('never shortens a section when another model read less', async () => {
    winnerAnd(
      { order: ['I', 'V'], sections: [{ label: 'V', lines: ['첫 줄', '둘째 줄', '셋째 줄'] }] },
      { order: ['I', 'V'], sections: [{ label: 'V', lines: ['첫 줄'] }] },
    );
    const out = await recognizeScoreBatch(['image-1'], settings, 'full');
    expect(out.scores[0].sections[0].lines).toHaveLength(3);
  });
});
