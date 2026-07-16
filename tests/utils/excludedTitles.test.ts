import { describe, expect, it } from 'vitest';
import { isExcludedTitle } from '../../src/lib/utils/excludedTitles';

const EXCLUDED = ['공동체 고백송', '예배 전 준비 찬양'];

describe('isExcludedTitle', () => {
  it('matches exactly, ignoring spacing and case', () => {
    expect(isExcludedTitle('공동체 고백송', EXCLUDED)).toBe(true);
    expect(isExcludedTitle('공동체고백송', EXCLUDED)).toBe(true);
  });

  it('matches when the recognized title contains an excluded entry', () => {
    expect(isExcludedTitle('공동체 고백송 - 주만 바라볼지라', EXCLUDED)).toBe(true);
    expect(isExcludedTitle('예배 전 준비 찬양 (은혜)', EXCLUDED)).toBe(true);
  });

  it('matches when an excluded entry contains the recognized title', () => {
    expect(isExcludedTitle('준비 찬양', ['예배 전 준비 찬양'])).toBe(false);
    expect(isExcludedTitle('예배 전 준비 찬양', ['준비 찬양'])).toBe(true);
  });

  it('does not match ordinary songs', () => {
    expect(isExcludedTitle('주 은혜임을', EXCLUDED)).toBe(false);
    expect(isExcludedTitle('은혜', EXCLUDED)).toBe(false);
  });

  it('ignores empty or too-short values on either side', () => {
    expect(isExcludedTitle('', EXCLUDED)).toBe(false);
    expect(isExcludedTitle('공동체 고백송', [''])).toBe(false);
    expect(isExcludedTitle('가', ['가'])).toBe(false);
  });
});
