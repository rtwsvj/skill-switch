// S4.1 声明驱动 sync 引擎(思路参考 skills-manager 的 scenario+sync,TS 自写):
//   skills.json 声明"哪些 skill 应出现在哪些 agent 的全局目录"——
//   enabled=true 保证在位且与源一致(symlink 指向/copy 内容哈希),
//   enabled=false 移除,未声明的目录一律不碰(用户手装的东西不是 sync 的管辖)。
// 幂等:对账式 plan→apply,二跑全 noop。Codex config.toml 原生开关在 S4.2 特例接入。
import { existsSync } from 'node:fs';
import { cp, lstat, mkdir, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { AgentType } from '../vendor/vercel-skills/types.ts';
import { computeSkillFolderHash } from '../vendor/vercel-skills/local-lock.ts';
import {
  getCodexConfigPath,
  readCodexSkillEnabled,
  setCodexSkillEnabled,
} from './codex-toggle.ts';
import { getAgentSkillsLocations, resolveGlobalSkillsDir } from './paths.ts';

export interface SkillDeclaration {
  name: string;
  /** skill 内容目录(绝对路径,或相对 home) */
  source: string;
  agents: AgentType[];
  enabled: boolean;
  mode: 'symlink' | 'copy';
}

export interface SkillsDeclarationFile {
  version: 1;
  skills: SkillDeclaration[];
}

export interface SyncAction {
  // config-disable/config-enable 为 Codex 专用:开关走 config.toml 原生机制,文件不动
  kind: 'create' | 'replace' | 'remove' | 'noop' | 'config-disable' | 'config-enable';
  agent: AgentType;
  name: string;
  target: string;
  reason?: string;
}

export function getSkillsJsonPath(home: string): string {
  return join(home, '.skill-switch', 'skills.json');
}

export async function readDeclaration(path: string): Promise<SkillsDeclarationFile> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as SkillsDeclarationFile;
  } catch {
    return { version: 1, skills: [] };
  }
}

export async function upsertSkillDeclarations(
  skillsJsonPath: string,
  additions: Array<{ name: string; agent: AgentType; source: string; mode: 'symlink' | 'copy' }>,
): Promise<SkillsDeclarationFile> {
  const current = await readDeclaration(skillsJsonPath);
  const byName = new Map<string, SkillDeclaration>(
    current.skills.map((skill) => [skill.name, { ...skill, agents: [...skill.agents] }]),
  );

  for (const addition of additions) {
    const existing = byName.get(addition.name);
    if (existing) {
      if (!existing.agents.includes(addition.agent)) existing.agents.push(addition.agent);
      existing.enabled = true;
      continue;
    }

    byName.set(addition.name, {
      name: addition.name,
      source: addition.source,
      agents: [addition.agent],
      enabled: true,
      mode: addition.mode,
    });
  }

  const next: SkillsDeclarationFile = {
    version: 1,
    skills: [...byName.values()].sort((a, b) => a.name.localeCompare(b.name)),
  };
  await mkdir(dirname(skillsJsonPath), { recursive: true });
  await writeFile(skillsJsonPath, `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

function skillsDirFor(home: string, agent: AgentType): string {
  const location = getAgentSkillsLocations().find((l) => l.agent === agent);
  if (!location) throw new Error(`声明中包含未知或无全局 skills 目录的 agent: ${agent}`);
  return resolveGlobalSkillsDir(home, location);
}

type TargetState =
  | { state: 'missing' }
  | { state: 'symlink'; linkTarget: string }
  | { state: 'dir' };

async function inspectTarget(target: string): Promise<TargetState> {
  try {
    const st = await lstat(target);
    if (st.isSymbolicLink()) return { state: 'symlink', linkTarget: await readlink(target) };
    return { state: 'dir' };
  } catch {
    return { state: 'missing' };
  }
}

/** 期望状态 vs 实际状态 → 单个目标的对账动作(不执行)。 */
async function planOne(
  declared: SkillDeclaration,
  sourceAbs: string,
  agent: AgentType,
  target: string,
): Promise<SyncAction> {
  const base = { agent, name: declared.name, target };
  const actual = await inspectTarget(target);

  if (!declared.enabled) {
    return actual.state === 'missing'
      ? { ...base, kind: 'noop', reason: 'disabled,目标本就不存在' }
      : { ...base, kind: 'remove', reason: 'disabled,移除目标' };
  }

  if (actual.state === 'missing') return { ...base, kind: 'create' };

  if (declared.mode === 'symlink') {
    if (actual.state === 'symlink' && resolve(actual.linkTarget) === resolve(sourceAbs)) {
      return { ...base, kind: 'noop' };
    }
    return { ...base, kind: 'replace', reason: 'symlink 指向不符或被实体目录占位' };
  }

  // copy 模式:实体目录且内容哈希一致才算同步
  if (actual.state === 'dir') {
    const [want, have] = await Promise.all([
      computeSkillFolderHash(sourceAbs),
      computeSkillFolderHash(target),
    ]);
    if (want === have) return { ...base, kind: 'noop' };
    return { ...base, kind: 'replace', reason: '内容哈希不一致' };
  }
  return { ...base, kind: 'replace', reason: 'copy 模式但目标是 symlink' };
}

export async function planSync(
  home: string,
  declaration: SkillsDeclarationFile,
): Promise<SyncAction[]> {
  const actions: SyncAction[] = [];
  for (const skill of declaration.skills) {
    const sourceAbs = isAbsolute(skill.source) ? skill.source : join(home, skill.source);
    if (skill.enabled && !existsSync(sourceAbs)) {
      throw new Error(`声明的 skill 源不存在: ${skill.name} → ${sourceAbs}`);
    }
    for (const agent of skill.agents) {
      const target = join(skillsDirFor(home, agent), skill.name);

      // Codex 特例:开关走 config.toml 原生机制(官方支持),文件保持在位。
      if (agent === 'codex') {
        const configured = await readCodexSkillEnabled(getCodexConfigPath(home), target);
        if (!skill.enabled) {
          actions.push(
            configured === false
              ? { kind: 'noop', agent, name: skill.name, target, reason: 'config 已 disabled' }
              : { kind: 'config-disable', agent, name: skill.name, target },
          );
          continue;
        }
        actions.push(await planOne(skill, sourceAbs, agent, target));
        if (configured === false) {
          actions.push({ kind: 'config-enable', agent, name: skill.name, target });
        }
        continue;
      }

      actions.push(await planOne(skill, sourceAbs, agent, target));
    }
  }
  return actions;
}

export async function applySync(
  home: string,
  declaration: SkillsDeclarationFile,
): Promise<{ actions: SyncAction[] }> {
  const actions = await planSync(home, declaration);
  for (const action of actions) {
    if (action.kind === 'noop') continue;

    if (action.kind === 'config-disable' || action.kind === 'config-enable') {
      await setCodexSkillEnabled(
        getCodexConfigPath(home),
        action.target,
        action.kind === 'config-enable',
      );
      continue;
    }

    await rm(action.target, { recursive: true, force: true });
    if (action.kind === 'remove') continue;

    const declared = declaration.skills.find((s) => s.name === action.name)!;
    const sourceAbs = isAbsolute(declared.source) ? declared.source : join(home, declared.source);
    await mkdir(join(action.target, '..'), { recursive: true });
    if (declared.mode === 'symlink') {
      await symlink(sourceAbs, action.target, 'dir');
    } else {
      await cp(sourceAbs, action.target, { recursive: true });
    }
  }
  return { actions };
}
