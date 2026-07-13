import { describe, expect, it } from 'vitest';
import { formatOrder, normalizeToken, parseOrder } from '../../src/lib/utils/orderParser';

describe('normalizeToken', () => {
  it('uppercases plain tokens', () => {
    expect(normalizeToken('v1')).toBe('V1');
    expect(normalizeToken(' pc ')).toBe('PC');
  });

  it('maps Korean and English synonyms', () => {
    expect(normalizeToken('간주')).toBe('I');
    expect(normalizeToken('전주')).toBe('I');
    expect(normalizeToken('intro')).toBe('I');
    expect(normalizeToken('후렴')).toBe('C');
    expect(normalizeToken('브릿지')).toBe('B');
    expect(normalizeToken('bridge')).toBe('B');
    expect(normalizeToken('outro')).toBe('O');
  });

  it('keeps unknown tokens', () => {
    expect(normalizeToken('기도')).toBe('기도');
  });
});

describe('parseOrder', () => {
  it('parses the canonical example', () => {
    expect(parseOrder('I-V1-V2-PC-Cx2, 간주 C')).toEqual([
      'I',
      'V1',
      'V2',
      'PC',
      'C',
      'C',
      'I',
      'C',
    ]);
  });

  it('handles messy separators', () => {
    expect(parseOrder('I – V1 ~ V2 → PC / C')).toEqual(['I', 'V1', 'V2', 'PC', 'C']);
  });

  it('supports attached multipliers in all spellings', () => {
    expect(parseOrder('Cx2')).toEqual(['C', 'C']);
    expect(parseOrder('CX2')).toEqual(['C', 'C']);
    expect(parseOrder('C*3')).toEqual(['C', 'C', 'C']);
  });

  it('applies standalone multipliers to the previous token', () => {
    expect(parseOrder('C x2')).toEqual(['C', 'C']);
    expect(parseOrder('V1 C x3')).toEqual(['V1', 'C', 'C', 'C']);
  });

  it('ignores empty input and stray separators', () => {
    expect(parseOrder('')).toEqual([]);
    expect(parseOrder(' - , - ')).toEqual([]);
  });

  it('keeps unknown tokens for the planner to decide', () => {
    expect(parseOrder('I-C1-C1-C2-C2-기도')).toEqual(['I', 'C1', 'C1', 'C2', 'C2', '기도']);
  });
});

describe('formatOrder', () => {
  it('round-trips with parseOrder', () => {
    const order = parseOrder('I-V1-PC-C');
    expect(formatOrder(order)).toBe('I-V1-PC-C');
  });
});
