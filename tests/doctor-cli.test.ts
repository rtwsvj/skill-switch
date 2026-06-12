// S6.2:doctor CLI — --ci 两种退出码 + JSON 输出(真实子进程)。
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { computeSkillFolderHash } from '../src/vendor/vercel-skills/local-lock.ts';
import { getSkillsLockPath, upsertLockEntries } from '../src/core/lock.ts';
import { applySync, getSkillsJsonPath, type SkillsDeclarationFile } from '../src/core/sync.ts';

const ROOT = join(import.meta.dirname, '..');
const CLI = join(ROOT, 'src', 'cli', 'index.ts');

let home: string;

function runDoctorCli(args: string[]): { stdout: string; status: number } {
  try {
    const stdout = execFileSync(
      process.execPath,
      ['--import', 'tsx', CLI, 'doctor', '--home', home, ...args],
      { cwd: ROOT, encoding: 'utf8' },
    );
    return { stdout, status: 0 };
  } catch (err) {
    const e = err as { stdout?: string; status?: number };
    return { stdout: e.stdout ?? '', status: e.status ?? -1 };
  }
}

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'skill-switch-docli-'));
});

async function alignedHome(): Promise<void> {
  const src = join(home, '.skill-switch', 'store', 'beta');
  await mkdir(src, { recursive: true });
  await writeFile(join(src, 'SKILL.md'), '---\nname: beta\ndescription: d.\n---\nB.\n');
  const decl: SkillsDeclarationFile = {
    version: 1,
    skills: [{ name: 'beta', source: src, agents: ['claude-code'], enabled: true, mode: 'copy' }],
  };
  await mkdir(join(home, '.skill-switch'), { recursive: true });
  await writeFile(getSkillsJsonPath(home), `${JSON.stringify(decl, null, 2)}\n`);
  await applySync(home, decl);
  await upsertLockEntries(getSkillsLockPath(home), [
    {
      name: 'beta', agent: 'claude-code', source: src, sourceType: 'local',
      sha256: await computeSkillFolderHash(join(home, '.claude', 'skills', 'beta')), mode: 'copy',
    },
  ]);
}

describe('doctor CLI(真实子进程)', () => {
  it('干净 home:--ci exit 0,输出三方一致', async () => {
    await alignedHome();
    const { stdout, status } = runDoctorCli(['--ci']);
    expect(status).toBe(0);
    expect(stdout).toContain('三方一致');
  });

  it('漂移 home:--ci exit 1 且 JSON 列出 findings', async () => {
    await alignedHome();
    // 制造内容漂移
    await writeFile(join(home, '.claude', 'skills', 'beta', 'SKILL.md'), 'TAMPERED\n');

    const { stdout, status } = runDoctorCli(['--ci', '--json']);
    expect(status).toBe(1);
    const report = JSON.parse(stdout) as { clean: boolean; findings: Array<{ kind: string }> };
    expect(report.clean).toBe(false);
    expect(report.findings.map((f) => f.kind)).toContain('content-drift');
  });

  it('无 --ci 时漂移也 exit 0(只报告)', async () => {
    await alignedHome();
    await writeFile(join(home, '.claude', 'skills', 'beta', 'SKILL.md'), 'TAMPERED\n');
    const { stdout, status } = runDoctorCli([]);
    expect(status).toBe(0);
    expect(stdout).toContain('content-drift');
  });
});
