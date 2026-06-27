// packs install / enrich / extends 功能测试
// 覆盖:
//   1. resolvePackSkills — extends 展开、去重、循环引用保护
//   2. buildInstallPlan — 有 repo → install;无 repo → skip
//   3. installPack      — dry-run 不写文件;真实安装调用 installFromSource
//   4. enrichManifestSkills — 从 SkillsLockFile 回填 repo/commit/ref
//   5. packs install CLI — bin shim;dry-run;--json;跳过无来源 skill
//   6. packs list CLI    — 列出 *.pack.json

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  resolvePackSkills,
  buildInstallPlan,
  installPack,
  enrichManifestSkills,
} from '../src/core/packs/install-pack.ts';
import { writePackManifest } from '../src/core/packs/pack-model.ts';
import type { PackManifest, PackSkillRef } from '../src/core/packs/types.ts';
import type { SkillsLockFile } from '../src/core/lock.ts';

// ── 全局临时目录 ──────────────────────────────────────────────────────────────

const ROOT = join(import.meta.dirname, '..');
const BIN = join(ROOT, 'bin', 'skill-switch.mjs');

let workDir: string; // git 仓 + local skill 存放处

/** 初始化含 SKILL.md 的本地目录并建 git 仓 */
async function makeSkillRepo(repoPath: string, skillName: string): Promise<void> {
  const skillDir = join(repoPath, skillName);
  await mkdir(skillDir, { recursive: true });
  await writeFile(
    join(skillDir, 'SKILL.md'),
    `---\nname: ${skillName}\ndescription: pack install test fixture skill.\n---\n\nTest skill ${skillName}.\n`,
  );
  execFileSync('git', ['init', '-q', repoPath]);
  execFileSync('git', ['-C', repoPath, '-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '-A']);
  execFileSync('git', ['-C', repoPath, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init']);
}

beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'ss-packs-install-'));
  await makeSkillRepo(join(workDir, 'repo-alpha'), 'alpha-skill');
  await makeSkillRepo(join(workDir, 'repo-beta'), 'beta-skill');
});

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

// ── helpers ───────────────────────────────────────────────────────────────────

function freshHome(): string {
  return mkdtempSync(join(tmpdir(), 'ss-packs-ihome-'));
}

