// P0-1 回归:simple-git 3.36 的 @simple-git/argv-parser 守卫按小写名拦截一批
// 环境变量(见 src/vendor/vercel-skills/git.ts 头注)。2026-08 前剥离清单只有
// 5 个键,漏掉的裸 EDITOR 使宿主设了 EDITOR 时一切 git 克隆失败——且 CI 不设
// EDITOR 所以全绿("测试通过但功能错误")。本文件两层防线:
//   ① stripGuardedEnv 单元测试:对照守卫表逐键断言(含大小写混合与 git_config_* 通配);
//   ② 行为回归:污染 process.env 后真实走 cloneRepo(file:// 本地仓),零网络。
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { cleanupTempDir, cloneRepo, stripGuardedEnv } from '../src/vendor/vercel-skills/git.ts';

// 与 @simple-git/argv-parser@1.1.1 src/env/parse-env.ts GitEnvKeys 对齐的守卫表。
// 若升级 simple-git 后新增守卫键而此处未同步,行为回归会在 CI(EDITOR=true)下变红兜底。
const GUARDED_KEYS = [
  'EDITOR',
  'GIT_EDITOR',
  'GIT_SEQUENCE_EDITOR',
  'VISUAL',
  'PAGER',
  'GIT_PAGER',
  'GIT_ASKPASS',
  'SSH_ASKPASS',
  'GIT_SSH',
  'GIT_SSH_COMMAND',
  'GIT_PROXY_COMMAND',
  'GIT_EXEC_PATH',
  'GIT_EXTERNAL_DIFF',
  'GIT_TEMPLATE_DIR',
  'PREFIX',
  'GIT_CONFIG',
  'GIT_CONFIG_GLOBAL',
  'GIT_CONFIG_SYSTEM',
];

describe('vendor/git: stripGuardedEnv', () => {
  it('removes every guarded key regardless of case', () => {
    const env: NodeJS.ProcessEnv = {};
    for (const key of GUARDED_KEYS) env[key] = `hostile-${key}`;
    // 大小写混合形态同样必须命中(守卫按小写比较);经变量访问避开 useLiteralKeys
    const mixedCaseKey = 'EdItOr' as const;
    env[mixedCaseKey] = 'vi';

    const kept = stripGuardedEnv(env);
    for (const key of [...GUARDED_KEYS, mixedCaseKey]) {
      expect(kept[key], `${key} must be stripped`).toBeUndefined();
    }
  });

  it('strips git_config_* wildcards (count/key/value forms)', () => {
    const kept = stripGuardedEnv({
      GIT_CONFIG_COUNT: '2',
      GIT_CONFIG_KEY_0: 'url.https://example.com/.insteadOf',
      GIT_CONFIG_VALUE_0: 'https://example.com/',
      git_config_system: '/etc/gitconfig',
    });
    expect(kept.GIT_CONFIG_COUNT).toBeUndefined();
    expect(kept.GIT_CONFIG_KEY_0).toBeUndefined();
    expect(kept.GIT_CONFIG_VALUE_0).toBeUndefined();
    expect(kept.git_config_system).toBeUndefined();
  });

  it('keeps operational env needed by clone (PATH/HOME/GIT_TERMINAL_PROMPT/GIT_LFS_SKIP_SMUDGE)', () => {
    const kept = stripGuardedEnv({
      PATH: '/usr/bin:/bin',
      HOME: '/home/u',
      GIT_TERMINAL_PROMPT: '0',
      GIT_LFS_SKIP_SMUDGE: '1',
    });
    expect(kept.PATH).toBe('/usr/bin:/bin');
    expect(kept.HOME).toBe('/home/u');
    expect(kept.GIT_TERMINAL_PROMPT).toBe('0');
    expect(kept.GIT_LFS_SKIP_SMUDGE).toBe('1');
  });
});

describe('vendor/git: clone survives hostile host env (C1 regression)', () => {
  let work: string | undefined;
  let repo: string;
  // 本 describe 内所有用例都在「宿主环境被守卫键污染」的前提下运行。
  const savedEnv: Record<string, string | undefined> = {};
  for (const key of [...GUARDED_KEYS, 'GIT_CONFIG_COUNT']) {
    savedEnv[key] = process.env[key];
    process.env[key] =
      key === 'GIT_CONFIG_COUNT' ? '1' : key === 'EDITOR' ? 'true' : `/hostile/${key}`;
  }

  afterAll(async () => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    if (work !== undefined) await rm(work, { recursive: true, force: true });
  });
  // 夹具的直调 git 不吃污染 env(真 git 也会被悬空的 GIT_CONFIG_COUNT 卡住);
  // 被测对象是 simple-git 的克隆路径,不是 git 本身。
  const fixtureEnv = stripGuardedEnv({ ...process.env });

  function run(args: string[]): void {
    execFileSync('git', ['-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', ...args], {
      stdio: 'pipe',
      env: fixtureEnv,
    });
  }

  it('clones a local file:// repo with every guarded variable set in the host env', async () => {
    work = mkdtempSync(join(tmpdir(), 'skill-switch-git-env-'));
    repo = join(work, 'good-repo');
    await mkdir(repo, { recursive: true });
    await writeFile(
      join(repo, 'SKILL.md'),
      '---\nname: env-probe\ndescription: hostile env clone probe.\n---\nbody\n',
    );
    execFileSync('git', ['init', '-q', repo], { stdio: 'pipe', env: fixtureEnv });
    run(['add', '-A']);
    run(['commit', '-qm', 'init']);

    const tempDir = await cloneRepo(`file://${repo}`);
    expect(tempDir).toContain('skills-');
    await cleanupTempDir(tempDir);
  });
});
