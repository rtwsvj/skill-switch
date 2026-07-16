// Characterization and resource-regression coverage for unified diff.
// The semantic goldens protect duplicate-line tie breaking during an algorithm swap.
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { generateUnifiedDiff } from '../src/core/skill-diff.ts';

describe('audit blind spot: unified diff semantic compatibility', () => {
  it('preserves duplicate-line matching and replacement ordering', () => {
    const patch = generateUnifiedDiff(
      'duplicate.txt',
      Buffer.from('anchor\nrepeat\nleft\nrepeat\ntail\n'),
      Buffer.from('anchor\nrepeat\nright\nrepeat\ntail\n'),
    );

    expect(patch).toBe([
      '--- a/duplicate.txt',
      '+++ b/duplicate.txt',
      '@@ -1,6 +1,6 @@',
      ' anchor',
      ' repeat',
      '-left',
      '+right',
      ' repeat',
      ' tail',
      ' ',
    ].join('\n'));
  });

  it('preserves deterministic LCS tie breaking for repeated lines', () => {
    const patch = generateUnifiedDiff(
      'tie.txt',
      Buffer.from('A\nB\nA\n'),
      Buffer.from('B\nA\nB\n'),
    );

    expect(patch).toBe([
      '--- a/tie.txt',
      '+++ b/tie.txt',
      '@@ -1,4 +1,4 @@',
      '+B',
      ' A',
      ' B',
      '-A',
      ' ',
    ].join('\n'));
  });

  it('preserves the current trailing-newline representation', () => {
    expect(
      generateUnifiedDiff(
        'newline.txt',
        Buffer.from('one\ntwo'),
        Buffer.from('one\ntwo\n'),
      ),
    ).toBe([
      '--- a/newline.txt',
      '+++ b/newline.txt',
      '@@ -1,2 +1,3 @@',
      ' one',
      ' two',
      '+',
    ].join('\n'));
  });
});

describe('audit blind spot: unified diff resource budget', () => {
  it('diffs 5,000 nearly-identical lines inside a 192 MiB V8 heap', () => {
    const moduleUrl = pathToFileURL(
      join(import.meta.dirname, '..', 'src', 'core', 'skill-diff.ts'),
    ).href;
    const program = `
      const { generateUnifiedDiff } = await import(${JSON.stringify(moduleUrl)});
      const count = 5000;
      const oldLines = Array.from({ length: count }, (_, i) => 'line-' + i);
      const newLines = [...oldLines];
      newLines[Math.floor(count / 2)] = 'replacement';
      const started = performance.now();
      const patch = generateUnifiedDiff(
        'large.txt',
        Buffer.from(oldLines.join('\\n')),
        Buffer.from(newLines.join('\\n')),
      );
      const result = {
        elapsedMs: performance.now() - started,
        hasRemoval: patch.includes('-line-2500'),
        hasAddition: patch.includes('+replacement'),
      };
      process.stdout.write(JSON.stringify(result));
    `;

    const started = performance.now();
    const child = spawnSync(
      process.execPath,
      [
        '--max-old-space-size=192',
        '--import',
        'tsx',
        '--input-type=module',
        '--eval',
        program,
      ],
      { cwd: join(import.meta.dirname, '..'), encoding: 'utf8', timeout: 15_000 },
    );
    const wallMs = performance.now() - started;

    expect(
      child.status,
      `large diff child failed (signal=${String(child.signal)}): ${child.stderr.slice(-2_000)}`,
    ).toBe(0);
    const result = JSON.parse(child.stdout) as {
      elapsedMs: number;
      hasRemoval: boolean;
      hasAddition: boolean;
    };
    expect(result).toMatchObject({ hasRemoval: true, hasAddition: true });
    expect(result.elapsedMs).toBeLessThan(5_000);
    expect(wallMs).toBeLessThan(15_000);
  }, 20_000);
});
