// S4.1:声明驱动 sync 引擎 — 终态一致 + 幂等(二跑零变更)+ 不动未声明目录。
import { chmodSync, mkdtempSync } from 'node:fs';
import { lstat, mkdir, readFile, readlink, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  applySync,
  planSync,
  readDeclaration,
  type SkillsDeclarationFile,
} from '../src/core/sync.ts';

let home: string;
let store: string;

async function makeSkill(name: string, body = `Body of ${name}.`): Promise<string> {
  const dir = join(store, name);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: sync fixture ${name}.\n---\n\n${body}\n`,
  );
  return dir;
}

function decl(skills: SkillsDeclarationFile['skills']): SkillsDeclarationFile {
  return { version: 1, skills };
}

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'skill-switch-sync-'));
  store = join(home, '.skill-switch', 'store');
  await makeSkill('alpha');
  await makeSkill('beta');
});

describe('core/sync', () => {
  it('creates declared targets (symlink + copy, multi-agent) to match declaration', async () => {
    const d = decl([
      { name: 'alpha', source: join(store, 'alpha'), agents: ['claude-code'], enabled: true, mode: 'symlink' },
      { name: 'beta', source: join(store, 'beta'), agents: ['claude-code', 'gemini-cli'], enabled: true, mode: 'copy' },
    ]);
    const { actions } = await applySync(home, d);
    expect(actions.filter((a) => a.kind === 'create')).toHaveLength(3);

    const alphaSt = await lstat(join(home, '.claude', 'skills', 'alpha'));
    expect(alphaSt.isSymbolicLink()).toBe(true);
    expect(await readlink(join(home, '.claude', 'skills', 'alpha'))).toBe(join(store, 'alpha'));
    await lstat(join(home, '.claude', 'skills', 'beta'));
    await lstat(join(home, '.gemini', 'skills', 'beta'));
  });

  it('is idempotent: second run is all noop', async () => {
    const d = decl([
      { name: 'alpha', source: join(store, 'alpha'), agents: ['claude-code'], enabled: true, mode: 'symlink' },
      { name: 'beta', source: join(store, 'beta'), agents: ['claude-code', 'gemini-cli'], enabled: true, mode: 'copy' },
    ]);
    await applySync(home, d);
    const { actions } = await applySync(home, d);
    expect(actions.every((a) => a.kind === 'noop')).toBe(true);
    expect(actions).toHaveLength(3);
  });

  it('removes targets when a skill is disabled', async () => {
    const enabled = decl([
      { name: 'beta', source: join(store, 'beta'), agents: ['claude-code', 'gemini-cli'], enabled: true, mode: 'copy' },
    ]);
    await applySync(home, enabled);

    const disabled = decl([
      { name: 'beta', source: join(store, 'beta'), agents: ['claude-code', 'gemini-cli'], enabled: false, mode: 'copy' },
    ]);
    const { actions } = await applySync(home, disabled);
    expect(actions.filter((a) => a.kind === 'remove')).toHaveLength(2);
    await expect(lstat(join(home, '.claude', 'skills', 'beta'))).rejects.toThrow();

    // 再跑一次:目标已不存在 → noop(remove 也幂等)
    const again = await applySync(home, disabled);
    expect(again.actions.every((a) => a.kind === 'noop')).toBe(true);
  });

  it('repairs a tampered copy target (replace) and restores content', async () => {
    const d = decl([
      { name: 'beta', source: join(store, 'beta'), agents: ['claude-code'], enabled: true, mode: 'copy' },
    ]);
    await applySync(home, d);
    const target = join(home, '.claude', 'skills', 'beta', 'SKILL.md');
    await writeFile(target, 'TAMPERED\n');

    const { actions } = await applySync(home, d);
    expect(actions.map((a) => a.kind)).toEqual(['replace']);
    expect(await readFile(target, 'utf8')).toContain('Body of beta');
  });

  it('F3: uses per-agent source/mode overrides when present', async () => {
    const claudeSource = await makeSkill('shared-claude-source', 'Claude source body.');
    const geminiSource = await makeSkill('shared-gemini-source', 'Gemini source body.');
    const d = decl([
      {
        name: 'shared',
        source: claudeSource,
        agents: ['claude-code', 'gemini-cli'],
        enabled: true,
        mode: 'copy',
        agentSources: {
          'gemini-cli': { source: geminiSource, mode: 'copy' },
        },
      },
    ]);

    await applySync(home, d);
    expect(await readFile(join(home, '.claude', 'skills', 'shared', 'SKILL.md'), 'utf8')).toContain('Claude source body.');
    expect(await readFile(join(home, '.gemini', 'skills', 'shared', 'SKILL.md'), 'utf8')).toContain('Gemini source body.');

    await writeFile(join(home, '.gemini', 'skills', 'shared', 'SKILL.md'), 'TAMPERED\n');
    const { actions } = await applySync(home, d);
    expect(actions.find((a) => a.agent === 'gemini-cli')?.kind).toBe('replace');
    expect(await readFile(join(home, '.gemini', 'skills', 'shared', 'SKILL.md'), 'utf8')).toContain('Gemini source body.');
  });

  it('repairs a symlink pointing at the wrong place', async () => {
    const d = decl([
      { name: 'alpha', source: join(store, 'alpha'), agents: ['claude-code'], enabled: true, mode: 'symlink' },
    ]);
    await applySync(home, d);
    // 把链接指向别处
    const target = join(home, '.claude', 'skills', 'alpha');
    await rm(target, { force: true });
    const { symlink } = await import('node:fs/promises');
    await symlink(join(store, 'beta'), target, 'dir');

    const { actions } = await applySync(home, d);
    expect(actions.map((a) => a.kind)).toEqual(['replace']);
    expect(await readlink(target)).toBe(join(store, 'alpha'));
  });

  it('M0-5.4: a correct relative symlink is in-sync (no spurious replace)', async () => {
    const d = decl([
      { name: 'alpha', source: join(store, 'alpha'), agents: ['claude-code'], enabled: true, mode: 'symlink' },
    ]);
    await applySync(home, d);
    const target = join(home, '.claude', 'skills', 'alpha');
    await rm(target, { force: true });
    const { symlink } = await import('node:fs/promises');
    // 手动建一个【相对】symlink,正确指向 source(相对 symlink 所在目录)
    await symlink(relative(dirname(target), join(store, 'alpha')), target, 'dir');

    const { actions } = await applySync(home, d);
    expect(actions.map((a) => a.kind)).toEqual(['noop']);
  });

  it('M0-5.4: does not crash on a self-referential symlink loop', async () => {
    const d = decl([
      { name: 'alpha', source: join(store, 'alpha'), agents: ['claude-code'], enabled: true, mode: 'symlink' },
    ]);
    const target = join(home, '.claude', 'skills', 'alpha');
    const { mkdir: mkdirp, symlink } = await import('node:fs/promises');
    await mkdirp(dirname(target), { recursive: true });
    await symlink(target, target, 'dir'); // 自指环
    const { actions } = await applySync(home, d); // 不跟随 → 不应崩溃
    expect(actions.map((a) => a.kind)).toEqual(['replace']);
    expect(await readlink(target)).toBe(join(store, 'alpha'));
  });

  it('never touches undeclared dirs in the agent skills dir', async () => {
    await mkdir(join(home, '.claude', 'skills', 'manual-skill'), { recursive: true });
    await writeFile(join(home, '.claude', 'skills', 'manual-skill', 'SKILL.md'), 'mine\n');

    const d = decl([
      { name: 'alpha', source: join(store, 'alpha'), agents: ['claude-code'], enabled: true, mode: 'symlink' },
    ]);
    await applySync(home, d);
    expect(await readFile(join(home, '.claude', 'skills', 'manual-skill', 'SKILL.md'), 'utf8')).toBe('mine\n');
  });

  it('fails fast on an unknown agent in the declaration', async () => {
    const d = decl([
      { name: 'alpha', source: join(store, 'alpha'), agents: ['no-such' as never], enabled: true, mode: 'symlink' },
    ]);
    await expect(applySync(home, d)).rejects.toThrow(/agent/i);
  });

  it('readDeclaration returns an empty declaration for a missing file', async () => {
    expect(await readDeclaration(join(home, 'nope.json'))).toEqual({ version: 1, skills: [] });
  });

  // AUDIT-SYNC1:inspectTarget 用 catch {} 吞掉 lstat 的所有异常(含 EACCES),
  // 一律返回 {state:'missing'} → planOne 对 enabled 声明返回 create → applySync 先
  // rm -rf + 重拷,把"读不了"误判成"不存在",在 agent 目录权限异常时破坏既有内容。
  // 修复后:只有 ENOENT 算 missing,其余错误(EACCES 等)必须 fail-loud。
  it('AUDIT-SYNC1: planSync fails loud when target parent is unreadable (EACCES)', async () => {
    const d = decl([
      { name: 'beta', source: join(store, 'beta'), agents: ['claude-code'], enabled: true, mode: 'copy' },
    ]);
    await applySync(home, d); // 先正常落地
    const target = join(home, '.claude', 'skills', 'beta');
    await lstat(target); // 落地确认

    // 让目标的父目录(.claude/skills)失去 x 权限 → lstat(target) 抛 EACCES。
    // 旧行为:inspectTarget 吞掉 EACCES,planSync 返回 [{kind:'create',...}] 误判目标缺失。
    // 新行为:planSync 必须把 EACCES 透传(fail-loud),不能返回误导性的 plan。
    const skillsDir = join(home, '.claude', 'skills');
    chmodSync(skillsDir, 0o000);
    try {
      await expect(planSync(home, d)).rejects.toThrow();
    } finally {
      chmodSync(skillsDir, 0o755);
    }
  });

  it('AUDIT-SYNC1: throws when an enabled declaration points at a missing source', async () => {
    const d = decl([
      {
        name: 'ghost',
        source: join(store, 'does-not-exist'),
        agents: ['claude-code'],
        enabled: true,
        mode: 'copy',
      },
    ]);
    // planSync 与 applySync 都应在写动作前拒绝,且不创建任何 agent 目录。
    await expect(planSync(home, d)).rejects.toThrow(/声明的 skill 源不存在/);
    await expect(applySync(home, d)).rejects.toThrow(/声明的 skill 源不存在/);
  });

  // R26-a 回归测试组:声明边界 + 快照前置 + 幂等

  it('R26-a: 空声明(skills 为空数组)→ planSync 返回空,applySync 无磁盘写入', async () => {
    // 磁盘上预存一个手动目录,确认它不被动
    const manualDir = join(home, '.claude', 'skills', 'undeclared');
    await mkdir(manualDir, { recursive: true });
    await writeFile(join(manualDir, 'README.md'), '手动装的\n');

    const d = decl([]);
    const plan = await planSync(home, d);
    expect(plan).toHaveLength(0);

    const { actions } = await applySync(home, d);
    expect(actions).toHaveLength(0);

    // 未声明目录未被触碰
    expect(await readFile(join(manualDir, 'README.md'), 'utf8')).toBe('手动装的\n');
  });

  it('R26-a: 损坏的 JSON 声明 → readDeclaration 抛 StateFileError,不执行任何写操作', async () => {
    const badPath = join(home, '.skill-switch', 'skills.json');
    await mkdir(dirname(badPath), { recursive: true });
    await writeFile(badPath, '{ "version": 1, "skills": [BROKEN}');

    const { StateFileError } = await import('../src/core/state-io.ts');
    await expect(readDeclaration(badPath)).rejects.toThrow(StateFileError);
  });

  it('R26-a: 声明结构非法(skills 不是数组)→ readDeclaration 抛错,不执行写操作', async () => {
    const badPath = join(home, '.skill-switch', 'skills.json');
    await mkdir(dirname(badPath), { recursive: true });
    await writeFile(badPath, JSON.stringify({ version: 1, skills: 'not-an-array' }));

    await expect(readDeclaration(badPath)).rejects.toThrow(/结构非法/);
  });

  it('R26-a: 被禁用的 skill 在磁盘上存在 → applySync 将其 remove,不触碰其他目录', async () => {
    // 先正常落地 alpha + beta
    const enabledDecl = decl([
      { name: 'alpha', source: join(store, 'alpha'), agents: ['claude-code'], enabled: true, mode: 'symlink' },
      { name: 'beta', source: join(store, 'beta'), agents: ['claude-code'], enabled: true, mode: 'copy' },
    ]);
    await applySync(home, enabledDecl);

    // 禁用 alpha;beta 仍 enabled
    const partialDisable = decl([
      { name: 'alpha', source: join(store, 'alpha'), agents: ['claude-code'], enabled: false, mode: 'symlink' },
      { name: 'beta', source: join(store, 'beta'), agents: ['claude-code'], enabled: true, mode: 'copy' },
    ]);
    const { actions } = await applySync(home, partialDisable);

    // alpha 应被 remove
    expect(actions.find((a) => a.name === 'alpha')?.kind).toBe('remove');
    await expect(lstat(join(home, '.claude', 'skills', 'alpha'))).rejects.toThrow();

    // beta 仍在位(noop)
    expect(actions.find((a) => a.name === 'beta')?.kind).toBe('noop');
    await lstat(join(home, '.claude', 'skills', 'beta'));
  });

  it('R26-a: 已在位的 skill 只在声明中 disabled(目标不存在)→ remove 是 noop,不崩溃', async () => {
    // skill 从未安装过但声明 disabled:应 noop
    const d = decl([
      { name: 'alpha', source: join(store, 'alpha'), agents: ['claude-code'], enabled: false, mode: 'copy' },
    ]);
    const { actions } = await applySync(home, d);
    expect(actions).toHaveLength(1);
    expect(actions[0]?.kind).toBe('noop');
  });

  it('R26-a: 未声明的磁盘目录在任何操作下都不被删除(安全护栏)', async () => {
    // 磁盘上预存两个手动目录
    const userSkillA = join(home, '.claude', 'skills', 'user-skill-a');
    const userSkillB = join(home, '.claude', 'skills', 'user-skill-b');
    await mkdir(userSkillA, { recursive: true });
    await mkdir(userSkillB, { recursive: true });
    await writeFile(join(userSkillA, 'SKILL.md'), 'A\n');
    await writeFile(join(userSkillB, 'SKILL.md'), 'B\n');

    // sync 声明里完全没有这两个 skill
    const d = decl([
      { name: 'alpha', source: join(store, 'alpha'), agents: ['claude-code'], enabled: true, mode: 'symlink' },
    ]);
    await applySync(home, d);

    // 未声明目录完整保留
    expect(await readFile(join(userSkillA, 'SKILL.md'), 'utf8')).toBe('A\n');
    expect(await readFile(join(userSkillB, 'SKILL.md'), 'utf8')).toBe('B\n');
  });

  it('R26-a: 缺失的声明文件 → readDeclaration 返回空声明(不抛错),applySync 是 noop', async () => {
    // skills.json 根本不存在 → 等价于"空声明"
    const nonExistentPath = join(home, '.skill-switch', 'skills.json');
    const d = await readDeclaration(nonExistentPath);
    expect(d).toEqual({ version: 1, skills: [] });

    const { actions } = await applySync(home, d);
    expect(actions).toHaveLength(0);
  });

  it('R26-a: 不可读源(enabled=false)时不检查 source 存在性 → planSync 正常返回', async () => {
    // disabled skill 的源不存在也 OK:planOne 不会检查 source,因为结果是 remove/noop
    const d = decl([
      {
        name: 'ghost',
        source: join(store, 'does-not-exist'),
        agents: ['claude-code'],
        enabled: false, // 禁用
        mode: 'copy',
      },
    ]);
    // 不应抛错:disabled 路径不需要 source 存在
    const plan = await planSync(home, d);
    expect(plan).toHaveLength(1);
    // 目标也不存在 → noop(disabled,目标本就不存在)
    expect(plan[0]?.kind).toBe('noop');
  });
});
