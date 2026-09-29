import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  englishAiFailure,
  fetchEnglishWithAi,
  planEnglishAttempts,
} from '../../src/praise/englishAi';
import { DEFAULT_AI_SETTINGS } from '../../src/lib/ai/aiSettings';
import { RecognitionError } from '../../src/lib/ai/recognitionError';

const PROXY = 'https://proxy.example';
const SLIDES = [['주 사랑 안에 나 살아가리'], ['주를 찬양해 영원토록']];
const ANSWER = { englishTitle: 'Song of Trial', slides: [['In Your love I will live my days'], ['I will praise You forevermore']] };

function quotaError(): Response {
  return Response.json({ error: { message: 'You exceeded your current quota, please check your plan and billing details.' } }, { status: 429 });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('which models the English AI asks', () => {
  it('asks every Gemini model before the OpenRouter ones, the configured one first', () => {
    const attempts = planEnglishAttempts({ ...DEFAULT_AI_SETTINGS, geminiModel: 'gemini-3.5-flash' }, PROXY);
    expect(attempts[0]).toEqual({ engine: 'gemini', model: 'gemini-3.5-flash' });
    expect(attempts.filter((attempt) => attempt.engine === 'gemini').map((attempt) => attempt.model)).toEqual([
      'gemini-3.5-flash',
      'gemini-3.6-flash',
    ]);
    const firstOpenRouter = attempts.findIndex((attempt) => attempt.engine === 'openrouter');
    expect(firstOpenRouter).toBeGreaterThan(1);
    expect(attempts.slice(firstOpenRouter).every((attempt) => attempt.engine === 'openrouter')).toBe(true);
  });

  it('leaves out an engine with neither a key nor the proxy', () => {
    expect(planEnglishAttempts(DEFAULT_AI_SETTINGS, undefined)).toEqual([]);
    const geminiOnly = planEnglishAttempts({ ...DEFAULT_AI_SETTINGS, geminiApiKey: 'key' }, undefined);
    expect(geminiOnly.every((attempt) => attempt.engine === 'gemini')).toBe(true);
  });
});

describe('when a model is out of quota', () => {
  it('moves on to the next model and returns its answer', async () => {
    const asked: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | Request) => {
        const url = typeof input === 'string' ? input : input.url;
        asked.push(url);
        if (url.includes('/gemini/gemini-3.6-flash')) return quotaError();
        if (url.includes('/gemini/gemini-3.5-flash')) {
          return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify(ANSWER) }] } }] });
        }
        return new Response('', { status: 404 });
      }),
    );
    const result = await fetchEnglishWithAi('시험의 노래', SLIDES, [], PROXY);
    expect(result).toEqual(ANSWER);
    expect(asked.map((url) => url.replace(PROXY, ''))).toEqual(['/gemini/gemini-3.6-flash', '/gemini/gemini-3.5-flash']);
  });

  it('reaches the OpenRouter models once every Gemini quota is spent', async () => {
    const bodies: unknown[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | Request, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.url;
        if (url.includes('/gemini/')) return quotaError();
        bodies.push(JSON.parse(String(init?.body)));
        return Response.json({ choices: [{ message: { content: `Here you go:\n${JSON.stringify(ANSWER)}` } }] });
      }),
    );
    const result = await fetchEnglishWithAi('시험의 노래', SLIDES, [], PROXY);
    expect(result).toEqual(ANSWER);
    expect(bodies).toHaveLength(1);
    expect((bodies[0] as { model: string }).model).toMatch(/:free$/);
  });

  it('says the free quotas are spent when that is all that went wrong', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => quotaError()));
    await expect(fetchEnglishWithAi('시험의 노래', SLIDES, [], PROXY)).rejects.toThrow('무료 AI 사용 한도를 모두 썼습니다');
  });

  it('reports another failure over a spent quota', () => {
    const other = new RecognitionError('Gemini 호출 실패: model not found', 404);
    expect(englishAiFailure([new RecognitionError('quota', 429), other])).toBe(other);
    expect(englishAiFailure([new RecognitionError('quota', 429)]).message).toContain('무료 AI 사용 한도');
  });
});
