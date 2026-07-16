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
  nvidiaApiKey: 'test-key',
  huggingfaceApiKey: 'test-key',
};

describe('recognizeScore engine priority', () => {
  const result: ParsedScore = { title: 't', key: 'C', order: [], sections: [] };
  const emptyScore: ParsedScore = { order: [], sections: [] };

  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('uses Gemini first — leading with the benchmark-validated default — and reports the engine', async () => {
    vi.mocked(recognizeWithGemini).mockResolvedValue(result);
    const out = await recognizeScore('data:image/png;base64,x', settings);
    expect(out.engine).toBe('gemini');
    expect(recognizeWithGemini).toHaveBeenCalledTimes(1);
    expect(vi.mocked(recognizeWithGemini).mock.calls[0][2]).toBe('gemini-2.5-flash');
    expect(recognizeWithNvidia).not.toHaveBeenCalled();
    expect(recognizeWithHuggingFace).not.toHaveBeenCalled();
  });

  it('falls down the Gemini model ladder before leaving Gemini', async () => {
    vi.mocked(recognizeWithGemini)
      .mockRejectedValueOnce(new RecognitionError('Gemini 호출 실패: HTTP 400', 400))
      .mockResolvedValueOnce(result);
    const out = await recognizeScore('data:image/png;base64,x', settings);
    expect(out.engine).toBe('gemini');
    expect(vi.mocked(recognizeWithGemini).mock.calls.map((call) => call[2])).toEqual([
      'gemini-2.5-flash',
      'gemini-2.0-flash',
    ]);
    expect(recognizeWithNvidia).not.toHaveBeenCalled();
  });

  it('falls back to NVIDIA once Gemini fails (quota/tokens exhausted)', async () => {
    vi.mocked(recognizeWithGemini).mockRejectedValue(new Error('quota'));
    vi.mocked(recognizeWithNvidia).mockResolvedValue(result);
    const out = await recognizeScore('data:image/png;base64,x', settings);
    expect(out.engine).toBe('nvidia');
    // Every catalog Gemini model is tried before leaving Gemini.
    expect(recognizeWithGemini).toHaveBeenCalledTimes(GEMINI_MODEL_COUNT);
    expect(recognizeWithNvidia).toHaveBeenCalledTimes(1);
    // The first NVIDIA attempt uses the catalog's top NVIDIA model.
    expect(vi.mocked(recognizeWithNvidia).mock.calls[0][2]).toBe('nvidia/nemotron-nano-12b-v2-vl');
    expect(recognizeWithHuggingFace).not.toHaveBeenCalled();
  });

  it('continues to Hugging Face when NVIDIA also fails', async () => {
    vi.mocked(recognizeWithGemini).mockRejectedValue(new Error('down'));
    vi.mocked(recognizeWithNvidia).mockRejectedValue(new Error('down'));
    vi.mocked(recognizeWithHuggingFace).mockResolvedValue(result);
    const out = await recognizeScore('data:image/png;base64,x', settings);
    expect(out.engine).toBe('huggingface');
  });

  it('throws once every attempt fails', async () => {
    vi.mocked(recognizeWithGemini).mockRejectedValue(new Error('down'));
    vi.mocked(recognizeWithNvidia).mockRejectedValue(new Error('down'));
    vi.mocked(recognizeWithHuggingFace).mockRejectedValue(new Error('down'));
    await expect(recognizeScore('data:image/png;base64,x', settings)).rejects.toThrow('down');
    // One call per catalog model of each provider.
    expect(recognizeWithGemini).toHaveBeenCalledTimes(GEMINI_MODEL_COUNT);
    expect(recognizeWithNvidia).toHaveBeenCalledTimes(NVIDIA_MODEL_COUNT);
    expect(recognizeWithHuggingFace).toHaveBeenCalledTimes(1);
  });

  it('retries the same model once after a transient server failure (503)', async () => {
    vi.useFakeTimers();
    vi.mocked(recognizeWithGemini)
      .mockRejectedValueOnce(new RecognitionError('Gemini 호출 실패: HTTP 503', 503))
      .mockResolvedValueOnce(result);
    const pending = recognizeScore('data:image/png;base64,x', settings);
    await vi.advanceTimersByTimeAsync(2000);
    const out = await pending;
    expect(out.engine).toBe('gemini');
    expect(recognizeWithGemini).toHaveBeenCalledTimes(2);
    // Both calls used the same (first) model — a retry, not a ladder step.
    expect(vi.mocked(recognizeWithGemini).mock.calls.map((call) => call[2])).toEqual([
      'gemini-2.5-flash',
      'gemini-2.5-flash',
    ]);
    expect(recognizeWithNvidia).not.toHaveBeenCalled();
  });

  it('does not retry a rate limit (429) — the model ladder is the retry', async () => {
    vi.mocked(recognizeWithGemini)
      .mockRejectedValueOnce(new RecognitionError('Gemini 호출 실패: 429 quota', 429))
      .mockResolvedValueOnce(result);
    const out = await recognizeScore('data:image/png;base64,x', settings);
    expect(out.engine).toBe('gemini');
    // Second call is the NEXT model, reached without any retry delay.
    expect(vi.mocked(recognizeWithGemini).mock.calls.map((call) => call[2])).toEqual([
      'gemini-2.5-flash',
      'gemini-2.0-flash',
    ]);
  });

  it('does not retry a permanent failure (400) — moves straight to the next attempt', async () => {
    vi.mocked(recognizeWithGemini).mockRejectedValue(new RecognitionError('Gemini 호출 실패: HTTP 400', 400));
    vi.mocked(recognizeWithNvidia).mockResolvedValue(result);
    const out = await recognizeScore('data:image/png;base64,x', settings);
    expect(out.engine).toBe('nvidia');
    // One call per Gemini catalog model, no per-model retries.
    expect(recognizeWithGemini).toHaveBeenCalledTimes(GEMINI_MODEL_COUNT);
  });

  it('treats a completely empty answer as a failure and tries the next engine', async () => {
    vi.mocked(recognizeWithGemini).mockResolvedValue(emptyScore);
    vi.mocked(recognizeWithNvidia).mockResolvedValue(result);
    const out = await recognizeScore('data:image/png;base64,x', settings);
    expect(out.engine).toBe('nvidia');
  });
});

