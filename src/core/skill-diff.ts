// D2:内容漂移的「改了什么」—— 对 copy 模式技能,把磁盘上的技能目录与 store 里的耐久副本
// (install 时落的「应该是什么」)逐文件对比,产出 added / removed / modified 列表。
// symlink 模式磁盘即源,没有独立参照,标 comparable=false。纯只读,不改任何文件。
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { getAgentSkillsLocations, resolveGlobalSkillsDir } from './paths.ts';
import type { AgentType } from '../vendor/vercel-skills/types.ts';

export type SkillFileDiffStatus = 'added' | 'removed' | 'modified';

export interface SkillFileDiff {
  /** 相对技能目录的路径 */
  path: string;
  status: SkillFileDiffStatus;
}

export interface SkillDiff {
  agent: AgentType;
  name: string;
  /** 能否对比:false 表示没有 store 参照(symlink 模式 / 非 copy 安装 / 目录缺失)。 */
  comparable: boolean;
  reason?: string;
  diskDir?: string;
  storeDir?: string;
  files: SkillFileDiff[];
}

function storeDirFor(home: string, agent: AgentType, name: string): string {
  return join(home, '.skill-switch', 'store', agent, name);
}

function diskDirFor(home: string, agent: AgentType, name: string): string | undefined {
  const location = getAgentSkillsLocations().find((l) => l.agent === agent);
  if (!location) return undefined;
  return join(resolveGlobalSkillsDir(home, location), name);
}

/** 递归列出目录下所有文件 → 相对路径 → 内容 Buffer。目录不存在则空。 */
async function listFiles(dir: string): Promise<Map<string, Buffer>> {
  const out = new Map<string, Buffer>();
  if (!existsSync(dir)) return out;
  async function walk(current: string): Promise<void> {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        out.set(relative(dir, full), await readFile(full));
      }
    }
  }
  await walk(dir);
  return out;
}

export async function diffSkill(home: string, agent: AgentType, name: string): Promise<SkillDiff> {
  const diskDir = diskDirFor(home, agent, name);
  const storeDir = storeDirFor(home, agent, name);
  const base: SkillDiff = { agent, name, comparable: false, files: [] };

  if (!diskDir || !existsSync(diskDir)) {
    return { ...base, reason: '磁盘上找不到该技能目录' };
  }
  if (!existsSync(storeDir)) {
    return { ...base, reason: '没有 store 参照(symlink 模式或非 copy 安装,无法逐行对比)' };
  }

  const disk = await listFiles(diskDir);
  const store = await listFiles(storeDir);
  const files: SkillFileDiff[] = [];

  for (const [path, diskContent] of disk) {
    const storeContent = store.get(path);
    if (storeContent === undefined) {
      files.push({ path, status: 'added' }); // 磁盘有、参照没有 = 新增
    } else if (!diskContent.equals(storeContent)) {
      files.push({ path, status: 'modified' });
    }
  }
  for (const path of store.keys()) {
    if (!disk.has(path)) files.push({ path, status: 'removed' }); // 参照有、磁盘没 = 删除
  }

  files.sort((a, b) => a.path.localeCompare(b.path));
  return { agent, name, comparable: true, diskDir, storeDir, files };
}
