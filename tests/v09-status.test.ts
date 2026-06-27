// S9.0 status 命令测试:buildStatus 纯函数 + CLI --json + 人类可读输出。
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { buildStatus } from '../src/core/status.ts';

const ROOT = join(import.meta.dirname, '..');
const BIN = join(ROOT, 'bin', 'skill-switch.mjs');

// ────────────────────────────────────────────────────────────
// Fixtures helpers
// ────────────────────────────────────────────────────────────

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'skill-switch-status-'));
});

/** 在 home 目录里创建一个最小 skill(放到 .claude/skills/<name>/SKILL.md) */
async function addDiskSkill(name: string): Promise<void> {
  const dir = join(home, '.claude', 'skills', name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: test.\n---\nBody.\n`);
}

/** 写 skills.json 声明 */
async function writeDeclaration(skills: Array<{ name: string; enabled?: boolean }>): Promise<void> {
  const dir = join(home, '.skill-switch');
  await mkdir(dir, { recursive: true });
  const skillsJsonPath = join(dir, 'skills.json');
  const decl = {
    version: 1,
    skills: skills.map((s) => ({
      name: s.name,
      source: join(home, '.claude', 'skills', s.name),
      agents: ['claude-code'],
      enabled: s.enabled ?? true,
      mode: 'copy',
    })),
  };
  await writeFile(skillsJsonPath, JSON.stringify(decl, null, 2));
}

/** 写 skills.lock.json */
async function writeLock(entries: Array<{ name: string }>): Promise<void> {
  const dir = join(home, '.skill-switch');
  await mkdir(dir, { recursive: true });
  const lock = {
    version: 1,
    skills: entries.map((e) => ({
      name: e.name,
      agent: 'claude-code',
      source: join(home, '.claude', 'skills', e.name),
      sourceType: 'local',
      sha256: 'deadbeef'.repeat(8),
      mode: 'copy',
    })),
  };
  await writeFile(join(dir, 'skills.lock.json'), JSON.stringify(lock, null, 2));
}

// ────────────────────────────────────────────────────────────
// buildStatus 纯函数测试
// ────────────────────────────────────────────────────────────

describe('buildStatus — 空 home', () => {
  it('返回全零、health=no-declaration', async () => {
    const s = await buildStatus(home);
    expect(s.onDisk).toBe(0);
    expect(s.declared).toBe(0);
    expect(s.enabled).toBe(0);
    expect(s.disabled).toBe(0);
    expect(s.locked).toBe(0);
    expect(s.agents).toEqual([]);
    expect(s.hasDeclaration).toBe(false);
    expect(s.hasLock).toBe(false);
    expect(s.health).toBe('no-declaration');
    expect(s.healthDetail).toContain('init');
  });
});

describe('buildStatus — 有磁盘 skill 但无声明', () => {
  it('onDisk > 0,health=no-declaration,agents 包含 claude-code', async () => {
    await addDiskSkill('my-skill');
    const s = await buildStatus(home);
    expect(s.onDisk).toBe(1);
    expect(s.hasDeclaration).toBe(false);
    expect(s.health).toBe('no-declaration');
    expect(s.agents).toContain('claude-code');
  });
});

describe('buildStatus — 声明 + 磁盘 + 锁全齐', () => {
  it('全都正常,health=ok', async () => {
    await addDiskSkill('alpha');
    await addDiskSkill('beta');
    await writeDeclaration([{ name: 'alpha' }, { name: 'beta', enabled: false }]);
    await writeLock([{ name: 'alpha' }]);

    const s = await buildStatus(home);
    expect(s.onDisk).toBe(2);
    expect(s.declared).toBe(2);
    expect(s.enabled).toBe(1);
    expect(s.disabled).toBe(1);
    expect(s.locked).toBe(1);
    expect(s.hasDeclaration).toBe(true);
    expect(s.hasLock).toBe(true);
    expect(s.health).toBe('ok');
  });
});

describe('buildStatus — 漂移:声明 enabled > 锁条目', () => {
  it('health=drifted, detail 提示跑 doctor', async () => {
    await addDiskSkill('alpha');
    await addDiskSkill('beta');
    await writeDeclaration([{ name: 'alpha' }, { name: 'beta' }]);
    // 锁只记了 alpha,beta 没有锁条目
    await writeLock([{ name: 'alpha' }]);

    const s = await buildStatus(home);
    expect(s.enabled).toBe(2);
    expect(s.locked).toBe(1);
    expect(s.health).toBe('drifted');
    expect(s.healthDetail).toContain('doctor');
  });
});

// ────────────────────────────────────────────────────────────
// CLI --json 形状
// ────────────────────────────────────────────────────────────

describe('status --json', () => {
  it('输出合法 JSON,包含必要字段', () => {
    const out = execFileSync(BIN, ['status', '--home', home, '--json'], {
      cwd: ROOT,
      encoding: 'utf8',
    });
    const parsed = JSON.parse(out) as Record<string, unknown>;
    expect(parsed).toHaveProperty('onDisk');
    expect(parsed).toHaveProperty('declared');
    expect(parsed).toHaveProperty('enabled');
    expect(parsed).toHaveProperty('disabled');
    expect(parsed).toHaveProperty('locked');
    expect(parsed).toHaveProperty('agents');
    expect(parsed).toHaveProperty('health');
    expect(parsed).toHaveProperty('healthDetail');
    expect(parsed).toHaveProperty('hasDeclaration');
    expect(parsed).toHaveProperty('hasLock');
    // 空 home:all zeros
    expect(parsed.onDisk).toBe(0);
    expect(parsed.health).toBe('no-declaration');
  });
});

// ────────────────────────────────────────────────────────────
// CLI 人类可读输出
// ────────────────────────────────────────────────────────────

describe('status 人类可读输出', () => {
  it('空 home 打印提示安装 + 建议命令', () => {
    const out = execFileSync(BIN, ['status', '--home', home], {
      cwd: ROOT,
      encoding: 'utf8',
    });
    // 应包含技能计数
    expect(out).toMatch(/磁盘\s+0\s+个/);
    // 应包含 install 或 packs suggest 提示
    expect(out).toMatch(/install|packs suggest/);
  });

  it('有 skill 时输出包含 agent 名称和健康状态', async () => {
    await addDiskSkill('demo');
    await writeDeclaration([{ name: 'demo' }]);
    await writeLock([{ name: 'demo' }]);

    const out = execFileSync(BIN, ['status', '--home', home], {
      cwd: ROOT,
      encoding: 'utf8',
    });
    // agent 列表
    expect(out).toContain('claude-code');
    // 技能计数
    expect(out).toMatch(/磁盘\s+1\s+个/);
    // 健康
    expect(out).toMatch(/✓/);
  });
});
