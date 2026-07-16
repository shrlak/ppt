import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyScoreToSong, recognizeScore, recognizeScoreBatch } from '../../src/lib/ai/scoreRecognition';
import { DEFAULT_AI_SETTINGS } from '../../src/lib/ai/aiSettings';
import { RecognitionError } from '../../src/lib/ai/recognitionError';
import type { Song } from '../../src/lib/utils/types';
import type { ParsedScore } from '../../src/lib/ai/scoreParser';

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

  it('uses Gemini first and reports it as the engine', async () => {
    vi.mocked(recognizeWithGemini).mockResolvedValue(result);
    const out = await recognizeScore('data:image/png;base64,x', settings);
    expect(out.engine).toBe('gemini');
    expect(recognizeWithGemini).toHaveBeenCalledTimes(1);
    expect(recognizeWithNvidia).not.toHaveBeenCalled();
    expect(recognizeWithHuggingFace).not.toHaveBeenCalled();
  });

  it('falls back to NVIDIA once Gemini fails (quota/tokens exhausted)', async () => {
    vi.mocked(recognizeWithGemini).mockRejectedValue(new Error('quota'));
    vi.mocked(recognizeWithNvidia).mockResolvedValue(result);
    const out = await recognizeScore('data:image/png;base64,x', settings);
    expect(out.engine).toBe('nvidia');
    expect(recognizeWithGemini).toHaveBeenCalledTimes(1);
    expect(recognizeWithNvidia).toHaveBeenCalledTimes(1);
    expect(recognizeWithHuggingFace).not.toHaveBeenCalled();
  });

  it('continues to Hugging Face when NVIDIA also fails', async () => {
    vi.mocked(recognizeWithGemini).mockRejectedValue(new Error('down'));
    vi.mocked(recognizeWithNvidia).mockRejectedValue(new Error('down'));
    vi.mocked(recognizeWithHuggingFace).mockResolvedValue(result);
    const out = await recognizeScore('data:image/png;base64,x', settings);
    expect(out.engine).toBe('huggingface');
  });

  it('throws once every engine fails', async () => {
    vi.mocked(recognizeWithGemini).mockRejectedValue(new Error('down'));
    vi.mocked(recognizeWithNvidia).mockRejectedValue(new Error('down'));
    vi.mocked(recognizeWithHuggingFace).mockRejectedValue(new Error('down'));
    await expect(recognizeScore('data:image/png;base64,x', settings)).rejects.toThrow('down');
    expect(recognizeWithGemini).toHaveBeenCalledTimes(1);
    expect(recognizeWithNvidia).toHaveBeenCalledTimes(1);
    expect(recognizeWithHuggingFace).toHaveBeenCalledTimes(1);
  });

  it('retries the same engine once after a transient failure (429)', async () => {
    vi.useFakeTimers();
    vi.mocked(recognizeWithGemini)
      .mockRejectedValueOnce(new RecognitionError('Gemini 호출 실패: HTTP 429', 429))
      .mockResolvedValueOnce(result);
    const pending = recognizeScore('data:image/png;base64,x', settings);
    await vi.advanceTimersByTimeAsync(2000);
    const out = await pending;
    expect(out.engine).toBe('gemini');
    expect(recognizeWithGemini).toHaveBeenCalledTimes(2);
    expect(recognizeWithNvidia).not.toHaveBeenCalled();
  });

  it('does not retry a permanent failure (400) — moves straight to the next engine', async () => {
    vi.mocked(recognizeWithGemini).mockRejectedValue(new RecognitionError('Gemini 호출 실패: HTTP 400', 400));
    vi.mocked(recognizeWithNvidia).mockResolvedValue(result);
    const out = await recognizeScore('data:image/png;base64,x', settings);
    expect(out.engine).toBe('nvidia');
    expect(recognizeWithGemini).toHaveBeenCalledTimes(1);
  });

  it('treats a completely empty answer as a failure and tries the next engine', async () => {
    vi.mocked(recognizeWithGemini).mockResolvedValue(emptyScore);
    vi.mocked(recognizeWithNvidia).mockResolvedValue(result);
    const out = await recognizeScore('data:image/png;base64,x', settings);
    expect(out.engine).toBe('nvidia');
  });
});

describe('recognizeScoreBatch', () => {
  const first: ParsedScore = { title: '첫째 곡', order: [], sections: [] };
  const second: ParsedScore = { title: '둘째 곡', order: [], sections: [] };
  const empty: ParsedScore = { order: [], sections: [] };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('passes every image to Gemini in one batch call', async () => {
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
    );
    expect(recognizeWithGemini).not.toHaveBeenCalled();
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
