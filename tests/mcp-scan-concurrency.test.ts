import { describe, expect, it } from 'vitest';
import { _mapWithConcurrencyForTest } from '../src/core/mcp-scan/scan.ts';

describe('MCP scan bounded concurrency', () => {
  it('preserves input order while bounding active work', async () => {
    let active = 0;
    let peak = 0;
    const completed: number[] = [];
    const values = [40, 5, 30, 10, 20];

    const result = await _mapWithConcurrencyForTest(values, 2, async (delay, index) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, delay));
      completed.push(index);
      active -= 1;
      return `result-${index}`;
    });

    expect(peak).toBe(2);
    expect(completed).not.toEqual([0, 1, 2, 3, 4]);
    expect(result).toEqual([
      'result-0',
      'result-1',
      'result-2',
      'result-3',
      'result-4',
    ]);
  });

  it('stops assigning new work after a mapper failure', async () => {
    const started: number[] = [];
    await expect(_mapWithConcurrencyForTest([0, 1, 2, 3], 1, async (value) => {
      started.push(value);
      if (value === 1) throw new Error('failed');
      return value;
    })).rejects.toThrow('failed');
    expect(started).toEqual([0, 1]);
  });
});
