// OpenRouter vision engine for score recognition. This legacy filename is
// retained to avoid a noisy module rename, but every catalog model handled
// here is an OpenRouter :free endpoint (including NVIDIA's Nemotron). Images
// travel as data: URLs in an OpenAI-compatible chat-completions request.
import { RecognitionError } from './recognitionError';
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
  '한 줄의 음표 아래 가사가 여러 줄로 쌓여 있으면 그 파트가 여러 번(절뿐 아니라 후렴·프리코러스·',
  '브릿지·아웃트로 등 어떤 파트든 동일) 반복된다는 뜻입니다.',
  '맨 윗줄부터 차례로 번호를 붙여 나누어 읽으세요: 절이면 V1, V2…, 후렴이면 C1, C2…,',
  '프리코러스면 PC1, PC2…, 브릿지면 B1, B2…, 아웃트로면 O1, O2… 순서로 라벨을 매기세요.',
  '가사는 음절을 나누는 하이픈(-)이나 붙임표 없이 단어를 자연스럽게 이어서 적으세요',
  '(예: "Ce-le-brate" → "Celebrate", "찬-양-해" → "찬양해").',
  '가사에 없는 내용을 지어내지 말고, 확신이 없는 글자도 보이는 대로 최대한 읽으세요.',
  'pageType이 "non_score"이면 title과 key는 빈 문자열, order와 sections는 빈 배열로 반환하세요.',
  'non_score 페이지에서는 다른 안내문을 추측하지 말고 설교 제목과 본문만 옮기세요.',
  '반드시 유효한 JSON 객체 하나만 출력하고, 다른 설명이나 마크다운(```)은 넣지 마세요.',
].join('\n');

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
          'score 페이지에서만 찬양 제목과 조성을 읽으세요.',
          'non_score 페이지에서는 설교 제목과 본문만 읽으세요.',
          '가사, 파트, 진행 순서는 읽지 마세요.',
          '각 결과는 imageIndex, pageType, sermonTitle, scripture, title, key를 포함하세요.',
        ]
      : [
          '각 이미지를 score 또는 non_score로 먼저 분류하세요.',
          'score 페이지에서만 제목, 조성, 진행 순서와 모든 가사를 읽으세요.',
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
