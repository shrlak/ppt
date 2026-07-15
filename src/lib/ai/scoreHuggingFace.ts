// Hugging Face Inference API for score recognition fallback.
// Uses open-source vision models to extract title, key, order, and lyrics from sheet music.
import type { Section } from '../utils/types';
import { normalizeToken, parseOrder } from '../utils/orderParser';
import { cleanLyricLine, type ParsedScore } from './scoreParser';
import type { BatchRecognitionMode } from './scoreAi';

const ENDPOINT = 'https://api-inference.huggingface.co/models';

// Using Qwen's VL model which has good vision understanding for structured data extraction
const DEFAULT_MODEL = 'Qwen/Qwen2-VL-7B-Instruct';

/** Strip a trailing slash so callers can pass either form of a base URL. */
function trimTrailingSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}

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
  '반드시 유효한 JSON 객체 하나만 출력하고, 다른 설명은 넣지 마세요.',
].join('\n');

interface HFSectionLike {
  label?: unknown;
  lines?: unknown;
}

export function parseHuggingFacePayload(payload: unknown): ParsedScore {
  const obj = (payload ?? {}) as Record<string, unknown>;

  const title = typeof obj.title === 'string' && obj.title.trim() ? obj.title.trim() : undefined;
  const key = typeof obj.key === 'string' && obj.key.trim() ? obj.key.trim() : undefined;

  const orderTokens = Array.isArray(obj.order) ? obj.order.filter((t): t is string => typeof t === 'string') : [];
  const order = parseOrder(orderTokens.join('-'));

  const rawSections = Array.isArray(obj.sections) ? (obj.sections as HFSectionLike[]) : [];
  const sections: Section[] = [];
  for (const s of rawSections) {
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

export function extractImageBase64(dataUrl: string): string {
  const match = /^data:([^;]+);base64,(.*)$/s.exec(dataUrl);
  if (!match) return dataUrl;
  return match[2];
}

function batchPrompt(imageCount: number, mode: BatchRecognitionMode): string {
  const task =
    mode === 'titles'
      ? [
          '각 이미지에서 찬양 제목과 조성만 읽으세요.',
          '가사, 파트, 진행 순서는 읽지 마세요.',
          '각 결과는 imageIndex, title, key만 포함하세요.',
        ]
      : [
          '모든 이미지의 제목, 조성, 진행 순서와 가사를 한 번에 읽으세요.',
          BASE_PROMPT,
        ];
  return [
    `서로 다른 한국어 찬양 악보 이미지 ${imageCount}개가 입력됩니다.`,
    '각 이미지 앞의 imageIndex를 결과에 그대로 사용하세요.',
    ...task,
    '반드시 {"results":[...]} 형태의 JSON 객체 하나만 출력하세요.',
  ].join('\n');
}

export function buildHuggingFaceBatchPayload(dataUrls: string[], mode: BatchRecognitionMode): unknown {
  const content: Record<string, unknown>[] = [{ type: 'text', text: batchPrompt(dataUrls.length, mode) }];
  dataUrls.forEach((dataUrl, imageIndex) => {
    content.push({ type: 'text', text: `imageIndex: ${imageIndex}` });
    content.push({ type: 'image', image: extractImageBase64(dataUrl) });
  });
  return { inputs: [{ role: 'user', content }] };
}

export function parseHuggingFaceBatchPayload(
  payload: unknown,
  imageCount: number,
  mode: BatchRecognitionMode,
): ParsedScore[] {
  const obj = (payload ?? {}) as { results?: unknown };
  const raw = Array.isArray(obj.results) ? obj.results : Array.isArray(payload) ? payload : [];
  const results: ParsedScore[] = Array.from({ length: imageCount }, () => ({ order: [], sections: [] }));
  raw.forEach((item, position) => {
    if (!item || typeof item !== 'object') return;
    const record = item as Record<string, unknown>;
    const imageIndex = Number.isInteger(record.imageIndex) ? Number(record.imageIndex) : position;
    if (imageIndex < 0 || imageIndex >= imageCount) return;
    const score = parseHuggingFacePayload(record);
    results[imageIndex] =
      mode === 'titles' ? { title: score.title, key: score.key, order: [], sections: [] } : score;
  });
  return results;
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
  if (!text) throw new Error(emptyMessage);
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start === -1 || end <= start) throw new Error('Hugging Face 응답을 JSON으로 해석하지 못했습니다.');
    return JSON.parse(text.slice(start, end + 1));
  }
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
    throw new Error(`Hugging Face 호출 실패: ${detail}`);
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
): Promise<ParsedScore[]> {
  if (dataUrls.length === 0) return [];
  const useProxy = !apiKey.trim() && !!proxyUrl;
  const url = useProxy ? `${trimTrailingSlash(proxyUrl!)}/huggingface` : `${ENDPOINT}/${encodeURIComponent(model)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: useProxy
      ? { 'Content-Type': 'application/json' }
      : { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(buildHuggingFaceBatchPayload(dataUrls, mode)),
  });

  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const err = (await res.json()) as { error?: string };
      if (err?.error) detail = err.error;
    } catch {
      // Keep the status code when the error body is not JSON.
    }
    throw new Error(`Hugging Face 일괄 호출 실패: ${detail}`);
  }

  const json = (await res.json()) as unknown;
  const payload = parseGeneratedJson(generatedText(json), 'Hugging Face 일괄 응답이 비어 있습니다.');
  return parseHuggingFaceBatchPayload(payload, dataUrls.length, mode);
}
