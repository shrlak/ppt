// OpenRouter vision engine for score recognition. This legacy filename is
// retained to avoid a noisy module rename, but every catalog model handled
// here is an OpenRouter :free endpoint (including NVIDIA's Nemotron). Images
// travel as data: URLs in an OpenAI-compatible chat-completions request.
import { RecognitionError } from './recognitionError';
import { basePrompt } from './scorePrompt';
import {
  coerceParsedScore,
  coerceParsedScoreBatch,
  parseModelJson,
  type BatchRecognitionMode,
  type ParsedScore,
} from './scoreParser';

const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';

/**
 * Default catalog model. Nemotron Nano 12B v2 VL is NVIDIA's document/OCR
 * vision model and is served here through OpenRouter's free endpoint.
 */
export const DEFAULT_NVIDIA_MODEL = 'nvidia/nemotron-nano-12b-v2-vl';

/** Strip a trailing slash so callers can pass either form of a base URL. */
function trimTrailingSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}

const BASE_PROMPT = basePrompt(
  '반드시 유효한 JSON 객체 하나만 출력하고, 다른 설명이나 마크다운(```)은 넣지 마세요.',
);

/** Ensure the image is a data: URL, as the chat-completions API expects. */
export function toImageDataUrl(image: string): string {
  return image.startsWith('data:') ? image : `data:image/jpeg;base64,${image}`;
}

/** Build the OpenAI-style request body for one score image. */
export function buildNvidiaBody(dataUrl: string, model: string = DEFAULT_NVIDIA_MODEL): unknown {
  return {
    model,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: BASE_PROMPT },
          { type: 'image_url', image_url: { url: toImageDataUrl(dataUrl) } },
        ],
      },
    ],
    temperature: 0,
    max_tokens: 2048,
  };
}

function batchPrompt(imageCount: number, mode: BatchRecognitionMode, hasHints: boolean): string {
  const task =
    mode === 'titles'
      ? [
          '각 이미지에서 먼저 오선과 음표의 존재를 확인해 pageType을 score 또는 non_score로 분류하세요.',
          'score 페이지에서만 찬양 제목과 조성을 읽고, 아티스트 이름이 인쇄되어 있으면 함께 읽으세요.',
          'non_score 페이지에서는 설교 제목과 본문만 읽으세요.',
          '가사, 파트, 진행 순서는 읽지 마세요.',
          '각 결과는 imageIndex, pageType, sermonTitle, scripture, title, artist, key를 포함하세요.',
          'artist는 페이지에 인쇄된 이름만 적고, 없으면 빈 문자열로 두세요. 제목으로 추측하지 마세요.',
        ]
      : [
          '각 이미지를 score 또는 non_score로 먼저 분류하세요.',
          'score 페이지에서만 제목, 아티스트, 조성, 진행 순서와 모든 가사를 읽으세요.',
          'non_score 페이지에서는 설교 제목과 본문만 읽고 찬양 필드는 비우세요.',
          BASE_PROMPT,
        ];
  return [
    `서로 다른 한국어 찬양 콘티 PDF 페이지 이미지 ${imageCount}개가 입력됩니다.`,
    '각 이미지 앞의 imageIndex를 결과에 그대로 사용하세요.',
    ...(hasHints
      ? ['일부 이미지 앞에는 콘티 표지에서 읽은 제목 힌트가 있습니다. 힌트는 참고만 하고, 악보와 다르면 악보를 따르세요.']
      : []),
    ...task,
    '반드시 {"results":[...]} 형태의 JSON 객체 하나만 출력하세요.',
  ].join('\n');
}

