import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..');

describe('workflow supply-chain contract', () => {
  it('pins every third-party GitHub Action to an immutable commit SHA', () => {
    const files = [
      join(ROOT, 'action.yml'),
      ...readdirSync(join(ROOT, '.github', 'workflows'))
        .filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'))
        .map((name) => join(ROOT, '.github', 'workflows', name)),
    ];
    const violations: string[] = [];

    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      for (const match of source.matchAll(/^\s*uses:\s*([^\s#]+)/gmu)) {
        const reference = match[1]!;
        if (reference.startsWith('./') || reference.startsWith('docker://')) continue;
        if (!/@[0-9a-f]{40}$/u.test(reference)) {
          violations.push(`${file.slice(ROOT.length + 1)}: ${reference}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });
});
