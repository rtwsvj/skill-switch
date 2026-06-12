// S3.4 skills.lock:安装产物的可核验记录。
// schema 融合两个上游设计(均见 THIRD_PARTY_NOTICES.md):
//   - vercel local-lock.ts:sha256 内容哈希、"锁文件应可提交进版本库"的定位
//   - agent-skills-cli skill-lock.ts:git 来源以 commit SHA 为 version 的字段设计
// 幂等约定:不含时间戳字段;条目按 (agent, name) 排序;同源重装字节不变。
// MVP 落点是 home 级治理锚点(<home>/.skill-switch/skills.lock.json);
// 同一 schema 未来可直接用于项目级(S6 doctor 三方校验)。
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { AgentType } from '../vendor/vercel-skills/types.ts';

export interface SkillsLockEntry {
  name: string;
  agent: AgentType;
  /** 原始来源(git URL 或本地路径) */
  source: string;
  sourceType: 'git' | 'local';
  /** 请求的 ref(分支/tag),仅 git 来源 */
  ref?: string;
  /** clone 后 rev-parse HEAD,仅 git 来源 */
  commit?: string;
  /** 安装产物的内容哈希(vendor computeSkillFolderHash) */
  sha256: string;
  mode: 'copy' | 'symlink';
}

export interface SkillsLockFile {
  version: 1;
  skills: SkillsLockEntry[];
}

export function getSkillsLockPath(home: string): string {
  return join(home, '.skill-switch', 'skills.lock.json');
}

export async function readSkillsLock(lockPath: string): Promise<SkillsLockFile> {
  try {
    const raw = await readFile(lockPath, 'utf8');
    return JSON.parse(raw) as SkillsLockFile;
  } catch {
    return { version: 1, skills: [] };
  }
}

export async function writeSkillsLock(lockPath: string, lock: SkillsLockFile): Promise<void> {
  await mkdir(dirname(lockPath), { recursive: true });
  const sorted: SkillsLockFile = {
    version: lock.version,
    skills: [...lock.skills].sort((a, b) =>
      `${a.agent}|${a.name}`.localeCompare(`${b.agent}|${b.name}`),
    ),
  };
  await writeFile(lockPath, `${JSON.stringify(sorted, null, 2)}\n`);
}

/** 按 (agent, name) upsert;同键覆盖,无重复。 */
export async function upsertLockEntries(
  lockPath: string,
  entries: SkillsLockEntry[],
): Promise<SkillsLockFile> {
  const lock = await readSkillsLock(lockPath);
  const byKey = new Map(lock.skills.map((e) => [`${e.agent}|${e.name}`, e]));
  for (const entry of entries) {
    byKey.set(`${entry.agent}|${entry.name}`, entry);
  }
  const next: SkillsLockFile = { version: 1, skills: [...byKey.values()] };
  await writeSkillsLock(lockPath, next);
  return next;
}
