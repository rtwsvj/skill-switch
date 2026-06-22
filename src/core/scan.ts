// S1.3 scan 核心:对给定 home 根做跨 agent 的 skill 盘点。
// 纯读:本模块只有 readdir/readFile/stat,绝无写操作。
// universal 目录(.agents/skills)被多个 agent 共享——按唯一目录约定去重,
// 每条记录的 agents[] 列出按 vendor 映射能看到它的全部 agent。
//
// R29-a 优化:减少每 skill 的冗余 syscall。
//   改前:readdir + stat(skillDir) + stat(SKILL.md) + readFile(SKILL.md) = 3 次/skill
//   改后:readdir({withFileTypes}) + readFile(SKILL.md) = 1 次/skill
//   stat(skillDir) 由 withFileTypes 免费获得;stat(SKILL.md) 合并进 readFile 的错误处理(ENOENT→skip)。
//   行为完全一致:不存在 SKILL.md 的目录继续被跳过,内容解析错误继续记 error 字段。
import { readFile, readdir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
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
  /** skill 目录绝对路径(即含 SKILL.md 的目录) */
  dir: string;
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

// R29-a:isDirectory 保留仅用于 skillsDir 根目录存在性检查(少数目录,无需优化)。
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
  skillDir: string,
): Promise<SkillRecord | null> {
  const dir = resolve(skillDir);
  const skillMdPath = join(dir, 'SKILL.md');
  const record: SkillRecord = { agents, relSkillsDir, dirName, dir, path: skillMdPath };
  try {
    const raw = await readFile(skillMdPath, 'utf8');
    // 必须传 options(哪怕空对象)绕过 gray-matter 的全局缓存:
    // 坏输入第一次抛错后会污染缓存,第二次同内容直接返回空 data 不再抛错。
    const { data } = matter(raw, {});
    if (typeof data.name === 'string') record.name = data.name;
    if (typeof data.description === 'string') record.description = data.description;
  } catch (cause) {
    // R29-a:SKILL.md 不存在(ENOENT)→ 不是 skill,跳过;其它错误→ 记 error 字段,与改前行为一致。
    const code = (cause as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    record.error = cause instanceof Error ? cause.message : String(cause);
  }
  return record;
}

export async function scanHome(home: string): Promise<SkillRecord[]> {
  const records: SkillRecord[] = [];

  for (const [relSkillsDir, agents] of groupAgentsBySkillsDir()) {
    const skillsDir = resolveGlobalSkillsDir(home, { agent: agents[0]!, relGlobalSkillsDir: relSkillsDir });
    if (!(await isDirectory(skillsDir))) continue;

    // R29-a:withFileTypes 使 entry.isDirectory() 免费(无额外 stat),
    // 取代原来的 isDirectory(skillDir) 调用。
    // stat(SKILL.md) 检查也去掉:直接 readFile;ENOENT → null → 跳过,
    // 与原 try/catch+continue 逻辑等价。
    const entries = await readdir(skillsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const skillDir = join(skillsDir, entry.name);
      const result = await readSkill(agents, relSkillsDir, entry.name, skillDir);
      if (result !== null) records.push(result);
    }
  }

  records.sort((a, b) =>
    `${a.relSkillsDir}|${a.dirName}`.localeCompare(`${b.relSkillsDir}|${b.dirName}`),
  );
  return records;
}