function runBin(
  args: string[],
  opts: { cwd?: string } = {},
): { stdout: string; stderr: string; status: number | null } {
  const { spawnSync } = require('node:child_process') as typeof import('node:child_process');
  const result = spawnSync(process.execPath, [BIN, ...args], {
    cwd: opts.cwd ?? workDir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return { stdout: result.stdout ?? '', stderr: result.stderr ?? '', status: result.status };
}

function makeManifest(skills: PackSkillRef[], extra: Partial<PackManifest> = {}): PackManifest {
  return {
    version: 1,
    name: 'test-pack',
    source: 'manual',
    skills,
    ...extra,
  };
}

// ── 1. resolvePackSkills ─────────────────────────────────────────────────────

describe('resolvePackSkills', () => {
  it('无 extends:直接返回 manifest.skills', async () => {
    const m = makeManifest([{ name: 'a' }, { name: 'b' }]);
    const skills = await resolvePackSkills(m, async () => { throw new Error('不该被调用'); });
    expect(skills.map((s) => s.name)).toEqual(['a', 'b']);
  });

  it('extends:父 skill 排前面,子 skill 排后面', async () => {
    const parent = makeManifest([{ name: 'parent-skill' }]);
    const child: PackManifest = {
      ...makeManifest([{ name: 'child-skill' }]),
    };
    (child as PackManifest & { extends: string[] }).extends = ['parent.pack.json'];

    const skills = await resolvePackSkills(child, async (_path) => parent);
    expect(skills.map((s) => s.name)).toEqual(['parent-skill', 'child-skill']);
  });

  it('子 skill 覆盖父同名 skill(子优先)', async () => {
    const parent = makeManifest([{ name: 'shared', repo: 'https://old.repo' }]);
    const child = makeManifest([{ name: 'shared', repo: 'https://new.repo' }]);
    (child as PackManifest & { extends: string[] }).extends = ['parent.pack.json'];

    const skills = await resolvePackSkills(child, async () => parent);
    expect(skills).toHaveLength(1);
    expect(skills[0]!.repo).toBe('https://new.repo');
  });

  it('循环引用:第二次出现同一父路径时跳过(不死循环)', async () => {
    const parent = makeManifest([{ name: 'shared' }]);
    // child extends 同一 path 两次
    const child = makeManifest([{ name: 'child' }]);
    (child as PackManifest & { extends: string[] }).extends = ['same.pack.json', 'same.pack.json'];

    let callCount = 0;
    const skills = await resolvePackSkills(child, async () => {
      callCount++;
      return parent;
    });
    expect(callCount).toBe(1); // 只调用一次
    expect(skills.map((s) => s.name)).toEqual(['shared', 'child']);
  });

  it('父清单加载失败时跳过并返回子 skill', async () => {
    const child = makeManifest([{ name: 'child-only' }]);
    (child as PackManifest & { extends: string[] }).extends = ['missing.pack.json'];

    const skills = await resolvePackSkills(child, async () => { throw new Error('ENOENT'); });
    expect(skills.map((s) => s.name)).toEqual(['child-only']);
  });
});

// ── 2. buildInstallPlan ───────────────────────────────────────────────────────

describe('buildInstallPlan', () => {
  it('有 repo → action=install', () => {
    const plan = buildInstallPlan([{ name: 'a', repo: 'https://github.com/x/y' }]);
    expect(plan[0]!.action).toBe('install');
  });

  it('无 repo → action=skip,附 skipReason', () => {
    const plan = buildInstallPlan([{ name: 'b' }]);
    expect(plan[0]!.action).toBe('skip');
    expect(plan[0]!.skipReason).toContain('packs save --enrich');
  });

  it('空列表 → 空计划', () => {
    expect(buildInstallPlan([])).toHaveLength(0);
  });

  it('混合:有无 repo 各一', () => {
    const plan = buildInstallPlan([
      { name: 'has-repo', repo: 'https://example.com/r' },
      { name: 'no-repo' },
    ]);
    expect(plan[0]!.action).toBe('install');
    expect(plan[1]!.action).toBe('skip');
  });
});

// ── 3. installPack ────────────────────────────────────────────────────────────

describe('installPack', () => {
  it('dry-run:返回计划,不写任何文件', async () => {
    const home = freshHome();
    const repoPath = join(workDir, 'repo-alpha');
    const m = makeManifest([
      { name: 'alpha-skill', repo: `file://${repoPath}` },
      { name: 'no-source-skill' },
    ]);

    const result = await installPack(m, { home, agent: 'claude-code', mode: 'copy', dryRun: true });
    expect(result.dryRun).toBe(true);
    expect(result.results).toHaveLength(0); // dry-run 不跑真实安装
    expect(result.plan).toHaveLength(2);
    expect(result.plan[0]!.action).toBe('install');
    expect(result.plan[1]!.action).toBe('skip');

    // 磁盘上没有任何新目录
    expect(existsSync(join(home, '.claude', 'skills', 'alpha-skill'))).toBe(false);
  });

  it('无来源 skill → 报告 skipped', async () => {
    const home = freshHome();
    const m = makeManifest([{ name: 'orphan' }]);

    const result = await installPack(m, { home, agent: 'claude-code', mode: 'copy' });
    expect(result.dryRun).toBe(false);
    expect(result.results).toHaveLength(1);
    expect(result.results[0]!.action).toBe('skipped');
    expect(result.results[0]!.name).toBe('orphan');
  });

  it('有 repo 来源 → 真实安装 skill 到磁盘', async () => {
    const home = freshHome();
    const repoPath = join(workDir, 'repo-alpha');
    const m = makeManifest([
      { name: 'alpha-skill', repo: `file://${repoPath}` },
    ]);

    const result = await installPack(m, { home, agent: 'claude-code', mode: 'copy' });
    // 若出错,把 error 信息打出来方便排查
    if (result.results[0]?.action === 'error') {
      throw new Error(`installPack error: ${result.results[0].error}`);
    }
    expect(result.results[0]!.action).toBe('installed');
    expect(existsSync(join(home, '.claude', 'skills', 'alpha-skill', 'SKILL.md'))).toBe(true);
  });

  it('多 skill 套餐:有来源的装,无来源的跳过', async () => {
    const home = freshHome();
    const repoPath = join(workDir, 'repo-beta');
    const m = makeManifest([
      { name: 'beta-skill', repo: `file://${repoPath}` },
      { name: 'missing-source' },
    ]);

    const result = await installPack(m, { home, agent: 'claude-code', mode: 'copy' });
    const installed = result.results.filter((r) => r.action === 'installed');
    const skipped = result.results.filter((r) => r.action === 'skipped');
    expect(installed).toHaveLength(1);
    expect(skipped).toHaveLength(1);
    expect(skipped[0]!.name).toBe('missing-source');
    expect(existsSync(join(home, '.claude', 'skills', 'beta-skill', 'SKILL.md'))).toBe(true);
  });
});

// ── 4. enrichManifestSkills ───────────────────────────────────────────────────

describe('enrichManifestSkills', () => {
  const lock: SkillsLockFile = {
    version: 1,
    skills: [
      {
        name: 'cf-skill',
        agent: 'claude-code',
        source: 'https://github.com/example/skills.git',
        sourceType: 'git',
        commit: 'deadbeef1234',
        ref: 'main',
        sha256: 'aabbcc',
        mode: 'copy',
      },
      {
        name: 'local-only',
        agent: 'claude-code',
        source: '/Users/dev/skills',
        sourceType: 'local',
        sha256: 'ddbbcc',
        mode: 'copy',
      },
    ],
  };

  it('git 来源 skill 获得 repo/commit/ref 回填', () => {
    const m = makeManifest([{ name: 'cf-skill' }]);
    const { enriched, notFound } = enrichManifestSkills(m, lock, 'claude-code');
    expect(notFound).toHaveLength(0);
    expect(enriched[0]!.repo).toBe('https://github.com/example/skills.git');
    expect(enriched[0]!.commit).toBe('deadbeef1234');
    expect(enriched[0]!.ref).toBe('main');
  });

  it('local 来源 skill(sourceType=local)→ 保持无来源,记入 notFound', () => {
    const m = makeManifest([{ name: 'local-only' }]);
    const { enriched, notFound } = enrichManifestSkills(m, lock, 'claude-code');
    expect(notFound).toContain('local-only');
    expect(enriched[0]!.repo).toBeUndefined();
  });

  it('lock 中不存在的 skill → 保持原样,记入 notFound', () => {
    const m = makeManifest([{ name: 'unknown-skill' }]);
    const { enriched, notFound } = enrichManifestSkills(m, lock, 'claude-code');
    expect(notFound).toContain('unknown-skill');
    expect(enriched[0]!.repo).toBeUndefined();
  });

  it('混合:有找到、有 local、有不存在', () => {
    const m = makeManifest([
      { name: 'cf-skill' },
      { name: 'local-only' },
      { name: 'not-in-lock' },
    ]);
    const { enriched, notFound } = enrichManifestSkills(m, lock, 'claude-code');
    expect(enriched[0]!.repo).toBe('https://github.com/example/skills.git');
    expect(enriched[1]!.repo).toBeUndefined();
    expect(enriched[2]!.repo).toBeUndefined();
    expect(notFound).toEqual(['local-only', 'not-in-lock']);
  });

  it('不同 agent 的 lock 条目不干扰', () => {
    const lockWithOtherAgent: SkillsLockFile = {
      version: 1,
      skills: [
        {
          name: 'shared-skill',
          agent: 'gemini-cli',
          source: 'https://github.com/other/repo.git',
          sourceType: 'git',
          commit: 'abc',
          sha256: 'xx',
          mode: 'copy',
        },
      ],
    };
    const m = makeManifest([{ name: 'shared-skill' }]);
    const { notFound } = enrichManifestSkills(m, lockWithOtherAgent, 'claude-code');
    expect(notFound).toContain('shared-skill'); // claude-code agent 里没有
  });
});

// ── 5. packs install CLI ──────────────────────────────────────────────────────

describe('packs install CLI', () => {
  it('--dry-run --json:输出计划 JSON,不写文件', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'ss-packs-cli-'));
    const home = freshHome();
    const packFile = join(tmpDir, 'test.pack.json');
    const repoPath = join(workDir, 'repo-alpha');
    const m = makeManifest([
      { name: 'alpha-skill', repo: `file://${repoPath}` },
      { name: 'no-source' },
    ]);
    await writePackManifest(packFile, m);

    const result = runBin([
      'packs', 'install', packFile,
      '--agent', 'claude-code',
      '--home', home,
      '--dry-run',
      '--json',
    ]);

    expect(result.status).toBe(0);
    const out = JSON.parse(result.stdout) as { dryRun: boolean; plan: Array<{ action: string }> };
    expect(out.dryRun).toBe(true);
    expect(out.plan).toHaveLength(2);
    expect(out.plan[0]!.action).toBe('install');
    expect(out.plan[1]!.action).toBe('skip');
    // 磁盘无写入
    expect(existsSync(join(home, '.claude', 'skills', 'alpha-skill'))).toBe(false);

    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('无来源 skill → CLI 报 skipped,退出 0', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'ss-packs-cli2-'));
    const home = freshHome();
    const packFile = join(tmpDir, 'norepo.pack.json');
    const m = makeManifest([{ name: 'orphan-skill' }]);
    await writePackManifest(packFile, m);

    const result = runBin([
      'packs', 'install', packFile,
      '--agent', 'claude-code',
      '--home', home,
    ]);
    // 只有 skip,没有 error/blocked → 退出 0
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('orphan-skill');

    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('packs install --json 真实安装:输出 JSON 结果含 installed', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'ss-packs-cli3-'));
    const home = freshHome();
    const packFile = join(tmpDir, 'real.pack.json');
    const repoPath = join(workDir, 'repo-beta');
    const m = makeManifest([
      { name: 'beta-skill', repo: `file://${repoPath}` },
    ]);
    await writePackManifest(packFile, m);

    const result = runBin([
      'packs', 'install', packFile,
      '--agent', 'claude-code',
      '--home', home,
      '--json',
    ]);

    expect(result.status).toBe(0);
    const out = JSON.parse(result.stdout) as { results: Array<{ action: string }> };
    expect(out.results[0]!.action).toBe('installed');

    rmSync(tmpDir, { recursive: true, force: true });
  });
});

