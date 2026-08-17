import { describe, expect, it } from 'vitest';
import { BASE_PROMPT_LINES, basePrompt, correctionExampleLines } from '../../src/lib/ai/scorePrompt';
import { buildGeminiBatchBody } from '../../src/lib/ai/scoreAi';
import { buildOpenRouterBatchBody } from '../../src/lib/ai/scoreNvidia';

const prompt = BASE_PROMPT_LINES.join('\n');

describe('the shared score prompt', () => {
  it('tells the model to gather stacked lyric rows by row, not by staff', () => {
    // The benchmark's worst songs (5–7절 stacked) failed by grouping each
    // staff's rows into one part — the transpose of the right answer.
    expect(prompt).toContain('모든 오선의 첫째 가사 줄을 순서대로 모아');
    expect(prompt).toContain('절대로 하면 안 되는 결과');
    expect(prompt).toContain('축을 반대로 잡은 것');
  });

  it('gives the model a countable check for the wrong axis', () => {
    // "lines per part == number of staves, not number of verses" is something
    // a model can verify about its own answer before returning it.
    expect(prompt).toContain('lines 개수가 그 묶음의 오선 개수와 같은지');
  });

  it('keeps numbering every part family from the second occurrence', () => {
    expect(prompt).toContain('절이면 V, V2…, 후렴이면 C, C2…');
  });

  it('still separates volta brackets from stacked verses', () => {
    expect(prompt).toContain('볼타');
    expect(prompt).toContain('새 파트를 만들지 마세요');
  });

  it('asks for a printed artist without letting the model invent one', () => {
    expect(prompt).toContain('- artist:');
    expect(prompt).toContain('제목만 보고 아티스트를 추측하지 마세요');
  });

  it('shows past corrections as warnings, not as text to copy', () => {
    const lines = correctionExampleLines([{ before: '살아내는 실력이', after: '살아내는 능력이' }]).join('\n');
    expect(lines).toContain('검증된 과거 교정 예시');
    expect(lines).toContain('잘못 읽음: 살아내는 실력이');
    // The score stays the only source of the words.
    expect(lines).toContain('악보에 인쇄된 대로');
    expect(lines).toContain('그대로 베껴 넣지 마세요');
  });

  it('adds nothing at all when there is nothing learned yet', () => {
    expect(correctionExampleLines([])).toEqual([]);
    const body = buildGeminiBatchBody(['data:image/png;base64,AAA'], 'full') as {
      contents: { parts: { text?: string }[] }[];
    };
    expect(body.contents[0].parts[0].text).not.toContain('검증된 과거 교정 예시');
  });

  it('carries the examples into the request every engine sends', () => {
    const examples = [{ before: '살아내는 실력이', after: '살아내는 능력이' }];
    const gemini = buildGeminiBatchBody(['data:image/png;base64,AAA'], 'full', false, undefined, examples) as {
      contents: { parts: { text?: string }[] }[];
    };
    expect(gemini.contents[0].parts[0].text).toContain('잘못 읽음: 살아내는 실력이');
    const openRouter = buildOpenRouterBatchBody(
      ['data:image/png;base64,AAA'],
      'full',
      'nvidia/nemotron-nano-12b-v2-vl',
      undefined,
      examples,
    ) as { messages: { content: { text?: string }[] }[] };
    expect(openRouter.messages[0].content[0].text).toContain('잘못 읽음: 살아내는 실력이');
  });

  it('reaches the engines through the same shared text', () => {
    const body = buildGeminiBatchBody(['data:image/png;base64,AAA'], 'full') as {
      contents: { parts: { text?: string }[] }[];
    };
    const sent = body.contents[0].parts[0].text ?? '';
    expect(sent).toContain('절대로 하면 안 되는 결과');
    // basePrompt() is what the OpenRouter and Hugging Face clients build on.
    expect(basePrompt('JSON만')).toContain('절대로 하면 안 되는 결과');
  });
});
