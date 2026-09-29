// Ask Gemini for the English under each Korean slide — the "AI로 채우기"
// button on a song the library has never seen.
//
// Most songs on a Korean praise-night conti are translations of English
// worship songs, so the useful answer is the ORIGINAL English lines that match
// each Korean slide, not a fresh translation; Google Search grounding lets the
// model look the original up. Songs written in Korean get a singable
// translation instead. Either way the result is a draft the operator reads
// before projecting: the card marks it as AI-written until it is edited or
// saved.
//
// Every free model has its own daily quota, and one of them running out must
// not leave the button dead: the models are asked one after another — the
// configured Gemini model, the other Gemini model, then OpenRouter's free
// models — until one answers.
import {
  RECOGNITION_MODEL_CATALOG,
  findModelInfo,
  getSyncedAiSettings,
  type AiSettings,
  type RecognitionAttempt,
} from '../lib/ai/aiSettings';
import { RecognitionError } from '../lib/ai/recognitionError';
import { extractGeminiText } from '../lib/ai/scoreAi';
import { extractOpenRouterText } from '../lib/ai/scoreNvidia';
import { parseModelJson } from '../lib/ai/scoreParser';
import { normalizeLyricLine } from './planner';

const GEMINI_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';
const OPENROUTER_ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';
const PROXY_URL = import.meta.env.VITE_RECOGNITION_PROXY_URL?.trim() || undefined;
/** One model's answer is waited for this long before the next model is asked. */
const ATTEMPT_TIMEOUT_MS = 60_000;

/**
 * OpenRouter models asked once the Gemini models cannot answer: the
 * general-purpose ones of the recognition pool, not its OCR specialists.
 * Only pool models pass the proxy's allowlist.
 */
const OPENROUTER_LYRICS_MODELS = [
  'google/gemma-4-31b-it:free',
  'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free',
];

export interface AiEnglishResult {
  englishTitle: string;
  /** One entry per Korean slide asked about, in the same order. */
  slides: string[][];
}

export function buildEnglishPrompt(title: string, slides: string[][], reference: string[] = []): string {
  const numbered = slides
    .map((lines, index) => `[${index + 1}]\n${lines.join('\n')}`)
    .join('\n\n');
  // English found on the web for this song is the answer's only source: the
  // model chooses and places its lines, it does not recall or write them.
  const source =
    reference.length > 0
      ? [
          '',
          "The song's English lyrics, as published on the web, are below.",
          'Use ONLY these lines, word for word — choose which of them go under each Korean slide, in order.',
          'Never write, translate or reword a line yourself. Leave a slide empty ([]) if none of these lines fit it.',
          '<english-lyrics>',
          ...reference,
          '</english-lyrics>',
        ]
      : [];
  return [
    'You are preparing bilingual (Korean / English) lyric slides for a Korean church praise night.',
    `Korean song title: ${title}`,
    '',
    `Below are the song's Korean lyric slides, numbered 1 to ${slides.length}.`,
    'For EACH slide, give the English lines that should be printed under that Korean slide.',
    '- If this is a Korean version of an English worship song, use the ORIGINAL English lyrics,',
    '  choosing exactly the English lines that correspond to that Korean slide. Search for the song if needed.',
    '- If the song was written in Korean, write a natural, singable English translation, line for line.',
    '- Never merge, drop or reorder slides. Keep repeated slides repeated.',
    '- Also give the English title (the original English title if one exists).',
    '',
    ...source,
    'Reply with JSON only, no prose: {"englishTitle": string, "slides": [[string, ...], ...]}',
    `The "slides" array must have exactly ${slides.length} entries.`,
    '',
    numbered,
  ].join('\n');
}

/**
 * The model's lines, kept only where they are lines of `reference` — the
 * English it was told to use — so nothing it made up reaches a slide.
 */
