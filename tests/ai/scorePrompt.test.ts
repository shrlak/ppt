import { describe, expect, it } from 'vitest';
import { BASE_PROMPT_LINES, basePrompt } from '../../src/lib/ai/scorePrompt';
import { buildGeminiBatchBody } from '../../src/lib/ai/scoreAi';

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
