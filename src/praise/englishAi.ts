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
import { getSyncedAiSettings } from '../lib/ai/aiSettings';
import { extractGeminiText } from '../lib/ai/scoreAi';
import { parseModelJson } from '../lib/ai/scoreParser';

const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';
const PROXY_URL = import.meta.env.VITE_RECOGNITION_PROXY_URL?.trim() || undefined;

export interface AiEnglishResult {
  englishTitle: string;
  /** One entry per Korean slide asked about, in the same order. */
  slides: string[][];
}

export function buildEnglishPrompt(title: string, slides: string[][]): string {
  const numbered = slides
    .map((lines, index) => `[${index + 1}]\n${lines.join('\n')}`)
    .join('\n\n');
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
    'Reply with JSON only, no prose: {"englishTitle": string, "slides": [[string, ...], ...]}',
    `The "slides" array must have exactly ${slides.length} entries.`,
    '',
    numbered,
  ].join('\n');
}

export function buildEnglishRequest(title: string, slides: string[][]): unknown {
  return {
    contents: [{ role: 'user', parts: [{ text: buildEnglishPrompt(title, slides) }] }],
    // Grounding cannot be combined with a response schema, so the prompt asks
    // for bare JSON and parseEnglishResponse salvages it.
    tools: [{ google_search: {} }],
    generationConfig: { temperature: 0 },
  };
}

/** Read the model's answer, forcing it to exactly one English block per slide. */
export function parseEnglishResponse(response: unknown, slideCount: number): AiEnglishResult {
  const payload = parseModelJson(
    extractGeminiText(response),
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

export async function fetchEnglishWithAi(title: string, slides: string[][]): Promise<AiEnglishResult> {
  const settings = await getSyncedAiSettings();
  const apiKey = settings.geminiApiKey.trim();
  if (!apiKey && !PROXY_URL) {
    throw new Error('AI 서버가 연결되어 있지 않습니다. 관리자 설정에서 Gemini 키를 입력하거나 영어 가사를 직접 붙여넣어 주세요.');
  }
  const model = settings.geminiModel;
  const url = apiKey
    ? `${ENDPOINT}/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`
    : `${PROXY_URL!.replace(/\/$/, '')}/gemini/${encodeURIComponent(model)}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(buildEnglishRequest(title, slides)),
  });
  if (!response.ok) {
    let detail = `HTTP ${response.status}`;
    try {
      const body = (await response.json()) as { error?: { message?: string } | string };
      const message = typeof body.error === 'string' ? body.error : body.error?.message;
      if (message) detail = message;
    } catch {
      // keep the status
    }
    throw new Error(`AI 호출 실패: ${detail}`);
  }
  return parseEnglishResponse(await response.json(), slides.length);
}
