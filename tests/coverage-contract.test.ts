import { describe, expect, it } from 'vitest';
import config from '../vitest.config.ts';

describe('coverage contract', () => {
  it('includes security rules and enforces the measured global floor', () => {
    const resolved = config as {
      test?: {
        coverage?: {
          include?: string[];
          thresholds?: Record<string, number>;
        };
      };
    };

    expect(resolved.test?.coverage?.include).toEqual(['src/**/*.ts', 'rules/**/*.ts']);
    expect(resolved.test?.coverage?.thresholds).toEqual({
      statements: 67,
      branches: 62,
      functions: 70,
      lines: 68,
    });
  });
});
