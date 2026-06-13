import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..');

describe('repository license and third-party notices', () => {
  it('ships an MIT LICENSE for the project', () => {
    const license = readFileSync(join(ROOT, 'LICENSE'), 'utf8');
    expect(license).toContain('MIT License');
    expect(license).toContain('Copyright (c) 2026');
    expect(license).toContain('Permission is hereby granted, free of charge');
  });

  it('keeps vendor and ported-rule sources attributed', () => {
    const notices = readFileSync(join(ROOT, 'THIRD_PARTY_NOTICES.md'), 'utf8');
    for (const source of [
      'vercel-labs/skills',
      'Karanjot786/agent-skills-cli',
      'agentskill-sh/ags',
      'agentskills/agentskills',
      'xingkongliang/skills-manager',
      'ryoppippi/ccusage',
    ]) {
      expect(notices).toContain(source);
    }
    expect(notices).toContain('src/vendor/vercel-skills/');
    expect(notices).toContain('src/vendor/agent-skills-cli/');
  });
});
