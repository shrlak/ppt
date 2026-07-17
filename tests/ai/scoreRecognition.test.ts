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

vi.mock('../../src/lib/ai/scoreAi', () => ({
  recognizeWithGemini: vi.fn(),
  recognizeBatchWithGemini: vi.fn(),
}));
vi.mock('../../src/lib/ai/scoreNvidia', () => ({
  recognizeWithNvidia: vi.fn(),
  recognizeBatchWithNvidia: vi.fn(),
}));
vi.mock('../../src/lib/ai/scoreHuggingFace', () => ({
  recognizeWithHuggingFace: vi.fn(),
  recognizeBatchWithHuggingFace: vi.fn(),
}));

import { recognizeBatchWithGemini, recognizeWithGemini } from '../../src/lib/ai/scoreAi';
import { recognizeBatchWithNvidia, recognizeWithNvidia } from '../../src/lib/ai/scoreNvidia';
import { recognizeBatchWithHuggingFace, recognizeWithHuggingFace } from '../../src/lib/ai/scoreHuggingFace';

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
  huggingfaceApiKey: 'test-key',
};

describe('concurrent single-page recognition', () => {
  const result: ParsedScore = { title: 't', key: 'C', order: [], sections: [] };
  const emptyScore: ParsedScore = { order: [], sections: [] };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(recognizeWithGemini).mockRejectedValue(new Error('down'));
    vi.mocked(recognizeWithNvidia).mockRejectedValue(new Error('down'));
    vi.mocked(recognizeWithHuggingFace).mockRejectedValue(new Error('down'));
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
    expect(recognizeWithHuggingFace).toHaveBeenCalledTimes(1);
  });

  it('lets a later-listed provider win by finishing first', async () => {
    vi.mocked(recognizeWithHuggingFace).mockResolvedValue(result);
    const out = await recognizeScore('data:image/png;base64,x', settings);
    expect(out.engine).toBe('huggingface');
    expect(recognizeWithGemini).toHaveBeenCalledTimes(GEMINI_MODEL_COUNT);
    expect(recognizeWithNvidia).toHaveBeenCalledTimes(NVIDIA_MODEL_COUNT);
  });

  it('ignores empty answers while the other concurrent models continue', async () => {
    vi.mocked(recognizeWithGemini).mockResolvedValue(emptyScore);
    vi.mocked(recognizeWithHuggingFace).mockResolvedValue(result);
    const out = await recognizeScore('data:image/png;base64,x', settings);
    expect(out.engine).toBe('huggingface');
  });

  it('treats an explicit non-score classification as usable without inventing a song', async () => {
    const nonScore: ParsedScore = { pageType: 'non_score', order: [], sections: [] };
    vi.mocked(recognizeWithHuggingFace).mockResolvedValue(nonScore);
    const out = await recognizeScore('data:image/png;base64,x', settings);
    expect(out).toMatchObject({ engine: 'huggingface', score: { pageType: 'non_score' } });
  });

  it('throws once every concurrently started model fails', async () => {
    await expect(recognizeScore('data:image/png;base64,x', settings)).rejects.toThrow('down');
    expect(recognizeWithGemini).toHaveBeenCalledTimes(GEMINI_MODEL_COUNT);
    expect(recognizeWithNvidia).toHaveBeenCalledTimes(NVIDIA_MODEL_COUNT);
    expect(recognizeWithHuggingFace).toHaveBeenCalledTimes(1);
  });

  it('retries an individual model once after a transient server failure', async () => {
    vi.useFakeTimers();
    const oneModel = {
      ...settings,
      attempts: [{ engine: 'gemini' as const, model: 'gemini-2.5-flash' }],
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
    vi.mocked(recognizeWithHuggingFace).mockResolvedValue(result);
    const out = await recognizeScoreRaced('data:image/png;base64,x', settings);
    expect(out.engine).toBe('huggingface');
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
    vi.mocked(recognizeBatchWithHuggingFace).mockRejectedValue(new Error('down'));
  });

  it('launches every model together for the title pass', async () => {
    vi.mocked(recognizeBatchWithGemini).mockImplementation(async (_urls, _key, model) => {
      if (model === 'gemini-2.5-flash') return [first, second];
      throw new Error('down');
    });

    const out = await recognizeScoreBatch(['image-1', 'image-2'], settings, 'titles');

    expect(out.scores).toEqual([first, second]);
    expect(recognizeBatchWithGemini).toHaveBeenCalledTimes(GEMINI_MODEL_COUNT);
    expect(recognizeBatchWithNvidia).toHaveBeenCalledTimes(NVIDIA_MODEL_COUNT);
    expect(recognizeBatchWithHuggingFace).toHaveBeenCalledTimes(1);
  });

  it('keeps a non-score page in the aligned title results for caller-side filtering', async () => {
    const nonScore: ParsedScore = {
      pageType: 'non_score',
      sermonTitle: '믿음으로 걷기',
      scripture: '히브리서 11장 1-3절',
      order: [],
      sections: [],
    };
    vi.mocked(recognizeBatchWithHuggingFace).mockResolvedValue([nonScore, second]);

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
      model === 'gemini-2.5-flash' ? gemini : Promise.reject(new Error('down')),
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
    // Hugging Face never settles — a lower-priority straggler must not block.
    vi.mocked(recognizeBatchWithHuggingFace).mockImplementation(() => new Promise(() => {}));

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
      if (model === 'gemini-2.5-flash') return [geminiAnswer];
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
      if (model === 'gemini-2.5-flash') return [nonScore];
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
      if (model === 'gemini-2.0-flash') return [first, second];
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
      if (model === 'google/gemma-4-31b-it:free') return [first, second];
      throw new Error('down');
    });

    const out = await recognizeScoreBatchEnsemble(['image-1', 'image-2'], settings, 'full');

    expect(out.engine).toBe('nvidia');
    expect(recognizeBatchWithGemini).toHaveBeenCalledTimes(GEMINI_MODEL_COUNT);
    expect(recognizeBatchWithNvidia).toHaveBeenCalledTimes(NVIDIA_MODEL_COUNT);
    expect(recognizeBatchWithHuggingFace).toHaveBeenCalledTimes(1);
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
