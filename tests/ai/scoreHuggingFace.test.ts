import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildHuggingFaceBatchPayload,
  extractImageBase64,
  parseHuggingFaceBatchPayload,
  parseHuggingFacePayload,
  recognizeBatchWithHuggingFace,
  recognizeWithHuggingFace,
} from '../../src/lib/ai/scoreHuggingFace';

describe('extractImageBase64', () => {
  it('splits the base64 payload out of a data URL', () => {
    expect(extractImageBase64('data:image/jpeg;base64,AAAA')).toBe('AAAA');
  });

  it('passes through a plain string unchanged', () => {
    expect(extractImageBase64('AAAA')).toBe('AAAA');
  });
});

describe('parseHuggingFacePayload', () => {
  it('maps a well-formed payload into a ParsedScore', () => {
    const parsed = parseHuggingFacePayload({
      title: '  주님의 사랑  ',
      key: 'E',
      order: ['I', 'V1', 'C'],
      sections: [{ label: 'v1', lines: [' 첫째 줄 ', '둘째 줄'] }],
    });
    expect(parsed.title).toBe('주님의 사랑');
    expect(parsed.key).toBe('E');
    expect(parsed.order).toEqual(['I', 'V1', 'C']);
    expect(parsed.sections).toEqual([{ label: 'V1', lines: ['첫째 줄', '둘째 줄'] }]);
  });

  it('tolerates missing/garbled fields', () => {
    const parsed = parseHuggingFacePayload({ sections: [{ label: '', lines: 'nope' }, { label: 'C' }] });
    expect(parsed.title).toBeUndefined();
    expect(parsed.order).toEqual([]);
    expect(parsed.sections).toEqual([{ label: 'C', lines: [] }]);
  });
});

describe('Hugging Face batch recognition', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('puts every score image into one multimodal payload', () => {
    const payload = buildHuggingFaceBatchPayload(
      ['data:image/png;base64,FIRST', 'data:image/png;base64,SECOND'],
      'full',
    ) as { inputs: { content: { type: string; image?: string }[] }[] };
    expect(payload.inputs[0].content.filter((part) => part.type === 'image').map((part) => part.image)).toEqual([
      'FIRST',
      'SECOND',
    ]);
    const prompt = payload.inputs[0].content.find((part) => part.type === 'text') as { text?: string };
    expect(prompt.text).toContain('pageType');
    expect(prompt.text).toContain('non_score 페이지에서는 설교 제목과 본문만');
  });

  it('restores results to image order and keeps title mode lyric-free', () => {
    const scores = parseHuggingFaceBatchPayload(
      {
        results: [
          { imageIndex: 1, title: '둘째 곡', sections: [{ label: 'C', lines: ['무시할 가사'] }] },
          { imageIndex: 0, title: '첫째 곡' },
        ],
      },
      2,
      'titles',
    );
    expect(scores.map((score) => score.title)).toEqual(['첫째 곡', '둘째 곡']);
    expect(scores.every((score) => score.sections.length === 0)).toBe(true);
  });

  it('sends multiple score images with one fetch call', async () => {
    const generated = JSON.stringify({
      results: [
        { imageIndex: 0, title: '첫째 곡' },
        { imageIndex: 1, title: '둘째 곡' },
      ],
    });
    const fetchSpy = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify([{ generated_text: generated }]), { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);

    const scores = await recognizeBatchWithHuggingFace(
      ['data:image/png;base64,FIRST', 'data:image/png;base64,SECOND'],
      'key',
      'titles',
    );

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(scores.map((score) => score.title)).toEqual(['첫째 곡', '둘째 곡']);
  });
});

describe('recognizeWithHuggingFace', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const okResponse = () =>
    new Response(JSON.stringify([{ generated_text: '{"title":"t","sections":[]}' }]), { status: 200 });

  it('calls Hugging Face directly with a Bearer token when a key is given', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(okResponse());
    vi.stubGlobal('fetch', fetchSpy);

    await recognizeWithHuggingFace('data:image/png;base64,ZZZ', 'hf-key', undefined, 'https://proxy.example');

    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('api-inference.huggingface.co');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer hf-key');
  });

  it('routes through the proxy without an Authorization header when the key is blank', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(okResponse());
    vi.stubGlobal('fetch', fetchSpy);

    await recognizeWithHuggingFace('data:image/png;base64,ZZZ', '', undefined, 'https://proxy.example/');

    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://proxy.example/huggingface');
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it('calls Hugging Face directly (with no Authorization) when the key is blank and no proxy is configured', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(okResponse());
    vi.stubGlobal('fetch', fetchSpy);

    await recognizeWithHuggingFace('data:image/png;base64,ZZZ', '');

    const [url] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('api-inference.huggingface.co');
  });
});
