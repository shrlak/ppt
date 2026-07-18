import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildGeminiBatchBody,
  buildGeminiBody,
  extractGeminiText,
  parseGeminiBatchPayload,
  parseGeminiPayload,
  recognizeBatchWithGemini,
  recognizeWithGemini,
  splitDataUrl,
} from '../../src/lib/ai/scoreAi';

describe('splitDataUrl', () => {
  it('splits mime type and base64 payload', () => {
    expect(splitDataUrl('data:image/jpeg;base64,AAAA')).toEqual({ mimeType: 'image/jpeg', data: 'AAAA' });
  });
});

describe('buildGeminiBody', () => {
  it('embeds the image and uses a strict JSON schema without search', () => {
    const body = buildGeminiBody('data:image/png;base64,ZZZ') as {
      contents: { parts: { text?: string; inline_data?: { mime_type: string; data: string } }[] }[];
      generationConfig: { responseMimeType?: string };
      tools?: unknown;
    };
    const parts = body.contents[0].parts;
    expect(parts.some((p) => p.text?.includes('악보'))).toBe(true);
    expect(parts.some((p) => p.text?.includes('pageType'))).toBe(true);
    expect(parts.some((p) => p.text?.includes('설교 제목과 본문'))).toBe(true);
    // Stacked lines under one staff row number sequentially within ANY part
    // type, not just verses — a chorus repeated twice becomes C, C2.
    expect(parts.some((p) => p.text?.includes('후렴이면 C, C2'))).toBe(true);
    expect(parts.some((p) => p.text?.includes('브릿지면 B, B2'))).toBe(true);
    // A part appearing only once is never forced to a numbered label.
    expect(parts.some((p) => p.text?.includes('번호 없이'))).toBe(true);
    expect(parts.find((p) => p.inline_data)?.inline_data).toEqual({ mime_type: 'image/png', data: 'ZZZ' });
    expect(body.generationConfig.responseMimeType).toBe('application/json');
    expect(body.tools).toBeUndefined();
  });

  it('attaches the google_search tool and drops the schema when cross-checking', () => {
    const body = buildGeminiBody('data:image/jpeg;base64,ZZZ', true) as {
      contents: { parts: { text?: string }[] }[];
      generationConfig: { responseMimeType?: string };
      tools?: { google_search?: unknown }[];
    };
    expect(body.tools?.[0]?.google_search).toBeDefined();
    expect(body.generationConfig.responseMimeType).toBeUndefined();
    expect(body.contents[0].parts.some((p) => p.text?.includes('웹'))).toBe(true);
  });
});

