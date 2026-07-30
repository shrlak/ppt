// Hugging Face Inference API for score recognition fallback.
// Uses open-source vision models to extract title, key, order, and lyrics from sheet music.
import { RecognitionError } from './recognitionError';
import { basePrompt } from './scorePrompt';
import {
  coerceParsedScore,
  coerceParsedScoreBatch,
  parseModelJson,
  type BatchRecognitionMode,
  type ParsedScore,
} from './scoreParser';

const ENDPOINT = 'https://api-inference.huggingface.co/models';

// Using Qwen's VL model which has good vision understanding for structured data extraction
const DEFAULT_MODEL = 'Qwen/Qwen2-VL-7B-Instruct';

/** Strip a trailing slash so callers can pass either form of a base URL. */
function trimTrailingSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}

const BASE_PROMPT = basePrompt(
  '반드시 유효한 JSON 객체 하나만 출력하고, 다른 설명은 넣지 마세요.',
);

export function parseHuggingFacePayload(payload: unknown): ParsedScore {
  return coerceParsedScore(payload);
}

export function extractImageBase64(dataUrl: string): string {
  const match = /^data:([^;]+);base64,(.*)$/s.exec(dataUrl);
  if (!match) return dataUrl;
  return match[2];
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

export function buildHuggingFaceBatchPayload(
  dataUrls: string[],
  mode: BatchRecognitionMode,
  hints?: (string | undefined)[],
): unknown {
  const hasHints = (hints ?? []).some((hint) => hint && hint.trim());
  const content: Record<string, unknown>[] = [
    { type: 'text', text: batchPrompt(dataUrls.length, mode, hasHints) },
  ];
  dataUrls.forEach((dataUrl, imageIndex) => {
    const hint = hints?.[imageIndex]?.trim();
    content.push({ type: 'text', text: `imageIndex: ${imageIndex}${hint ? ` (제목 힌트: ${hint})` : ''}` });
    content.push({ type: 'image', image: extractImageBase64(dataUrl) });
  });
  return { inputs: [{ role: 'user', content }] };
}

export function parseHuggingFaceBatchPayload(
  payload: unknown,
  imageCount: number,
  mode: BatchRecognitionMode,
): ParsedScore[] {
  return coerceParsedScoreBatch(payload, imageCount, mode);
}

function generatedText(response: unknown): string {
  if (Array.isArray(response)) {
    const first = response[0] as Record<string, unknown> | undefined;
    return typeof first?.generated_text === 'string' ? first.generated_text : '';
  }
  if (typeof response === 'object' && response !== null) {
    const obj = response as Record<string, unknown>;
    return typeof obj.generated_text === 'string' ? obj.generated_text : '';
  }
  return '';
}

function parseGeneratedJson(text: string, emptyMessage: string): unknown {
  return parseModelJson(text, emptyMessage, 'Hugging Face 응답을 JSON으로 해석하지 못했습니다.');
}

/**
 * When `apiKey` is blank and `proxyUrl` is supplied, the request goes through a
 * shared server-side proxy (see worker/) that holds its own Hugging Face key
 * instead of calling Hugging Face directly — this lets recognition work for
 * people who haven't set up their own free key.
 */
export async function recognizeWithHuggingFace(
  dataUrl: string,
  apiKey: string,
  model: string = DEFAULT_MODEL,
  proxyUrl?: string,
): Promise<ParsedScore> {
  const base64 = extractImageBase64(dataUrl);
  const useProxy = !apiKey.trim() && !!proxyUrl;
  const url = useProxy ? `${trimTrailingSlash(proxyUrl!)}/huggingface` : `${ENDPOINT}/${encodeURIComponent(model)}`;

  // Hugging Face Inference API accepts images as base64 in the payload
  const res = await fetch(url, {
    method: 'POST',
    headers: useProxy
      ? { 'Content-Type': 'application/json' }
      : { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      inputs: [
        {
          role: 'user',
          content: [
            { type: 'image', image: base64 },
            { type: 'text', text: BASE_PROMPT },
          ],
        },
      ],
    }),
  });

  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const err = (await res.json()) as { error?: string };
      if (err?.error) detail = err.error;
    } catch {
      // ignore body parse errors; keep the status code
    }
    throw new RecognitionError(`Hugging Face 호출 실패: ${detail}`, res.status);
  }

  const json = (await res.json()) as unknown;

  return parseHuggingFacePayload(parseGeneratedJson(generatedText(json), 'Hugging Face 응답이 비어 있습니다.'));
}

/** Recognize every supplied score image in one Hugging Face request. */
export async function recognizeBatchWithHuggingFace(
  dataUrls: string[],
  apiKey: string,
  mode: BatchRecognitionMode,
  model: string = DEFAULT_MODEL,
  proxyUrl?: string,
  hints?: (string | undefined)[],
): Promise<ParsedScore[]> {
  if (dataUrls.length === 0) return [];
  const useProxy = !apiKey.trim() && !!proxyUrl;
  const url = useProxy ? `${trimTrailingSlash(proxyUrl!)}/huggingface` : `${ENDPOINT}/${encodeURIComponent(model)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: useProxy
      ? { 'Content-Type': 'application/json' }
      : { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(buildHuggingFaceBatchPayload(dataUrls, mode, hints)),
  });

  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const err = (await res.json()) as { error?: string };
      if (err?.error) detail = err.error;
    } catch {
      // Keep the status code when the error body is not JSON.
    }
    throw new RecognitionError(`Hugging Face 일괄 호출 실패: ${detail}`, res.status);
  }

  const json = (await res.json()) as unknown;
  const payload = parseGeneratedJson(generatedText(json), 'Hugging Face 일괄 응답이 비어 있습니다.');
  return parseHuggingFaceBatchPayload(payload, dataUrls.length, mode);
}
