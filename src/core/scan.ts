// S1.3 scan 核心:对给定 home 根做跨 agent 的 skill 盘点。
// 纯读:本模块只有 readdir/readFile/stat,绝无写操作。
// universal 目录(.agents/skills)被多个 agent 共享——按唯一目录约定去重,
// 每条记录的 agents[] 列出按 vendor 映射能看到它的全部 agent。
import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import matter from 'gray-matter';
import type { AgentType } from '../vendor/vercel-skills/types.ts';
import { getAgentSkillsLocations, resolveGlobalSkillsDir } from './paths.ts';

export interface SkillRecord {
  /** 按 vendor 映射,哪些 agent 的全局目录指向这里 */
  agents: AgentType[];
  /** skills 目录的 home 相对约定,如 `.claude/skills` */
  relSkillsDir: string;
  /** skill 目录名 */
  dirName: string;
  /** SKILL.md 绝对路径 */
  path: string;
  /** frontmatter name(解析失败时为 undefined) */
  name?: string;
  /** frontmatter description */
  description?: string;
  /** 读取/解析失败原因;存在即坏样本,scan 本身不抛出 */
  error?: string;
}

function groupAgentsBySkillsDir(): Map<string, AgentType[]> {
  const groups = new Map<string, AgentType[]>();
  for (const location of getAgentSkillsLocations()) {
    const list = groups.get(location.relGlobalSkillsDir) ?? [];
    list.push(location.agent);
    groups.set(location.relGlobalSkillsDir, list);
  }
  return groups;
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function readSkill(
  agents: AgentType[],
  relSkillsDir: string,
  dirName: string,
  skillMdPath: string,
): Promise<SkillRecord> {
  const record: SkillRecord = { agents, relSkillsDir, dirName, path: skillMdPath };
  try {
    const raw = await readFile(skillMdPath, 'utf8');
    // 必须传 options(哪怕空对象)绕过 gray-matter 的全局缓存:
    // 坏输入第一次抛错后会污染缓存,第二次同内容直接返回空 data 不再抛错。
    const { data } = matter(raw, {});
    if (typeof data.name === 'string') record.name = data.name;
    if (typeof data.description === 'string') record.description = data.description;
  } catch (cause) {
    record.error = cause instanceof Error ? cause.message : String(cause);
  }
  return record;
}

export async function scanHome(home: string): Promise<SkillRecord[]> {
  const records: SkillRecord[] = [];

  for (const [relSkillsDir, agents] of groupAgentsBySkillsDir()) {
    const skillsDir = resolveGlobalSkillsDir(home, { agent: agents[0]!, relGlobalSkillsDir: relSkillsDir });
    if (!(await isDirectory(skillsDir))) continue;

    for (const entry of await readdir(skillsDir)) {
      const skillDir = join(skillsDir, entry);
      if (!(await isDirectory(skillDir))) continue;
      const skillMdPath = join(skillDir, 'SKILL.md');
      try {
        await stat(skillMdPath);
      } catch {
        continue; // 没有 SKILL.md 的目录不是 skill
      }
      records.push(await readSkill(agents, relSkillsDir, entry, skillMdPath));
    }
  }

  records.sort((a, b) =>
    `${a.relSkillsDir}|${a.dirName}`.localeCompare(`${b.relSkillsDir}|${b.dirName}`),
  );
  return records;
}
