// E2:Agent Skills 标准目录(`.agents/skills`)兼容性回归守卫。
// AAIF/Linux Foundation 的 Agent Skills 标准用共享的 `.agents/skills` 布局(amp/codex/cline/
// antigravity/zed… 共用)。skill-switch 经 vendor agent 注册表已识别该标准位置——本测试把这条
// 「标准兼容」能力钉死,防回归。注:AGENTS.md(rules 文件)按定位刻意不纳管(那是 rulesync 的活)。
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { scanHome } from '../src/core/scan.ts';

const HOME_BASIC = join(import.meta.dirname, 'fixtures', 'home-basic');

describe('E2 Agent Skills standard (.agents/skills) compatibility', () => {
  it('scans skills laid out under the standard .agents/skills directory', async () => {
    const records = await scanHome(HOME_BASIC);
    const standard = records.filter((r) => r.relSkillsDir === '.agents/skills');
    expect(standard.length).toBeGreaterThan(0);
    expect(standard.map((r) => r.dirName)).toContain('deploy-checklist');
  });

  it('attributes standard-layout skills to the agents that share .agents/skills', async () => {
    const records = await scanHome(HOME_BASIC);
    const deploy = records.find((r) => r.dirName === 'deploy-checklist' && r.relSkillsDir === '.agents/skills');
    expect(deploy).toBeDefined();
    // 该标准目录被多个 agent 共用 —— 至少应识别出 cline(其全局 skills 目录即 ~/.agents/skills)。
    expect(deploy!.agents).toContain('cline');
    expect(deploy!.agents.length).toBeGreaterThan(1);
  });
});