/** Build one request covering every pending score page. */
export function buildNvidiaBatchBody(
  dataUrls: string[],
  mode: BatchRecognitionMode,
  model: string = DEFAULT_NVIDIA_MODEL,
  hints?: (string | undefined)[],
): unknown {
  const hasHints = (hints ?? []).some((hint) => hint && hint.trim());
  const content: Record<string, unknown>[] = [
    { type: 'text', text: batchPrompt(dataUrls.length, mode, hasHints) },
  ];
  dataUrls.forEach((dataUrl, imageIndex) => {
    const hint = hints?.[imageIndex]?.trim();
    content.push({ type: 'text', text: `imageIndex: ${imageIndex}${hint ? ` (제목 힌트: ${hint})` : ''}` });
    content.push({ type: 'image_url', image_url: { url: toImageDataUrl(dataUrl) } });
  });
  return {
    model,
    messages: [{ role: 'user', content }],
    temperature: 0,
    max_tokens: 4096,
  };
}

/** Pull the assistant's text out of a chat-completions response. */
export function extractNvidiaText(response: unknown): string {
  const r = response as { choices?: { message?: { content?: unknown } }[] };
  const content = r?.choices?.[0]?.message?.content;
  if (typeof content === 'string') return content;
  // Some models answer with structured content parts instead of a string.
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof (part as { text?: unknown })?.text === 'string' ? (part as { text: string }).text : ''))
      .join('');
  }
  return '';
}

async function callOpenRouter(body: unknown, apiKey: string, proxyUrl?: string): Promise<string> {
  const useProxy = !apiKey.trim() && !!proxyUrl;
  const url = useProxy ? `${trimTrailingSlash(proxyUrl!)}/openrouter` : ENDPOINT;
  const requestBody =
    !useProxy &&
    body &&
    typeof body === 'object' &&
    (body as { model?: unknown }).model === DEFAULT_NVIDIA_MODEL
      ? { ...(body as Record<string, unknown>), model: `${DEFAULT_NVIDIA_MODEL}:free` }
      : body;
  const res = await fetch(url, {
    method: 'POST',
    headers: useProxy
      ? { 'Content-Type': 'application/json' }
      : { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(requestBody),
  });

  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const err = (await res.json()) as { error?: { message?: string } | string; detail?: string };
      if (typeof err?.error === 'string') detail = err.error;
      else if (err?.error?.message) detail = err.error.message;
      else if (typeof err?.detail === 'string') detail = err.detail;
    } catch {
      // ignore body parse errors; keep the status code
    }
    throw new RecognitionError(`OpenRouter 호출 실패: ${detail}`, res.status);
  }

  return extractNvidiaText((await res.json()) as unknown);
}

/**
 * Recognize a single score image with an OpenRouter-hosted free vision model.
 *
 * When `apiKey` is blank and `proxyUrl` is supplied, the request goes through
 * the shared Cloudflare proxy (see worker/) that holds the OpenRouter key.
 */
export async function recognizeWithNvidia(
  dataUrl: string,
  apiKey: string,
  model: string = DEFAULT_NVIDIA_MODEL,
  proxyUrl?: string,
): Promise<ParsedScore> {
  const text = await callOpenRouter(buildNvidiaBody(dataUrl, model), apiKey, proxyUrl);
  const payload = parseModelJson(
    text,
    'OpenRouter 응답이 비어 있습니다.',
    'OpenRouter 응답을 JSON으로 해석하지 못했습니다.',
  );
  return coerceParsedScore(payload);
}

/** Recognize every supplied score image in one OpenRouter request. */
export async function recognizeBatchWithNvidia(
  dataUrls: string[],
  apiKey: string,
  mode: BatchRecognitionMode,
  model: string = DEFAULT_NVIDIA_MODEL,
  proxyUrl?: string,
  hints?: (string | undefined)[],
): Promise<ParsedScore[]> {
  if (dataUrls.length === 0) return [];
  const text = await callOpenRouter(buildNvidiaBatchBody(dataUrls, mode, model, hints), apiKey, proxyUrl);
  const payload = parseModelJson(
    text,
    'OpenRouter 일괄 응답이 비어 있습니다.',
    'OpenRouter 일괄 응답을 JSON으로 해석하지 못했습니다.',
  );
  return coerceParsedScoreBatch(payload, dataUrls.length, mode);
}