// ── 6. packs list CLI ─────────────────────────────────────────────────────────

describe('packs list CLI', () => {
  it('--json:列出目录下的 *.pack.json', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'ss-packs-list-'));
    // 写两个合法的 pack.json
    await writePackManifest(join(tmpDir, 'pack-a.pack.json'), makeManifest([{ name: 'x' }, { name: 'y' }], { name: 'pack-a' }));
    await writePackManifest(join(tmpDir, 'pack-b.pack.json'), makeManifest([{ name: 'z' }], { name: 'pack-b' }));
    // 非 *.pack.json 文件不应出现
    await writeFile(join(tmpDir, 'other.json'), '{}');

    const result = runBin(['packs', 'list', tmpDir, '--json']);
    expect(result.status).toBe(0);
    const out = JSON.parse(result.stdout) as { packs: Array<{ file: string; skillCount: number }> };
    expect(out.packs).toHaveLength(2);
    expect(out.packs.some((p) => p.file === 'pack-a.pack.json')).toBe(true);
    expect(out.packs.some((p) => p.file === 'pack-b.pack.json')).toBe(true);
    // skill 数量正确
    const a = out.packs.find((p) => p.file === 'pack-a.pack.json')!;
    expect(a.skillCount).toBe(2);

    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('空目录:提示无 pack.json', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'ss-packs-list-empty-'));
    const result = runBin(['packs', 'list', tmpDir]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('没有');
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('loadPackManifest:损坏的 .pack.json 被跳过,不影响其他', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'ss-packs-list-bad-'));
    await writeFile(join(tmpDir, 'broken.pack.json'), '{ not json }');
    await writePackManifest(join(tmpDir, 'good.pack.json'), makeManifest([{ name: 'a' }], { name: 'good' }));

    const result = runBin(['packs', 'list', tmpDir, '--json']);
    expect(result.status).toBe(0);
    const out = JSON.parse(result.stdout) as { packs: Array<{ file: string }> };
    expect(out.packs).toHaveLength(1);
    expect(out.packs[0]!.file).toBe('good.pack.json');

    rmSync(tmpDir, { recursive: true, force: true });
  });
});

// ── 7. manifestToInstallPlan 回归(来自 pack-model):与 buildInstallPlan 协同 ─

describe('manifestToInstallPlan + buildInstallPlan 协同', () => {
  it('manifestToInstallPlan 输出直接可作 buildInstallPlan 的输入', async () => {
    const { manifestToInstallPlan } = await import('../src/core/packs/pack-model.ts');
    const m = makeManifest([
      { name: 'with-repo', repo: 'https://example.com/r' },
      { name: 'without-repo' },
    ]);
    const { skills } = manifestToInstallPlan(m);
    const plan = buildInstallPlan(skills);
    expect(plan[0]!.action).toBe('install');
    expect(plan[1]!.action).toBe('skip');
  });
});
