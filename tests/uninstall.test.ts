// uninstall:默认删状态目录+App+CLI 软链、保留已装 skill;--purge-skills 连
// skill 一并拆(各自先快照);App/软链只删既定且校验通过的目标;--dry-run 零删除。
import { mkdtempSync } from 'node:fs';
import { lstat, mkdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { installFromSource } from '../src/core/install.ts';
import { planUninstall, uninstall, type UninstallInput } from '../src/core/uninstall.ts';

let home: string;
let source: string;

async function writeSkill(root: string, name: string, body: string): Promise<void> {
  await mkdir(join(root, name), { recursive: true });
  await writeFile(
    join(root, name, 'SKILL.md'),
    `---\nname: ${name}\ndescription: fixture skill ${name} for uninstall tests.\n---\n\n${body}\n`,
  );
}

async function exists(p: string): Promise<boolean> {
  try {
    await lstat(p);
    return true;
  } catch {
    return false;
  }
}

function input(overrides: Partial<UninstallInput> = {}): UninstallInput {
  return { home, purgeSkills: false, dryRun: false, appPath: null, binLinkPath: null, ...overrides };
}

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'skill-switch-uninstall-'));
  source = join(home, 'src-skills');
  await writeSkill(source, 'demo-skill', 'Harmless demo body. Nothing dangerous.');
});

describe('core/uninstall', () => {
  it('dry-run reports a plan and removes nothing', async () => {
    await installFromSource(source, { home, agent: 'claude-code', mode: 'copy' });
    const ssDir = join(home, '.skill-switch');
    expect(await exists(ssDir)).toBe(true);

    const result = await uninstall(input({ dryRun: true, purgeSkills: true }));
    expect(result.dryRun).toBe(true);
    expect(result.plan.skillSwitchDirExists).toBe(true);
    expect(result.plan.purgeTargets).toEqual([{ name: 'demo-skill', agent: 'claude-code' }]);
    expect(result.removedSkillSwitchDir).toBe(false);
    expect(result.purged).toHaveLength(0);
    expect(await exists(ssDir)).toBe(true);
  });

  it('default removes .skill-switch state but keeps installed skills', async () => {
    await installFromSource(source, { home, agent: 'claude-code', mode: 'copy' });
    const ssDir = join(home, '.skill-switch');
    const skillOnDisk = join(home, '.claude', 'skills', 'demo-skill');
    expect(await exists(skillOnDisk)).toBe(true);

    const result = await uninstall(input());
    expect(result.removedSkillSwitchDir).toBe(true);
    expect(result.purged).toHaveLength(0);
    expect(await exists(ssDir)).toBe(false);
    expect(await exists(skillOnDisk)).toBe(true);
  });

  it('--purge-skills removes declared skills (with snapshots) then the state dir', async () => {
    await installFromSource(source, { home, agent: 'claude-code', mode: 'copy' });
    const ssDir = join(home, '.skill-switch');
    const skillOnDisk = join(home, '.claude', 'skills', 'demo-skill');

    const result = await uninstall(input({ purgeSkills: true }));
    expect(result.purged).toHaveLength(1);
    expect(result.purged[0]).toMatchObject({ name: 'demo-skill', agent: 'claude-code' });
    expect(result.purged[0].snapshots.length).toBeGreaterThan(0);
    expect(await exists(skillOnDisk)).toBe(false);
    expect(await exists(ssDir)).toBe(false);
  });

  it('removes only a skill-switch.app that exists; ignores a wrong basename', async () => {
    const goodApp = join(home, 'skill-switch.app');
    await mkdir(goodApp, { recursive: true });
    const wrongApp = join(home, 'other.app');
    await mkdir(wrongApp, { recursive: true });

    const wrongPlan = await planUninstall(input({ appPath: wrongApp, dryRun: true }));
    expect(wrongPlan.appPath).toBeNull();

    const result = await uninstall(input({ appPath: goodApp }));
    expect(result.removedApp).toBe(true);
    expect(await exists(goodApp)).toBe(false);
    expect(await exists(wrongApp)).toBe(true);
  });

  it('removes only a symlink pointing at skill-switch; ignores files and unrelated symlinks', async () => {
    const fakeCli = join(home, 'app', 'Contents', 'MacOS', 'skill-switch-cli');
    await mkdir(join(home, 'app', 'Contents', 'MacOS'), { recursive: true });
    await writeFile(fakeCli, '#!/bin/sh\n');
    const goodLink = join(home, 'skill-switch');
    await symlink(fakeCli, goodLink);

    const result = await uninstall(input({ binLinkPath: goodLink }));
    expect(result.removedBinLink).toBe(true);
    expect(await exists(goodLink)).toBe(false);

    const plainFile = join(home, 'plain-skill-switch');
    await writeFile(plainFile, 'x');
    expect((await planUninstall(input({ binLinkPath: plainFile, dryRun: true }))).binLinkPath).toBeNull();

    const unrelatedTarget = join(home, 'something-else');
    await writeFile(unrelatedTarget, 'x');
    const unrelatedLink = join(home, 'sw-unrelated');
    await symlink(unrelatedTarget, unrelatedLink);
    expect((await planUninstall(input({ binLinkPath: unrelatedLink, dryRun: true }))).binLinkPath).toBeNull();

    // M0-5.11:悬空软链(指向不存在的 skill-switch-cli)→ realpath 解析失败 → 不删(可疑)
    const danglingLink = join(home, 'sw-dangling');
    await symlink(join(home, 'does-not-exist', 'skill-switch-cli'), danglingLink);
    expect((await planUninstall(input({ binLinkPath: danglingLink, dryRun: true }))).binLinkPath).toBeNull();
  });
});
