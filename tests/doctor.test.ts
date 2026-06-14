// S6.1:doctor 三方校验 — skills.json(声明)vs skills.lock vs 磁盘实况。
// 四类漂移在同一个 fixture home 各埋一个,逐一检出;另有全对齐的 clean 用例。
import { mkdtempSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { computeSkillFolderHash } from '../src/vendor/vercel-skills/local-lock.ts';
import { runDoctor } from '../src/core/doctor.ts';
import { getSkillsLockPath, upsertLockEntries } from '../src/core/lock.ts';
import { applySync, getSkillsJsonPath, type SkillsDeclarationFile } from '../src/core/sync.ts';

let home: string;
let store: string;

async function makeSkill(name: string): Promise<string> {
  const dir = join(store, name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: d ${name}.\n---\nB.\n`);
  return dir;
}

async function writeDecl(decl: SkillsDeclarationFile): Promise<void> {
  await mkdir(join(home, '.skill-switch'), { recursive: true });
  await writeFile(getSkillsJsonPath(home), `${JSON.stringify(decl, null, 2)}\n`);
}

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'skill-switch-doctor-'));
  store = join(home, '.skill-switch', 'store');
});

describe('core/doctor 四类漂移', () => {
  it('missing / content-drift / stale-lock / extra-locked 各被准确检出', async () => {
    const alpha = await makeSkill('alpha'); // 声明了但从未安装 → missing
    const beta = await makeSkill('beta');   // 安装+锁定后被篡改 → content-drift
    const gamma = await makeSkill('gamma'); // 安装了但锁里没有 → stale-lock
    void alpha;

    const decl: SkillsDeclarationFile = {
      version: 1,
      skills: [
        { name: 'alpha', source: join(store, 'alpha'), agents: ['claude-code'], enabled: true, mode: 'copy' },
        { name: 'beta', source: beta, agents: ['claude-code'], enabled: true, mode: 'copy' },
        { name: 'gamma', source: gamma, agents: ['claude-code'], enabled: true, mode: 'copy' },
      ],
    };
    await writeDecl(decl);

    // 只安装 beta 和 gamma(alpha 留作缺装)
    await applySync(home, { version: 1, skills: decl.skills.filter((s) => s.name !== 'alpha') });

    // 锁:beta 记当下正确哈希;delta 是声明里没有的孤儿条目 → extra-locked
    const betaTarget = join(home, '.claude', 'skills', 'beta');
    await upsertLockEntries(getSkillsLockPath(home), [
      {
        name: 'beta', agent: 'claude-code', source: beta, sourceType: 'local',
        sha256: await computeSkillFolderHash(betaTarget), mode: 'copy',
      },
      {
        name: 'delta', agent: 'claude-code', source: '/gone', sourceType: 'local',
        sha256: 'deadbeef', mode: 'copy',
      },
    ]);

    // 篡改 beta 的磁盘内容 → 与锁内哈希漂移
    await writeFile(join(betaTarget, 'SKILL.md'), 'TAMPERED\n');

    const report = await runDoctor(home);
    const byKind = new Map(report.findings.map((f) => [f.kind, f]));

    expect(report.findings).toHaveLength(4);
    expect(byKind.get('missing')).toMatchObject({ name: 'alpha', agent: 'claude-code' });
    expect(byKind.get('content-drift')).toMatchObject({ name: 'beta' });
    expect(byKind.get('stale-lock')).toMatchObject({ name: 'gamma' });
    expect(byKind.get('extra-locked')).toMatchObject({ name: 'delta' });
    expect(report.clean).toBe(false);
  });

  it('全对齐的 home 报 clean', async () => {
    const beta = await makeSkill('beta');
    const decl: SkillsDeclarationFile = {
      version: 1,
      skills: [{ name: 'beta', source: beta, agents: ['claude-code'], enabled: true, mode: 'copy' }],
    };
    await writeDecl(decl);
    await applySync(home, decl);
    const target = join(home, '.claude', 'skills', 'beta');
    await upsertLockEntries(getSkillsLockPath(home), [
      {
        name: 'beta', agent: 'claude-code', source: beta, sourceType: 'local',
        sha256: await computeSkillFolderHash(target), mode: 'copy',
      },
    ]);

    const report = await runDoctor(home);
    expect(report.findings).toEqual([]);
    expect(report.clean).toBe(true);
    expect(report.checked).toEqual({ declared: 1, locked: 1 });
  });

  it('disabled 声明不参与缺装判定', async () => {
    const beta = await makeSkill('beta');
    await writeDecl({
      version: 1,
      skills: [{ name: 'beta', source: beta, agents: ['claude-code'], enabled: false, mode: 'copy' }],
    });
    const report = await runDoctor(home);
    expect(report.findings.filter((f) => f.kind === 'missing')).toEqual([]);
  });

  it('JSON report includes disabled declarations so GUI can keep them visible', async () => {
    const beta = await makeSkill('beta');
    await writeDecl({
      version: 1,
      skills: [{ name: 'beta', source: beta, agents: ['claude-code'], enabled: false, mode: 'copy' }],
    });

    const report = await runDoctor(home);
    expect(report.declarations).toEqual([
      {
        name: 'beta',
        source: beta,
        agents: ['claude-code'],
        enabled: false,
        mode: 'copy',
      },
    ]);
  });
});
