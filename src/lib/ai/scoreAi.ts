// Gemini Flash vision engine for turning a scanned 악보 image into a structured
// draft song. Called directly from the browser with the user's own free Google
// AI Studio key (no backend, no SDK — a plain fetch to the REST endpoint, which
// avoids the CORS-preflight issues the js-genai SDK hits in browsers).
import { RecognitionError } from './recognitionError';
import { BASE_PROMPT_LINES, SEARCH_PROMPT_LINES, correctionExampleLines } from './scorePrompt';
import type { PromptExample } from './scoreNvidia';
import {
  coerceParsedScore,
  coerceParsedScoreBatch,
  parseModelJson,
  type BatchRecognitionMode,
  type ParsedScore,
} from './scoreParser';

export type { BatchRecognitionMode };

const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';

/** Strip a trailing slash so callers can pass either form of a base URL. */
function trimTrailingSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}

/** JSON Schema handed to Gemini so it returns strictly-shaped output. */
const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    pageType: { type: 'string', enum: ['score', 'non_score'] },
    sermonTitle: { type: 'string' },
    scripture: { type: 'string' },
    title: { type: 'string' },
    artist: { type: 'string' },
    key: { type: 'string' },
    order: { type: 'array', items: { type: 'string' } },
    lyricRowCount: { type: 'integer' },
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
  required: ['pageType', 'sermonTitle', 'scripture', 'title', 'lyricRowCount', 'sections'],
};

const BATCH_TITLE_ITEM_SCHEMA = {
  type: 'object',
  properties: {
    imageIndex: { type: 'integer' },
    pageType: { type: 'string', enum: ['score', 'non_score'] },
    sermonTitle: { type: 'string' },
    scripture: { type: 'string' },
    title: { type: 'string' },
    artist: { type: 'string' },
    key: { type: 'string' },
  },
  required: ['imageIndex', 'pageType', 'sermonTitle', 'scripture', 'title'],
};

const BATCH_FULL_ITEM_SCHEMA = {
  type: 'object',
  properties: {
    imageIndex: { type: 'integer' },
    pageType: { type: 'string', enum: ['score', 'non_score'] },
    sermonTitle: { type: 'string' },
    scripture: { type: 'string' },
    title: { type: 'string' },
    artist: { type: 'string' },
    key: { type: 'string' },
    order: { type: 'array', items: { type: 'string' } },
    lyricRowCount: { type: 'integer' },
    sections: RESPONSE_SCHEMA.properties.sections,
  },
  required: ['imageIndex', 'pageType', 'sermonTitle', 'scripture', 'title', 'order', 'lyricRowCount', 'sections'],
};

function batchResponseSchema(mode: BatchRecognitionMode): unknown {
  return {
    type: 'object',
    properties: {
      results: { type: 'array', items: mode === 'titles' ? BATCH_TITLE_ITEM_SCHEMA : BATCH_FULL_ITEM_SCHEMA },
    },
    required: ['results'],
  };
}

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
  const prompt = (useSearch ? [...BASE_PROMPT_LINES, ...SEARCH_PROMPT_LINES] : BASE_PROMPT_LINES).join('\n');
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

/**
 * Build one Gemini request for every pending score page. The title pass is
 * intentionally title-only: it lets the caller resolve saved library songs
 * before spending a second model pass on lyrics. The full pass returns every
 * remaining song in the same response instead of issuing one request per page.
 */
