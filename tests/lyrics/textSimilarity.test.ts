import { describe, expect, it } from 'vitest';
import { sameLyrics } from '../../src/lib/lyrics/textSimilarity';
import type { Section } from '../../src/lib/utils/types';

const section = (label: string, lines: string[]): Section => ({ label, lines });

describe('sameLyrics', () => {
  it('ignores spacing, punctuation and how the lines were split into parts', () => {
    const read = [section('V1', ['\ud55c \uc904', '\ub450 \ubc88\uc9f8 \uc904'])];
    const saved = [section('V', ['\ud55c\uc904!']), section('V2', ['\ub450 \ubc88\uc9f8  \uc904'])];
    expect(sameLyrics(read, saved)).toBe(true);
  });

  it('is not the same reading when a word, a line or the order differs', () => {
    const read = [section('V1', ['\ud55c \uc904', '\ub450 \ubc88\uc9f8 \uc904'])];
    expect(sameLyrics(read, [section('V1', ['\ud55c \uc904', '\uc138 \ubc88\uc9f8 \uc904'])])).toBe(false);
    expect(sameLyrics(read, [section('V1', ['\ud55c \uc904'])])).toBe(false);
    expect(sameLyrics(read, [section('V1', ['\ub450 \ubc88\uc9f8 \uc904', '\ud55c \uc904'])])).toBe(false);
  });

  it('confirms nothing when either side is empty', () => {
    expect(sameLyrics([], [])).toBe(false);
    expect(sameLyrics([section('V1', ['  '])], [section('V1', [''])])).toBe(false);
  });
});
