// Gemini Flash vision engine for turning a scanned 악보 image into a structured
// draft song. Called directly from the browser with the user's own free Google
// AI Studio key (no backend, no SDK — a plain fetch to the REST endpoint, which
// avoids the CORS-preflight issues the js-genai SDK hits in browsers).
import type { Section } from './types';
import { normalizeToken, parseOrder } from './orderParser';
import { cleanLyricLine, type ParsedScore } from './scoreParser';

const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';

const BASE_PROMPT = [
  '이 이미지는 한국어 찬양(worship) 악보 한 페이지입니다.',
  '다음을 읽어 JSON으로만 답하세요:',
  '- title: 곡 제목',
  '- key: 조성(예: E, F, F#m). 안 보이면 빈 문자열.',
  '- order: 악보 맨 위의 진행 순서. 보통 I(간주)로 시작합니다. 예: ["I","V1","V2","PC","C","C"]. 없으면 빈 배열.',
  '- sections: 가사를 파트별로 나눈 배열. 각 원소는 {label, lines}.',
  '  label은 V1, V2(절), PC(프리코러스), C, C2(후렴), B(브릿지), O(아웃트로) 등입니다.',
  '  lines는 그 파트의 가사를 한 줄씩 담은 문자열 배열입니다.',
  '가사는 음절을 나누는 하이픈(-)이나 붙임표 없이 단어를 자연스럽게 이어서 적으세요',
  '(예: "Ce-le-brate" → "Celebrate", "찬-양-해" → "찬양해").',
  '가사에 없는 내용을 지어내지 마세요.',
];

/**
 * Extra instructions when Google Search grounding is enabled. The web is used
 * ONLY to fix spacing/spelling and to join the note-split syllables correctly —
 * NOT to change the actual words. The lyric content must stay faithful to the
 * score even if a web version words it differently.
 */
const SEARCH_PROMPT = [
  '가사의 단어와 내용은 반드시 악보(이미지)에 적힌 그대로 옮기세요.',
  '웹 검색 결과로 단어·표현·가사 내용을 바꾸지 마세요. 웹 버전이 달라도 악보를 따릅니다.',
  '웹 검색은 오직 다음 두 가지에만 사용하세요:',
  '(1) 음표에 맞춰 하이픈(-)으로 쪼개진 음절을 올바른 단어 경계로 이어 붙이기,',
  '(2) 띄어쓰기와 맞춤법(문법)을 바로잡기.',
  '즉, 내용은 악보를 그대로 따르고 표기(띄어쓰기·맞춤법·하이픈 정리)만 웹 기준으로 다듬습니다.',
  '반드시 유효한 JSON 객체 하나만 출력하고, 다른 설명이나 마크다운(```)은 넣지 마세요.',
];

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

/**
 * Build the generateContent request body for one score image. With `useSearch`,
 * the Google Search grounding tool is attached so Gemini can cross-check the
 * lyrics online; grounding can't be combined with a strict response schema, so
 * in that mode the prompt asks for JSON-only and the caller salvages it.
 */
export function buildGeminiBody(dataUrl: string, useSearch = false): unknown {
  const { mimeType, data } = splitDataUrl(dataUrl);
  const prompt = (useSearch ? [...BASE_PROMPT, ...SEARCH_PROMPT] : BASE_PROMPT).join('\n');
  const body: Record<string, unknown> = {
    contents: [
      {
        role: 'user',
        parts: [{ text: prompt }, { inline_data: { mime_type: mimeType, data } }],
      },
    ],
  };
  if (useSearch) {
    body.tools = [{ google_search: {} }];
    body.generationConfig = { temperature: 0 };
  } else {
    body.generationConfig = {
      temperature: 0,
      responseMimeType: 'application/json',
      responseSchema: RESPONSE_SCHEMA,
    };
  }
  return body;
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
    // Normalize the label to a canonical token (후렴→C, Outro→O, …) so it lines
    // up with the order tokens the slide planner matches against.
    const label = typeof s?.label === 'string' ? normalizeToken(s.label) : '';
    if (!label) continue;
    const lines = Array.isArray(s?.lines)
      ? s.lines
          .filter((l): l is string => typeof l === 'string')
          .map((l) => cleanLyricLine(l))
          .filter((l) => l.length > 0)
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
  useSearch = false,
): Promise<ParsedScore> {
  const url = `${ENDPOINT}/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(buildGeminiBody(dataUrl, useSearch)),
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