describe('Gemini batch recognition', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('embeds every score image in one request body', () => {
    const body = buildGeminiBatchBody(
      ['data:image/png;base64,FIRST', 'data:image/jpeg;base64,SECOND'],
      'full',
    ) as {
      contents: { parts: { text?: string; inline_data?: { mime_type: string; data: string } }[] }[];
    };
    const images = body.contents[0].parts.filter((part) => part.inline_data).map((part) => part.inline_data);
    expect(images).toEqual([
      { mime_type: 'image/png', data: 'FIRST' },
      { mime_type: 'image/jpeg', data: 'SECOND' },
    ]);
  });

  it('restores an out-of-order response to the input image order', () => {
    const scores = parseGeminiBatchPayload(
      {
        results: [
          { imageIndex: 1, title: '둘째 곡', sections: [] },
          { imageIndex: 0, title: '첫째 곡', sections: [] },
        ],
      },
      2,
      'titles',
    );
    expect(scores.map((score) => score.title)).toEqual(['첫째 곡', '둘째 곡']);
    expect(scores.every((score) => score.sections.length === 0)).toBe(true);
  });

  it('asks the title pass to classify pages before reading song fields', () => {
    const body = buildGeminiBatchBody(['data:image/png;base64,FIRST'], 'titles') as {
      contents: { parts: { text?: string }[] }[];
    };
    const prompt = body.contents[0].parts[0].text ?? '';
    expect(prompt).toContain('pageType');
    expect(prompt).toContain('non_score 페이지에서는 설교 제목과 본문만');
  });

  it('sends multiple score images with one fetch call', async () => {
    const response = {
      candidates: [
        {
          content: {
            parts: [
              {
                text: JSON.stringify({
                  results: [
                    { imageIndex: 0, title: '첫째 곡' },
                    { imageIndex: 1, title: '둘째 곡' },
                  ],
                }),
              },
            ],
          },
        },
      ],
    };
    const fetchSpy = vi.fn().mockResolvedValue(new Response(JSON.stringify(response), { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);

    const scores = await recognizeBatchWithGemini(
      ['data:image/png;base64,FIRST', 'data:image/png;base64,SECOND'],
      'key',
      'gemini-2.5-flash',
      'titles',
    );

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(scores.map((score) => score.title)).toEqual(['첫째 곡', '둘째 곡']);
  });
});

describe('extractGeminiText', () => {
  it('joins candidate text parts', () => {
    const res = { candidates: [{ content: { parts: [{ text: '{"a":' }, { text: '1}' }] } }] };
    expect(extractGeminiText(res)).toBe('{"a":1}');
  });

  it('throws when the prompt was blocked', () => {
    expect(() => extractGeminiText({ promptFeedback: { blockReason: 'SAFETY' } })).toThrow(/SAFETY/);
  });
});

describe('parseGeminiPayload', () => {
  it('maps a well-formed payload into a ParsedScore', () => {
    const parsed = parseGeminiPayload({
      title: '  주님의 사랑  ',
      key: 'E',
      order: ['I', 'V1', 'C', 'C'],
      sections: [
        { label: 'v1', lines: [' 첫째 줄 ', '둘째 줄'] },
        { label: 'C', lines: ['후렴 줄'] },
      ],
    });
    expect(parsed.title).toBe('주님의 사랑');
    expect(parsed.key).toBe('E');
    expect(parsed.order).toEqual(['I', 'V1', 'C', 'C']);
    expect(parsed.sections).toEqual([
      { label: 'V1', lines: ['첫째 줄', '둘째 줄'] },
      { label: 'C', lines: ['후렴 줄'] },
    ]);
  });

  it('tolerates missing/garbled fields', () => {
    const parsed = parseGeminiPayload({ sections: [{ label: '', lines: 'nope' }, { label: 'C' }] });
    expect(parsed.title).toBeUndefined();
    expect(parsed.order).toEqual([]);
    // Empty-label section dropped; the valid one kept with empty lines.
    expect(parsed.sections).toEqual([{ label: 'C', lines: [] }]);
  });

  it('normalizes section labels and strips syllable hyphens from lyrics', () => {
    const parsed = parseGeminiPayload({
      title: 'Celebrate the Light',
      sections: [
        { label: 'Outro', lines: ['라랄랄라'] },
        { label: '후렴', lines: ['Ce-le-brate the light 온 세상 비추네', '찬-양-해'] },
      ],
    });
    // Outro → O, 후렴 → C (canonical tokens the slide planner matches).
    expect(parsed.sections[0].label).toBe('O');
    expect(parsed.sections[1].label).toBe('C');
    expect(parsed.sections[1].lines).toEqual(['Celebrate the light 온 세상 비추네', '찬양해']);
  });
});

describe('recognizeWithGemini', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const okResponse = () =>
    new Response(
      JSON.stringify({ candidates: [{ content: { parts: [{ text: '{"title":"t","sections":[]}' }] } }] }),
      { status: 200 },
    );

  it('calls Google directly with the key in the query string when a key is given', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(okResponse());
    vi.stubGlobal('fetch', fetchSpy);

    await recognizeWithGemini('data:image/png;base64,ZZZ', 'my-key', 'gemini-2.5-flash', false, 'https://proxy.example');

    const [url] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('generativelanguage.googleapis.com');
    expect(url).toContain('key=my-key');
  });

  it('routes through the proxy instead when the key is blank', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(okResponse());
    vi.stubGlobal('fetch', fetchSpy);

    await recognizeWithGemini('data:image/png;base64,ZZZ', '', 'gemini-2.5-flash', false, 'https://proxy.example/');

    const [url] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://proxy.example/gemini/gemini-2.5-flash');
  });

  it('calls Google directly (with an empty key) when the key is blank and no proxy is configured', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(okResponse());
    vi.stubGlobal('fetch', fetchSpy);

    await recognizeWithGemini('data:image/png;base64,ZZZ', '', 'gemini-2.5-flash', false);

    const [url] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('generativelanguage.googleapis.com');
  });
});
