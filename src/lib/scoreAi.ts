// Gemini Flash vision engine for turning a scanned 악보 image into a structured
// draft song. Called directly from the browser with the user's own free Google
// AI Studio key (no backend, no SDK — a plain fetch to the REST endpoint, which
// avoids the CORS-preflight issues the js-genai SDK hits in browsers).
import type { Section } from './types';
import { parseOrder } from './orderParser';
import type { ParsedScore } from './scoreParser';

const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';

const PROMPT = [
  '이 이미지는 한국어 찬양(worship) 악보 한 페이지입니다.',
  '다음을 읽어 JSON으로만 답하세요:',
  '- title: 곡 제목',
  '- key: 조성(예: E, F, F#m). 안 보이면 빈 문자열.',
  '- order: 악보 맨 위의 진행 순서. 보통 I(간주)로 시작합니다. 예: ["I","V1","V2","PC","C","C"]. 없으면 빈 배열.',
  '- sections: 가사를 파트별로 나눈 배열. 각 원소는 {label, lines}.',
  '  label은 V1, V2(절), PC(프리코러스), C, C2(후렴), B(브릿지) 등입니다.',
  '  lines는 그 파트의 가사를 한 줄씩 담은 문자열 배열입니다.',
  '가사에 없는 내용을 지어내지 말고, 악보에 실제로 적힌 가사만 옮기세요.',
].join('\n');

/** JSON Schema handed to Gemini so it returns strictly-shaped output. */
const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    key: { type: 'string' },
    order: { type: 'array', items: { type: 'string' } },
    sections: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          label: { type: 'string' },
          lines: { type: 'array', items: { type: 'string' } },
        },
        required: ['label', 'lines'],
      },
    },
  },
  required: ['title', 'sections'],
};

/** Split a `data:image/...;base64,XXXX` URL into its mime type and payload. */
export function splitDataUrl(dataUrl: string): { mimeType: string; data: string } {
  const match = /^data:([^;]+);base64,(.*)$/s.exec(dataUrl);
  if (!match) return { mimeType: 'image/jpeg', data: dataUrl };
  return { mimeType: match[1], data: match[2] };
}

/** Build the generateContent request body for one score image. */
export function buildGeminiBody(dataUrl: string): unknown {
  const { mimeType, data } = splitDataUrl(dataUrl);
  return {
    contents: [
      {
        role: 'user',
        parts: [{ text: PROMPT }, { inline_data: { mime_type: mimeType, data } }],
      },
    ],
    generationConfig: {
      temperature: 0,
      responseMimeType: 'application/json',
      responseSchema: RESPONSE_SCHEMA,
    },
  };
}

interface GeminiSectionLike {
  label?: unknown;
  lines?: unknown;
}

/** Coerce Gemini's parsed JSON payload into a ParsedScore, defensively. */
export function parseGeminiPayload(payload: unknown): ParsedScore {
  const obj = (payload ?? {}) as Record<string, unknown>;

  const title = typeof obj.title === 'string' && obj.title.trim() ? obj.title.trim() : undefined;
  const key = typeof obj.key === 'string' && obj.key.trim() ? obj.key.trim() : undefined;

  const orderTokens = Array.isArray(obj.order) ? obj.order.filter((t): t is string => typeof t === 'string') : [];
  const order = parseOrder(orderTokens.join('-'));

  const rawSections = Array.isArray(obj.sections) ? (obj.sections as GeminiSectionLike[]) : [];
  const sections: Section[] = [];
  for (const s of rawSections) {
    const label = typeof s?.label === 'string' ? s.label.trim().toUpperCase() : '';
    if (!label) continue;
    const lines = Array.isArray(s?.lines)
      ? s.lines.filter((l): l is string => typeof l === 'string').map((l) => l.trim())
      : [];
    sections.push({ label, lines });
  }

  return { title, key, order, sections };
}

/** Pull the model's text part out of a generateContent response. */
export function extractGeminiText(response: unknown): string {
  const r = response as {
    candidates?: { content?: { parts?: { text?: string }[] } }[];
    promptFeedback?: { blockReason?: string };
  };
  if (r?.promptFeedback?.blockReason) {
    throw new Error(`Gemini이 요청을 차단했습니다 (${r.promptFeedback.blockReason}).`);
  }
  const parts = r?.candidates?.[0]?.content?.parts ?? [];
  return parts.map((p) => p?.text ?? '').join('');
}

/** Recognize a single score image with Gemini. Throws with a readable message on failure. */
export async function recognizeWithGemini(
  dataUrl: string,
  apiKey: string,
  model: string,
): Promise<ParsedScore> {
  const url = `${ENDPOINT}/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(buildGeminiBody(dataUrl)),
  });

  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const err = (await res.json()) as { error?: { message?: string } };
      if (err?.error?.message) detail = err.error.message;
    } catch {
      // ignore body parse errors; keep the status code
    }
    throw new Error(`Gemini 호출 실패: ${detail}`);
  }

  const json = (await res.json()) as unknown;
  const text = extractGeminiText(json).trim();
  if (!text) throw new Error('Gemini 응답이 비어 있습니다.');

  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    // Model occasionally wraps JSON in prose or code fences — salvage the object.
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start === -1 || end <= start) throw new Error('Gemini 응답을 JSON으로 해석하지 못했습니다.');
    payload = JSON.parse(text.slice(start, end + 1));
  }

  return parseGeminiPayload(payload);
}