export function keepReferenceLines(result: AiEnglishResult, reference: string[]): AiEnglishResult {
  if (reference.length === 0) return result;
  const known = new Set(reference.map(normalizeLyricLine).filter(Boolean));
  const slides = result.slides.map((lines) => lines.filter((line) => known.has(normalizeLyricLine(line))));
  if (slides.every((lines) => lines.length === 0)) throw new Error('AI가 웹에서 찾은 영어 가사를 슬라이드에 맞추지 못했습니다.');
  return { ...result, slides };
}

/** The Gemini request: Google Search grounding lets it look the original up. */
export function buildEnglishRequest(title: string, slides: string[][], reference: string[] = []): unknown {
  return {
    contents: [{ role: 'user', parts: [{ text: buildEnglishPrompt(title, slides, reference) }] }],
    // Grounding cannot be combined with a response schema, so the prompt asks
    // for bare JSON and parseEnglishResponse salvages it.
    tools: [{ google_search: {} }],
    generationConfig: { temperature: 0 },
  };
}

/** The same question for an OpenRouter model, which has no search. */
export function buildOpenRouterEnglishRequest(
  model: string,
  title: string,
  slides: string[][],
  reference: string[] = [],
): unknown {
  return {
    model,
    messages: [{ role: 'user', content: buildEnglishPrompt(title, slides, reference) }],
    temperature: 0,
    max_tokens: 4096,
  };
}

/** Read the model's answer text, forcing it to exactly one English block per slide. */
export function parseEnglishResponse(text: string, slideCount: number): AiEnglishResult {
  const payload = parseModelJson(
    text,
    'AI 응답이 비어 있습니다.',
    'AI 응답을 읽지 못했습니다.',
  ) as { englishTitle?: unknown; slides?: unknown };
  const raw = Array.isArray(payload?.slides) ? payload.slides : [];
  const slides = Array.from({ length: slideCount }, (_, index) => {
    const value = raw[index];
    const lines = Array.isArray(value) ? value : typeof value === 'string' ? value.split('\n') : [];
    return lines
      .filter((line): line is string => typeof line === 'string')
      .map((line) => line.trim())
      .filter(Boolean);
  });
  if (slides.every((lines) => lines.length === 0)) throw new Error('AI가 영어 가사를 돌려주지 않았습니다.');
  return {
    englishTitle: typeof payload?.englishTitle === 'string' ? payload.englishTitle.trim() : '',
    slides,
  };
}

/**
 * The models to ask, in order: the configured Gemini model, the pool's other
 * Gemini models (each has its own free quota), then OpenRouter's free
 * models. An engine with neither its own key nor the shared proxy is left out.
 */
export function planEnglishAttempts(settings: AiSettings, proxyUrl: string | undefined = PROXY_URL): RecognitionAttempt[] {
  const attempts: RecognitionAttempt[] = [];
  const add = (attempt: RecognitionAttempt) => {
    if (!attempts.some((known) => known.engine === attempt.engine && known.model === attempt.model)) attempts.push(attempt);
  };
  if (settings.geminiApiKey.trim() || proxyUrl) {
    if (settings.geminiModel.trim()) add({ engine: 'gemini', model: settings.geminiModel.trim() });
    for (const entry of RECOGNITION_MODEL_CATALOG) {
      if (entry.engine === 'gemini') add({ engine: 'gemini', model: entry.model });
    }
  }
  if (settings.openrouterApiKey.trim() || proxyUrl) {
    for (const model of OPENROUTER_LYRICS_MODELS) {
      if (findModelInfo({ engine: 'openrouter', model })) add({ engine: 'openrouter', model });
    }
  }
  return attempts;
}

/** True for a model that is out of its free quota (or rate-limited) right now. */
export function isQuotaError(error: unknown): boolean {
  return error instanceof RecognitionError && (error.status === 429 || error.status === 402);
}

/**
 * What to tell the operator when every model failed: that the free quotas
 * are spent, when that is all that went wrong; else the first other reason.
 */
