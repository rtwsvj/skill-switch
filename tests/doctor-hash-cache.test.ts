// P2-1:doctor 文件夹哈希缓存。验证三件事且都不改变 doctor 的漂移结论:
//   (a) 未改动的 home 上第二次 runDoctor 命中缓存(缓存文件落了正确签名;第二次报告一致;
//       且昂贵的 computeSkillFolderHash 第二次不再被调用)。
//   (b) 改动 skill 目录里的文件 → 该条目签名失效,下次仍能正确检出 content-drift。
//   (c) 缓存文件损坏 / 缺失都不会打断 doctor(报告依旧正确)。
import { mkdtempSync, readFileSync, existsSync, statSync, chmodSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as localLock from '../src/vendor/vercel-skills/local-lock.ts';
import { computeSkillFolderHash } from '../src/vendor/vercel-skills/local-lock.ts';
import { runDoctor } from '../src/core/doctor.ts';
import {
  computeStatSignature,
  getDoctorHashCachePath,
  type DoctorHashCacheFile,
} from '../src/core/doctor-hash-cache.ts';
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

/** 装好一个 enabled+已锁+磁盘一致的 skill,返回其磁盘目标路径。 */
async function setupCleanSkill(name: string): Promise<string> {
  const src = await makeSkill(name);
  const decl: SkillsDeclarationFile = {
    version: 1,
    skills: [{ name, source: src, agents: ['claude-code'], enabled: true, mode: 'copy' }],
  };
  await writeDecl(decl);
  await applySync(home, decl);
  const target = join(home, '.claude', 'skills', name);
  await upsertLockEntries(getSkillsLockPath(home), [
    {
      name, agent: 'claude-code', source: src, sourceType: 'local',
      sha256: await computeSkillFolderHash(target), mode: 'copy',
    },
  ]);
  return target;
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'skill-switch-doctorcache-'));
  store = join(home, '.skill-switch', 'store');
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('P2-1 doctor folder-hash cache', () => {
  it('(a) second run on an unchanged home reuses the cache and skips the expensive hash', async () => {
    const target = await setupCleanSkill('beta');

    const first = await runDoctor(home);
    expect(first.clean).toBe(true);

    // 缓存文件已落盘,且记录了该目标的廉价 stat 签名(签名等于现算的 stat 签名)。
    const cachePath = getDoctorHashCachePath(home);
    expect(existsSync(cachePath)).toBe(true);
    const cache = JSON.parse(readFileSync(cachePath, 'utf8')) as DoctorHashCacheFile;
    expect(cache.entries[target]).toBeDefined();
    expect(cache.entries[target]!.signature).toBe(await computeStatSignature(target));

    // 第二次:监视昂贵的 computeSkillFolderHash —— 命中缓存应使其零调用,且报告逐字段一致。
    const spy = vi.spyOn(localLock, 'computeSkillFolderHash');
    const second = await runDoctor(home);
    expect(spy).not.toHaveBeenCalled();
    expect(second).toEqual(first);
  });

  it('(b) editing a file invalidates the entry and drift is still detected next run', async () => {
    const target = await setupCleanSkill('beta');

    const first = await runDoctor(home); // 建立缓存
    expect(first.clean).toBe(true);

    // 篡改磁盘内容(改 size 也改 mtime)→ 签名变 → 缓存失效 → 重算真哈希 → 检出 content-drift。
    await writeFile(join(target, 'SKILL.md'), 'TAMPERED CONTENT IS LONGER THAN BEFORE\n');

    const spy = vi.spyOn(localLock, 'computeSkillFolderHash');
    const second = await runDoctor(home);
    expect(spy).toHaveBeenCalled(); // 签名失效 → 走了昂贵路径
    expect(second.clean).toBe(false);
    const drift = second.findings.find((f) => f.kind === 'content-drift');
    expect(drift).toMatchObject({ name: 'beta', agent: 'claude-code' });
  });

  it('(d) hardened: the stat signature is ctime-sensitive (a ctime-only change is caught)', async () => {
    // 确定性地证明签名含 ctime:chmod 只刷新 ctime(inode 元数据变更),size/mtime/内容都不动。
    // 这模拟"瞒过 size+mtime 的刻意篡改痕迹"——修复前签名不变(漏判),修复后签名变(检出)。
    const dir = join(home, 'sigdir');
    await mkdir(dir, { recursive: true });
    const f = join(dir, 'a.txt');
    await writeFile(f, 'identical-bytes');

    const before = statSync(f);
    const sig1 = await computeStatSignature(dir);

    chmodSync(f, before.mode ^ 0o100); // 翻转 owner-execute 位 → 只动 ctime
    const after = statSync(f);
    expect(after.size).toBe(before.size); // size 未变
    expect(after.mtimeMs).toBe(before.mtimeMs); // mtime 未变
    expect(after.ctimeMs).not.toBe(before.ctimeMs); // 仅 ctime 变

    const sig2 = await computeStatSignature(dir);
    expect(sig2).not.toBe(sig1); // 签名含 ctime → 变(若仅 size+mtime,签名不变 → 会漏判)
  });

  it('(c) a malformed cache file does not break doctor and the report stays correct', async () => {
    const target = await setupCleanSkill('beta');
    await mkdir(join(home, '.skill-switch'), { recursive: true });
    await writeFile(getDoctorHashCachePath(home), '{ this is not valid json');

    // 损坏缓存被容忍(当空重建),报告仍正确,且本次会用真哈希算并重新落盘干净缓存。
    const report = await runDoctor(home);
    expect(report.clean).toBe(true);
    expect(report.checked).toEqual({ declared: 1, locked: 1 });

    const cache = JSON.parse(readFileSync(getDoctorHashCachePath(home), 'utf8')) as DoctorHashCacheFile;
    expect(cache.entries[target]).toBeDefined();
  });

  it('(c) an absent cache file does not break doctor', async () => {
    await setupCleanSkill('beta');
    expect(existsSync(getDoctorHashCachePath(home))).toBe(false);

    const report = await runDoctor(home);
    expect(report.clean).toBe(true);
  });
});
