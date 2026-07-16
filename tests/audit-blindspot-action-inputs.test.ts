import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ACTION_PATH = join(import.meta.dirname, '..', 'action.yml');

function compositeRunBlocks(yaml: string): string[] {
  const lines = yaml.split('\n');
  const blocks: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const start = /^(\s*)run:\s*\|\s*$/.exec(lines[i]!);
    if (!start) continue;
    const indent = start[1]!.length;
    const body: string[] = [];
    for (i += 1; i < lines.length; i += 1) {
      const line = lines[i]!;
      if (line.trim() !== '' && line.length - line.trimStart().length <= indent) {
        i -= 1;
        break;
      }
      body.push(line);
    }
    blocks.push(body.join('\n'));
  }
  return blocks;
}

describe('GitHub Action input-injection regression', () => {
  const yaml = readFileSync(ACTION_PATH, 'utf8');
  const runSource = compositeRunBlocks(yaml).join('\n');

  it('never expands action inputs directly inside executable shell source', () => {
    // Expressions in `env:` are data. Expressions inside `run:` become Bash
    // source and can be broken out of with quotes, newlines, `;`, or `$()`.
    expect(runSource).not.toMatch(/\$\{\{\s*inputs\./);
  });

  it('delegates argv construction to a fixed Node wrapper without eval', () => {
    expect(runSource).toMatch(/\bnode\b[^\n]*github-action/i);
    expect(runSource).not.toMatch(/\beval\b/);
  });

  it('does not execute an unpinned latest npm package', () => {
    const versionDefault = /\n\s{2}version:[\s\S]*?\n\s{4}default:\s*['"]?([^'"\n]+)['"]?/.exec(yaml)?.[1]?.trim();
    expect(versionDefault).toMatch(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
  });
});