describe('recognizeScoreRaced (multiple models at once)', () => {
  const result: ParsedScore = { title: 't', key: 'C', order: [], sections: [] };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('runs the top priority group in parallel and returns the first good answer', async () => {
    vi.mocked(recognizeWithGemini).mockImplementation(async (_url, _key, model) => {
      if (model === 'gemini-2.5-flash') return result;
      throw new Error('quota');
    });
    const out = await recognizeScoreRaced('data:image/png;base64,x', settings);
    expect(out.engine).toBe('gemini');
    // Default group size 3 → the three Gemini models fired together.
    expect(recognizeWithGemini).toHaveBeenCalledTimes(3);
    expect(recognizeWithNvidia).not.toHaveBeenCalled();
  });

  it('moves to the next parallel group when the whole group fails', async () => {
    vi.mocked(recognizeWithGemini).mockRejectedValue(new Error('down'));
    vi.mocked(recognizeWithNvidia).mockImplementation(async (_url, _key, model) => {
      if (model === 'nvidia/nemotron-nano-12b-v2-vl') return result;
      throw new Error('down');
    });
    const out = await recognizeScoreRaced('data:image/png;base64,x', settings);
    expect(out.engine).toBe('nvidia');
    expect(recognizeWithGemini).toHaveBeenCalledTimes(3);
  });

  it('honors a custom administrator priority order', async () => {
    const custom = {
      ...settings,
      attempts: [
        { engine: 'nvidia' as const, model: 'google/gemma-3-27b-it' },
        { engine: 'gemini' as const, model: 'gemini-2.5-flash' },
      ],
    };
    vi.mocked(recognizeWithNvidia).mockResolvedValue(result);
    vi.mocked(recognizeWithGemini).mockResolvedValue(result);
    const out = await recognizeScoreRaced('data:image/png;base64,x', custom, 1);
    expect(out.engine).toBe('nvidia');
    expect(vi.mocked(recognizeWithNvidia).mock.calls[0][2]).toBe('google/gemma-3-27b-it');
    expect(recognizeWithGemini).not.toHaveBeenCalled();
  });
});

