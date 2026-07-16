import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_NVIDIA_MODEL,
  buildNvidiaBatchBody,
  buildNvidiaBody,
  extractNvidiaText,
  recognizeBatchWithNvidia,
  recognizeWithNvidia,
  toImageDataUrl,
} from '../../src/lib/ai/scoreNvidia';
import { RecognitionError } from '../../src/lib/ai/recognitionError';

const DATA_URL = 'data:image/jpeg;base64,QUJD';

function chatResponse(content: string): unknown {
  return { choices: [{ message: { role: 'assistant', content } }] };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('toImageDataUrl', () => {
  it('keeps a data: URL as-is and wraps bare base64', () => {
    expect(toImageDataUrl(DATA_URL)).toBe(DATA_URL);
    expect(toImageDataUrl('QUJD')).toBe('data:image/jpeg;base64,QUJD');
  });
});

describe('buildNvidiaBody', () => {
  it('builds an OpenAI-style vision request with the image as a data URL', () => {
    const body = buildNvidiaBody(DATA_URL) as {
      model: string;
      temperature: number;
      messages: { role: string; content: { type: string; image_url?: { url: string }; text?: string }[] }[];
    };
    expect(body.model).toBe(DEFAULT_NVIDIA_MODEL);
    expect(body.temperature).toBe(0);
    expect(body.messages[0].role).toBe('user');
    const imagePart = body.messages[0].content.find((part) => part.type === 'image_url');
    expect(imagePart?.image_url?.url).toBe(DATA_URL);
    const textPart = body.messages[0].content.find((part) => part.type === 'text');
    expect(textPart?.text).toContain('JSON');
  });
});

describe('buildNvidiaBatchBody', () => {
  it('labels every image with its imageIndex', () => {
    const body = buildNvidiaBatchBody([DATA_URL, DATA_URL], 'titles') as {
      messages: { content: { type: string; text?: string }[] }[];
    };
    const texts = body.messages[0].content.filter((part) => part.type === 'text').map((part) => part.text);
    expect(texts.some((text) => text?.includes('imageIndex: 0'))).toBe(true);
    expect(texts.some((text) => text?.includes('imageIndex: 1'))).toBe(true);
    expect(body.messages[0].content.filter((part) => part.type === 'image_url')).toHaveLength(2);
  });
});

describe('extractNvidiaText', () => {
  it('reads a plain string answer', () => {
    expect(extractNvidiaText(chatResponse('{"title":"t"}'))).toBe('{"title":"t"}');
  });

  it('joins structured content parts', () => {
    const response = { choices: [{ message: { content: [{ type: 'text', text: '{"a":' }, { type: 'text', text: '1}' }] } }] };
    expect(extractNvidiaText(response)).toBe('{"a":1}');
  });

  it('returns empty text for malformed responses', () => {
    expect(extractNvidiaText(null)).toBe('');
    expect(extractNvidiaText({})).toBe('');
  });
});

describe('recognizeWithNvidia', () => {
  it('calls the NVIDIA endpoint directly with a bearer key and parses the JSON answer', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify(
          chatResponse(
            JSON.stringify({
              title: '주 은혜임을',
              key: 'G',
              order: ['I', 'V1', 'C'],
              sections: [{ label: 'V1', lines: ['그 사-랑 얼마나'] }],
            }),
          ),
        ),
        { status: 200 },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const score = await recognizeWithNvidia(DATA_URL, 'nv-key');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://integrate.api.nvidia.com/v1/chat/completions');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer nv-key');
    expect(score.title).toBe('주 은혜임을');
    expect(score.order).toEqual(['I', 'V1', 'C']);
    // Note-split hyphens are joined by the shared normalizer.
    expect(score.sections[0].lines).toEqual(['그 사랑 얼마나']);
  });

  it('uses the shared proxy when no key is set', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify(chatResponse('{"title":"t","sections":[]}')), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await recognizeWithNvidia(DATA_URL, '', undefined, 'https://proxy.example/');

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://proxy.example/nvidia');
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it('salvages JSON wrapped in a code fence', async () => {
    const fenced = '```json\n{"title":"t","sections":[{"label":"C","lines":["후렴"]}]}\n```';
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(JSON.stringify(chatResponse(fenced)), { status: 200 })),
    );

    const score = await recognizeWithNvidia(DATA_URL, 'nv-key');
    expect(score.title).toBe('t');
    expect(score.sections[0].lines).toEqual(['후렴']);
  });

  it('throws a RecognitionError carrying the HTTP status on failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { message: 'rate limited' } }), { status: 429 })),
    );

    const failure = recognizeWithNvidia(DATA_URL, 'nv-key');
    await expect(failure).rejects.toThrow('rate limited');
    await expect(recognizeWithNvidia(DATA_URL, 'nv-key')).rejects.toMatchObject({ status: 429 });
    await expect(recognizeWithNvidia(DATA_URL, 'nv-key')).rejects.toBeInstanceOf(RecognitionError);
  });
});

describe('recognizeBatchWithNvidia', () => {
  it('returns scores aligned to image order even when the model answers sparsely', async () => {
    const payload = {
      results: [
        { imageIndex: 1, title: '둘째 곡', key: 'A' },
        { imageIndex: 0, title: '첫째 곡' },
      ],
    };
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(JSON.stringify(chatResponse(JSON.stringify(payload))), { status: 200 })),
    );

    const scores = await recognizeBatchWithNvidia([DATA_URL, DATA_URL, DATA_URL], 'nv-key', 'titles');

    expect(scores).toHaveLength(3);
    expect(scores[0].title).toBe('첫째 곡');
    expect(scores[1].title).toBe('둘째 곡');
    expect(scores[1].key).toBe('A');
    expect(scores[2]).toEqual({ order: [], sections: [] });
  });

  it('returns an empty list without calling fetch for zero images', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(recognizeBatchWithNvidia([], 'nv-key', 'full')).resolves.toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
