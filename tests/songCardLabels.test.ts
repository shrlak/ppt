import { describe, expect, it } from 'vitest';
import { nextAvailableLabel } from '../src/components/songLabels';

describe('nextAvailableLabel', () => {
  it('uses the requested label when unused', () => {
    expect(nextAvailableLabel([], 'V1')).toBe('V1');
    expect(nextAvailableLabel(['V1'], 'PC')).toBe('PC');
  });

  it('numbers up from the requested label when it is taken (supports multiple verses)', () => {
    expect(nextAvailableLabel(['V1'], 'V1')).toBe('V2');
    expect(nextAvailableLabel(['V1', 'V2'], 'V1')).toBe('V3');
  });

  it('numbers up a bare label when clicked again (supports multiple choruses/bridges)', () => {
    expect(nextAvailableLabel(['PC'], 'PC')).toBe('PC2');
    expect(nextAvailableLabel(['PC', 'PC2'], 'PC')).toBe('PC3');
    expect(nextAvailableLabel(['C'], 'C')).toBe('C2');
    expect(nextAvailableLabel(['B'], 'B')).toBe('B2');
  });

  it('is case-insensitive when checking for collisions', () => {
    expect(nextAvailableLabel(['v1'], 'V1')).toBe('V2');
  });
});
