import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('published package contract', () => {
  it('advertises a CLI without exporting uncompiled TypeScript as a library entry', () => {
    const pkg = JSON.parse(
      readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8'),
    ) as {
      bin?: Record<string, string>;
      exports?: Record<string, string>;
    };

    expect(pkg.bin).toEqual({ 'skill-switch': 'bin/skill-switch.mjs' });
    expect(pkg.exports?.['.']).toBeUndefined();
    expect(pkg.exports?.['./package.json']).toBe('./package.json');
  });
});
