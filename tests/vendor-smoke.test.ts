// vendor 接线 smoke 测试:验证快照文件可被导入、关键不变量成立。
// 深度行为测试随各切片落地(conflict/budget 在 S5,lock 在 S3)。
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  agents,
  detectInstalledAgents,
  getAgentConfig,
  isUniversalAgent,
} from '../src/vendor/vercel-skills/agents.ts';
import { UNIVERSAL_SKILLS_DIR } from '../src/vendor/vercel-skills/constants.ts';
import { detectConflicts } from '../src/vendor/agent-skills-cli/conflict-detector.ts';
import {
  buildContextPlan,
  formatContextJSON,
} from '../src/vendor/agent-skills-cli/context-budget.ts';
import { getLockFilePath } from '../src/vendor/agent-skills-cli/skill-lock.ts';

describe('vendor: vercel-skills agents map', () => {
  it('snapshot carries the verified 71-agent registry', () => {
    expect(Object.keys(agents)).toHaveLength(71);
  });

  it('claude config resolves and universal-agent helpers work', () => {
    const claude = getAgentConfig('claude-code');
    expect(claude.skillsDir).toContain('.claude');
    expect(typeof isUniversalAgent('claude-code')).toBe('boolean');
    expect(UNIVERSAL_SKILLS_DIR).toBe('.agents/skills');
  });

  it('detectInstalledAgents runs against the sandboxed HOME', async () => {
    expect(homedir()).toContain('skill-switch-home-');
    const detected = await detectInstalledAgents();
    expect(Array.isArray(detected)).toBe(true);
  });
});

describe('vendor: agent-skills-cli governance modules', () => {
  it('detectConflicts returns the documented result shape', async () => {
    const dir = join(tmpdir(), `skill-switch-smoke-${Date.now()}`);
    const skillA = join(dir, 'always-tabs');
    const skillB = join(dir, 'never-tabs');
    await mkdir(skillA, { recursive: true });
    await mkdir(skillB, { recursive: true });
    await writeFile(
      join(skillA, 'SKILL.md'),
      '---\nname: always-tabs\ndescription: indentation policy\n---\nAlways use tabs for indentation.\n',
    );
    await writeFile(
      join(skillB, 'SKILL.md'),
      '---\nname: never-tabs\ndescription: indentation policy\n---\nNever use tabs for indentation.\n',
    );

    const result = await detectConflicts([skillA, skillB]);
    expect(result).toHaveProperty('conflicts');
    expect(result).toHaveProperty('overlaps');
    expect(result.summary.total).toBeGreaterThanOrEqual(0);
  });

  it('buildContextPlan produces a JSON-serializable plan', async () => {
    const plan = await buildContextPlan([], { budget: 1000 });
    expect(() => formatContextJSON(plan)).not.toThrow();
  });

  it('lock path stays inside the sandboxed HOME', () => {
    expect(getLockFilePath()).toContain('skill-switch-home-');
  });
});