export function englishAiFailure(failures: unknown[]): Error {
  if (failures.length > 0 && failures.every(isQuotaError)) {
    return new Error(
      '무료 AI 사용 한도를 모두 썼습니다 (Gemini·OpenRouter). 잠시 뒤 다시 누르거나, 영어 가사를 직접 붙여넣어 주세요.',
    );
  }
  const reason = failures.find((failure) => !isQuotaError(failure)) ?? failures[failures.length - 1];
  return reason instanceof Error ? reason : new Error(String(reason ?? 'AI 호출 실패'));
}

async function postJson(url: string, body: unknown, headers: Record<string, string>, label: string): Promise<unknown> {
  const controller = new AbortController();
  // The whole exchange is timed, body included: OpenRouter answers with its
  // headers at once and keeps the body open while the model works.
  const timer = setTimeout(() => controller.abort(), ATTEMPT_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!response.ok) {
      let detail = `HTTP ${response.status}`;
      try {
        const payload = (await response.json()) as { error?: { message?: string } | string };
        const message = typeof payload.error === 'string' ? payload.error : payload.error?.message;
        if (message) detail = message;
      } catch {
        // keep the status
      }
      throw new RecognitionError(`${label} 호출 실패: ${detail}`, response.status);
    }
    return await response.json();
  } catch (error) {
    if (controller.signal.aborted) throw new RecognitionError(`${label} 응답 시간 초과`, 408);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/** One model's answer text. */
async function askModel(
  attempt: RecognitionAttempt,
  settings: AiSettings,
  title: string,
  slides: string[][],
  reference: string[],
  proxyUrl: string | undefined,
): Promise<string> {
  const proxy = proxyUrl?.replace(/\/$/, '');
  if (attempt.engine === 'gemini') {
    const apiKey = settings.geminiApiKey.trim();
    const url = apiKey
      ? `${GEMINI_ENDPOINT}/${encodeURIComponent(attempt.model)}:generateContent?key=${encodeURIComponent(apiKey)}`
      : `${proxy}/gemini/${encodeURIComponent(attempt.model)}`;
    return extractGeminiText(await postJson(url, buildEnglishRequest(title, slides, reference), {}, 'Gemini'));
  }
  const apiKey = settings.openrouterApiKey.trim();
  // The proxy pins the pool's model to its :free route itself; a direct call names it.
  const model = apiKey ? (findModelInfo(attempt)?.upstreamModel ?? attempt.model) : attempt.model;
  const body = buildOpenRouterEnglishRequest(model, title, slides, reference);
  const response = apiKey
    ? await postJson(OPENROUTER_ENDPOINT, body, { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' }, 'OpenRouter')
    : await postJson(`${proxy}/openrouter`, body, {}, 'OpenRouter');
  return extractOpenRouterText(response);
}

export async function fetchEnglishWithAi(
  title: string,
  slides: string[][],
  reference: string[] = [],
  proxyUrl: string | undefined = PROXY_URL,
): Promise<AiEnglishResult> {
  const settings = await getSyncedAiSettings();
  const attempts = planEnglishAttempts(settings, proxyUrl);
  if (attempts.length === 0) {
    throw new Error('AI 서버가 연결되어 있지 않습니다. 관리자 설정에서 Gemini 키를 입력하거나 영어 가사를 직접 붙여넣어 주세요.');
  }
  const failures: unknown[] = [];
  for (const attempt of attempts) {
    try {
      const text = await askModel(attempt, settings, title, slides, reference, proxyUrl);
      return keepReferenceLines(parseEnglishResponse(text, slides.length), reference);
    } catch (error) {
      // A spent quota, a timeout or an answer that does not fit: the next model may do.
      failures.push(error);
      console.warn(`${attempt.engine} (${attempt.model}) 영어 가사 실패:`, error instanceof Error ? error.message : error);
    }
  }
  throw englishAiFailure(failures);
}
