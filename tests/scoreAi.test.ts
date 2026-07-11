import { describe, expect, it } from 'vitest';
import {
  buildGeminiBody,
  extractGeminiText,
  parseGeminiPayload,
  splitDataUrl,
} from '../src/lib/scoreAi';

describe('splitDataUrl', () => {
  it('splits mime type and base64 payload', () => {
    expect(splitDataUrl('data:image/jpeg;base64,AAAA')).toEqual({ mimeType: 'image/jpeg', data: 'AAAA' });
  });
});

describe('buildGeminiBody', () => {
  it('embeds the image as inline_data with the right mime type', () => {
    const body = buildGeminiBody('data:image/png;base64,ZZZ') as {
      contents: { parts: { text?: string; inline_data?: { mime_type: string; data: string } }[] }[];
      generationConfig: { responseMimeType: string };
    };
    const parts = body.contents[0].parts;
    expect(parts.some((p) => p.text?.includes('악보'))).toBe(true);
    expect(parts.find((p) => p.inline_data)?.inline_data).toEqual({ mime_type: 'image/png', data: 'ZZZ' });
    expect(body.generationConfig.responseMimeType).toBe('application/json');
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
});
