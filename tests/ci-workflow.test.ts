// F12:GitHub Actions workflow must run install, typecheck, and tests.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..');

describe('CI workflow', () => {
  it('covers pnpm install, typecheck, and test', () => {
    const workflow = readFileSync(join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');

    expect(workflow).toMatch(/^name:\s*CI/m);
    expect(workflow).toContain('actions/checkout');
    expect(workflow).toContain('actions/setup-node');
    expect(workflow).toContain('pnpm install');
    expect(workflow).toContain('pnpm typecheck');
    expect(workflow).toContain('pnpm test');
  });
});
