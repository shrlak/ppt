import { beforeEach, describe, expect, it, vi } from 'vitest';
import { applyScoreToSong, recognizeScore } from '../../src/lib/ai/scoreRecognition';
import { DEFAULT_AI_SETTINGS } from '../../src/lib/ai/aiSettings';
import type { Song } from '../../src/lib/utils/types';
import type { ParsedScore } from '../../src/lib/ai/scoreParser';

vi.mock('../../src/lib/ai/scoreAi', () => ({ recognizeWithGemini: vi.fn() }));
vi.mock('../../src/lib/ai/scoreHuggingFace', () => ({ recognizeWithHuggingFace: vi.fn() }));
vi.mock('../../src/lib/ai/scoreOcr', () => ({ recognizeWithTesseract: vi.fn() }));

import { recognizeWithGemini } from '../../src/lib/ai/scoreAi';
import { recognizeWithHuggingFace } from '../../src/lib/ai/scoreHuggingFace';
import { recognizeWithTesseract } from '../../src/lib/ai/scoreOcr';

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

describe('recognizeScore engine priority', () => {
  const settings = { ...DEFAULT_AI_SETTINGS, geminiApiKey: 'test-key', huggingfaceApiKey: 'test-key' };
  const result: ParsedScore = { title: 't', key: 'C', order: [], sections: [] };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('uses Gemini first and reports it as the engine', async () => {
    vi.mocked(recognizeWithGemini).mockResolvedValue(result);
    const out = await recognizeScore('data:image/png;base64,x', settings);
    expect(out.engine).toBe('gemini');
    expect(recognizeWithGemini).toHaveBeenCalledTimes(1);
    expect(recognizeWithHuggingFace).not.toHaveBeenCalled();
    expect(recognizeWithTesseract).not.toHaveBeenCalled();
  });

  it('falls back to Hugging Face when Gemini fails', async () => {
    vi.mocked(recognizeWithGemini).mockRejectedValue(new Error('quota'));
    vi.mocked(recognizeWithHuggingFace).mockResolvedValue(result);
    const out = await recognizeScore('data:image/png;base64,x', settings);
    expect(out.engine).toBe('huggingface');
    expect(recognizeWithTesseract).not.toHaveBeenCalled();
  });

  it('falls back to browser OCR only when both AI engines fail', async () => {
    vi.mocked(recognizeWithGemini).mockRejectedValue(new Error('down'));
    vi.mocked(recognizeWithHuggingFace).mockRejectedValue(new Error('down'));
    vi.mocked(recognizeWithTesseract).mockResolvedValue(result);
    const out = await recognizeScore('data:image/png;base64,x', settings);
    expect(out.engine).toBe('tesseract');
    expect(recognizeWithGemini).toHaveBeenCalledTimes(1);
    expect(recognizeWithHuggingFace).toHaveBeenCalledTimes(1);
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
});
