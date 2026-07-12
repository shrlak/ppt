import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  extractImageBase64,
  parseHuggingFacePayload,
  recognizeWithHuggingFace,
} from '../src/lib/scoreHuggingFace';

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
