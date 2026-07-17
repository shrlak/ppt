// Gemini Flash vision engine for turning a scanned 악보 image into a structured
// draft song. Called directly from the browser with the user's own free Google
// AI Studio key (no backend, no SDK — a plain fetch to the REST endpoint, which
// avoids the CORS-preflight issues the js-genai SDK hits in browsers).
import { RecognitionError } from './recognitionError';
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

const BASE_PROMPT = [
  '이 이미지는 한국어 찬양 콘티 PDF의 한 페이지이며, 악보가 아닐 수도 있습니다.',
  '먼저 오선과 음표가 실제로 보이는지 확인해 페이지 종류를 분류하세요.',
  '다음을 읽어 JSON으로만 답하세요:',
  '- pageType: 오선과 음표가 있는 악보 페이지면 "score", 아니면 "non_score".',
  '- sermonTitle: non_score 페이지에 명시된 설교 제목. 없으면 빈 문자열.',
  '- scripture: non_score 페이지에 명시된 본문 성경 구절/범위. 없으면 빈 문자열.',
  'pageType이 "score"일 때만 아래 찬양 필드를 읽으세요:',
  '- title: 곡 제목',
  '- key: 조성(예: E, F, F#m). 안 보이면 빈 문자열.',
  '- order: 악보 맨 위의 진행 순서. 보통 I(간주)로 시작합니다. 예: ["I","V1","V2","PC","C","C"]. 없으면 빈 배열.',
  '- sections: 가사를 파트별로 나눈 배열. 각 원소는 {label, lines}.',
  '  label은 V1, V2(절), PC(프리코러스), C, C2(후렴), B(브릿지), O(아웃트로) 등입니다.',
  '  lines는 그 파트의 가사를 한 줄씩 담은 문자열 배열입니다.',
  '악보에 보이는 가사를 빠짐없이 모두 읽으세요. 도돌이표와 1., 2. 괄호(볼타) 안의 가사도 포함하세요.',
  '악보의 코드 기호(C, G, Am7, G/B 등)와 반복 기호는 가사가 아닙니다. lines에 절대 포함하지 마세요.',
  '한 줄의 음표 아래 가사가 여러 줄로 쌓여 있으면 여러 절이라는 뜻입니다.',
  '맨 윗줄부터 차례로 V1, V2… 절로 나누어 읽으세요.',
  '가사는 음절을 나누는 하이픈(-)이나 붙임표 없이 단어를 자연스럽게 이어서 적으세요',
  '(예: "Ce-le-brate" → "Celebrate", "찬-양-해" → "찬양해").',
  '가사에 없는 내용을 지어내지 말고, 확신이 없는 글자도 보이는 대로 최대한 읽으세요.',
  'pageType이 "non_score"이면 title과 key는 빈 문자열, order와 sections는 빈 배열로 반환하세요.',
  'non_score 페이지에서는 다른 안내문을 추측하지 말고 설교 제목과 본문만 옮기세요.',
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
    pageType: { type: 'string', enum: ['score', 'non_score'] },
    sermonTitle: { type: 'string' },
    scripture: { type: 'string' },
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
  required: ['pageType', 'sermonTitle', 'scripture', 'title', 'sections'],
};

const BATCH_TITLE_ITEM_SCHEMA = {
  type: 'object',
  properties: {
    imageIndex: { type: 'integer' },
    pageType: { type: 'string', enum: ['score', 'non_score'] },
    sermonTitle: { type: 'string' },
    scripture: { type: 'string' },
    title: { type: 'string' },
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
    key: { type: 'string' },
    order: { type: 'array', items: { type: 'string' } },
    sections: RESPONSE_SCHEMA.properties.sections,
  },
  required: ['imageIndex', 'pageType', 'sermonTitle', 'scripture', 'title', 'order', 'sections'],
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
): unknown {
  const task =
    mode === 'titles'
      ? [
          '각 이미지에서 먼저 오선과 음표의 존재를 확인해 pageType을 score 또는 non_score로 분류하세요.',
          'score 페이지에서만 찬양 제목과 조성을 읽으세요.',
          'non_score 페이지에서는 설교 제목과 본문만 읽으세요.',
          '가사, 파트, 진행 순서는 인식하지 마세요.',
          'results 배열의 각 항목은 imageIndex, pageType, sermonTitle, scripture, title, key를 포함하세요.',
        ]
      : [
          '각 이미지를 score 또는 non_score로 먼저 분류하세요.',
          'score 페이지에서만 제목, 조성, 진행 순서와 모든 가사를 읽으세요.',
          'non_score 페이지에서는 설교 제목과 본문만 읽고 찬양 필드는 비우세요.',
          'results 배열의 각 항목은 imageIndex, pageType, sermonTitle, scripture, title, key, order, sections를 포함하세요.',
          ...BASE_PROMPT,
        ];
  const hasHints = (hints ?? []).some((hint) => hint && hint.trim());
  const prompt = [
    `아래에는 서로 다른 한국어 찬양 콘티 PDF 페이지 이미지 ${dataUrls.length}개가 있습니다.`,
    '각 이미지 바로 앞의 imageIndex 번호를 결과에 그대로 사용하세요.',
    ...(hasHints
      ? ['일부 이미지 앞에는 콘티 표지에서 읽은 제목 힌트가 있습니다. 힌트는 참고만 하고, 악보와 다르면 악보를 따르세요.']
      : []),
    ...task,
    ...(mode === 'full' && useSearch ? SEARCH_PROMPT : ['반드시 유효한 JSON 객체 하나만 출력하세요.']),
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
): Promise<ParsedScore[]> {
  if (dataUrls.length === 0) return [];
  const useProxy = !apiKey.trim() && !!proxyUrl;
  const url = useProxy
    ? `${trimTrailingSlash(proxyUrl!)}/gemini/${encodeURIComponent(model)}`
    : `${ENDPOINT}/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(buildGeminiBatchBody(dataUrls, mode, useSearch, hints)),
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