export function buildGeminiBatchBody(
  dataUrls: string[],
  mode: BatchRecognitionMode,
  useSearch = false,
  hints?: (string | undefined)[],
  examples: PromptExample[] = [],
): unknown {
  const task =
    mode === 'titles'
      ? [
          '각 이미지에서 먼저 오선과 음표의 존재를 확인해 pageType을 score 또는 non_score로 분류하세요.',
          'score 페이지에서만 찬양 제목과 조성을 읽으세요.',
          'non_score 페이지에서는 설교 제목과 본문만 읽으세요.',
          '가사, 파트, 진행 순서는 인식하지 마세요.',
          'results 배열의 각 항목은 imageIndex, pageType, sermonTitle, scripture, title, artist, key를 포함하세요.',
        ]
      : [
          '각 이미지를 score 또는 non_score로 먼저 분류하세요.',
          'score 페이지에서만 제목, 조성, 진행 순서와 모든 가사를 읽으세요.',
          'non_score 페이지에서는 설교 제목과 본문만 읽고 찬양 필드는 비우세요.',
          'results 배열의 각 항목은 imageIndex, pageType, sermonTitle, scripture, title, artist, key, order, lyricRowCount, sections를 포함하세요.',
          ...BASE_PROMPT_LINES,
        ];
  const hasHints = (hints ?? []).some((hint) => hint && hint.trim());
  const prompt = [
    `아래에는 서로 다른 한국어 찬양 콘티 PDF 페이지 이미지 ${dataUrls.length}개가 있습니다.`,
    '각 이미지 바로 앞의 imageIndex 번호를 결과에 그대로 사용하세요.',
    ...(hasHints
      ? ['일부 이미지 앞에는 콘티 표지에서 읽은 제목 힌트가 있습니다. 힌트는 참고만 하고, 악보와 다르면 악보를 따르세요.']
      : []),
    ...task,
    ...correctionExampleLines(examples),
    ...(mode === 'full' && useSearch ? SEARCH_PROMPT_LINES : ['반드시 유효한 JSON 객체 하나만 출력하세요.']),
  ].join('\n');

  const parts: Record<string, unknown>[] = [{ text: prompt }];
  dataUrls.forEach((dataUrl, imageIndex) => {
    const { mimeType, data } = splitDataUrl(dataUrl);
    const hint = hints?.[imageIndex]?.trim();
    parts.push({ text: `imageIndex: ${imageIndex}${hint ? ` (제목 힌트: ${hint})` : ''}` });
    parts.push({ inline_data: { mime_type: mimeType, data } });
  });

  const body: Record<string, unknown> = {
    contents: [{ role: 'user', parts }],
  };
  if (mode === 'full' && useSearch) {
    body.tools = [{ google_search: {} }];
    body.generationConfig = { temperature: 0 };
  } else {
    body.generationConfig = {
      temperature: 0,
      responseMimeType: 'application/json',
      responseSchema: batchResponseSchema(mode),
    };
  }
  return body;
}

/** Coerce Gemini's parsed JSON payload into a ParsedScore, defensively. */
export function parseGeminiPayload(payload: unknown): ParsedScore {
  return coerceParsedScore(payload);
}

/** Normalize a possibly sparse/out-of-order batch response back to image order. */
export function parseGeminiBatchPayload(
  payload: unknown,
  imageCount: number,
  mode: BatchRecognitionMode,
): ParsedScore[] {
  return coerceParsedScoreBatch(payload, imageCount, mode);
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

/**
 * Recognize a single score image with Gemini. Throws with a readable message on failure.
 *
 * When `apiKey` is blank and `proxyUrl` is supplied, the request goes through a
 * shared server-side proxy (see worker/) that holds its own Gemini key instead
 * of calling Google directly — this lets recognition work for people who
 * haven't set up their own free key.
 */
export async function recognizeWithGemini(
  dataUrl: string,
  apiKey: string,
  model: string,
  useSearch = false,
  proxyUrl?: string,
): Promise<ParsedScore> {
  const useProxy = !apiKey.trim() && !!proxyUrl;
  const url = useProxy
    ? `${trimTrailingSlash(proxyUrl!)}/gemini/${encodeURIComponent(model)}`
    : `${ENDPOINT}/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
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
    throw new RecognitionError(`Gemini 호출 실패: ${detail}`, res.status);
  }

  const json = (await res.json()) as unknown;
  const payload = parseModelJson(
    extractGeminiText(json),
    'Gemini 응답이 비어 있습니다.',
    'Gemini 응답을 JSON으로 해석하지 못했습니다.',
  );
  return coerceParsedScore(payload);
}

/** Recognize all supplied score images in one Gemini request. */
export async function recognizeBatchWithGemini(
  dataUrls: string[],
  apiKey: string,
  model: string,
  mode: BatchRecognitionMode,
  useSearch = false,
  proxyUrl?: string,
  hints?: (string | undefined)[],
  examples: PromptExample[] = [],
): Promise<ParsedScore[]> {
  if (dataUrls.length === 0) return [];
  const useProxy = !apiKey.trim() && !!proxyUrl;
  const url = useProxy
    ? `${trimTrailingSlash(proxyUrl!)}/gemini/${encodeURIComponent(model)}`
    : `${ENDPOINT}/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(buildGeminiBatchBody(dataUrls, mode, useSearch, hints, examples)),
  });

  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const err = (await res.json()) as { error?: { message?: string } };
      if (err?.error?.message) detail = err.error.message;
    } catch {
      // Keep the status code when the error body is not JSON.
    }
    throw new RecognitionError(`Gemini 일괄 호출 실패: ${detail}`, res.status);
  }

  const payload = parseModelJson(
    extractGeminiText((await res.json()) as unknown),
    'Gemini 일괄 응답이 비어 있습니다.',
    'Gemini 일괄 응답을 JSON으로 해석하지 못했습니다.',
  );
  return coerceParsedScoreBatch(payload, dataUrls.length, mode);
}