describe('recognizeScoreBatch', () => {
  const first: ParsedScore = { title: '첫째 곡', order: [], sections: [] };
  const second: ParsedScore = { title: '둘째 곡', order: [], sections: [] };
  const empty: ParsedScore = { order: [], sections: [] };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('passes every image to Gemini in one batch call (titles use the fast model)', async () => {
    vi.mocked(recognizeBatchWithGemini).mockResolvedValue([first, second]);

    const out = await recognizeScoreBatch(['image-1', 'image-2'], settings, 'titles');

    expect(out.scores).toEqual([first, second]);
    expect(out.engine).toBe('gemini');
    expect(recognizeBatchWithGemini).toHaveBeenCalledTimes(1);
    expect(recognizeBatchWithGemini).toHaveBeenCalledWith(
      ['image-1', 'image-2'],
      'test-key',
      settings.geminiModel,
      'titles',
      false,
      undefined,
      undefined,
    );
    expect(recognizeWithGemini).not.toHaveBeenCalled();
  });

  it('walks the Gemini ladder on the full pass and forwards the title hints', async () => {
    vi.mocked(recognizeBatchWithGemini)
      .mockRejectedValueOnce(new RecognitionError('Gemini 일괄 호출 실패: HTTP 400', 400))
      .mockResolvedValueOnce([first, second]);

    const hints = ['주 은혜임을', undefined];
    const out = await recognizeScoreBatch(['image-1', 'image-2'], settings, 'full', hints);

    expect(out.engine).toBe('gemini');
    const calls = vi.mocked(recognizeBatchWithGemini).mock.calls;
    expect(calls.map((call) => call[2])).toEqual(['gemini-2.5-flash', 'gemini-2.0-flash']);
    expect(calls[0][6]).toEqual(hints);
    expect(calls[1][6]).toEqual(hints);
  });

  it('falls back as a whole batch instead of retrying each image separately', async () => {
    vi.mocked(recognizeBatchWithGemini).mockRejectedValue(new Error('quota'));
    vi.mocked(recognizeBatchWithNvidia).mockResolvedValue([first, second]);

    const out = await recognizeScoreBatch(['image-1', 'image-2'], settings, 'full');

    expect(out.engine).toBe('nvidia');
    expect(recognizeBatchWithNvidia).toHaveBeenCalledTimes(1);
    expect(recognizeWithNvidia).not.toHaveBeenCalled();
    expect(recognizeBatchWithHuggingFace).not.toHaveBeenCalled();
  });

  it('treats an all-empty batch answer as a failure and tries the next engine', async () => {
    vi.mocked(recognizeBatchWithGemini).mockResolvedValue([empty, empty]);
    vi.mocked(recognizeBatchWithNvidia).mockResolvedValue([first, second]);

    const out = await recognizeScoreBatch(['image-1', 'image-2'], settings, 'full');

    expect(out.engine).toBe('nvidia');
    expect(out.scores).toEqual([first, second]);
  });

  it('accepts a partially empty batch answer (one hard page must not fail the rest)', async () => {
    vi.mocked(recognizeBatchWithGemini).mockResolvedValue([first, empty]);

    const out = await recognizeScoreBatch(['image-1', 'image-2'], settings, 'full');

    expect(out.engine).toBe('gemini');
    expect(out.scores).toEqual([first, empty]);
    expect(recognizeBatchWithNvidia).not.toHaveBeenCalled();
  });
});

describe('recognizeScoreBatchEnsemble (multiple models at once)', () => {
  const bySongA: ParsedScore = { title: 'A', order: [], sections: [{ label: 'V1', lines: ['a'] }] };
  const bySongB: ParsedScore = { title: 'B', order: [], sections: [{ label: 'V1', lines: ['b'] }] };
  const empty: ParsedScore = { order: [], sections: [] };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('runs the top models in parallel and fills per-song gaps by priority', async () => {
    // Model 1 (2.5-flash) reads song 0 but misses song 1; model 2 (2.0-flash)
    // reads both. The merge takes song 0 from model 1 and song 1 from model 2.
    vi.mocked(recognizeBatchWithGemini).mockImplementation(async (_urls, _key, model) => {
      if (model === 'gemini-2.5-flash') return [bySongA, empty];
      return [{ ...bySongA, title: 'A2' }, bySongB];
    });

    const out = await recognizeScoreBatchEnsemble(['img-1', 'img-2'], settings, 'full');

    expect(out.scores[0].title).toBe('A');
    expect(out.scores[1].title).toBe('B');
    // Both models were called — at once, in the same group.
    const models = vi.mocked(recognizeBatchWithGemini).mock.calls.map((call) => call[2]);
    expect(models).toContain('gemini-2.5-flash');
    expect(models).toContain('gemini-2.0-flash');
  });

  it('survives one model of the group failing entirely', async () => {
    vi.mocked(recognizeBatchWithGemini).mockImplementation(async (_urls, _key, model) => {
      if (model === 'gemini-2.5-flash') throw new RecognitionError('HTTP 429', 429);
      return [bySongA, bySongB];
    });

    const out = await recognizeScoreBatchEnsemble(['img-1', 'img-2'], settings, 'full');
    expect(out.scores.map((score) => score.title)).toEqual(['A', 'B']);
    expect(out.engine).toBe('gemini');
  });

  it('moves to the next parallel group when the whole group returns nothing', async () => {
    vi.mocked(recognizeBatchWithGemini).mockResolvedValue([empty, empty]);
    vi.mocked(recognizeBatchWithNvidia).mockResolvedValue([bySongA, bySongB]);

    const out = await recognizeScoreBatchEnsemble(['img-1', 'img-2'], settings, 'full', undefined, 3);
    expect(out.engine).toBe('nvidia');
    expect(out.scores[0].title).toBe('A');
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
