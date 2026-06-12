// S5.3 lint 聚合:spec 校验(S5.1)+ 跨家移植告警(S5.2)+ 触发健康度
//(vendor conflict-detector / context-budget)。
//
// 分层张力的处理:严格 spec 会把 Claude 平台扩展字段(model 等)判为
// "Unexpected fields" error,但它们对 Claude Code 是合法扩展——
// 已知平台扩展字段不算 spec error(跨家风险由 portability 告警承担),
// 真正未知的字段才保留 error。
import { readFile } from 'node:fs/promises';
import { basename, dirname } from 'node:path';
import matter from 'gray-matter';
import { detectConflicts, type ConflictResult } from '../../vendor/agent-skills-cli/conflict-detector.ts';
import { buildContextPlan } from '../../vendor/agent-skills-cli/context-budget.ts';
import { scanHome } from '../scan.ts';
import { ALLOWED_FIELDS, validateMetadata } from './spec-validator.ts';
import { CLAUDE_ONLY_FIELDS, checkPortability, type LintIssue, type LintTarget } from './portability.ts';

export interface SkillLintResult {
  dir: string;
  name: string;
  specErrors: string[];
  issues: LintIssue[];
}

export interface AgentBudgetRow {
  relSkillsDir: string;
  skillCount: number;
  /** agentskills 规范口径:metadata 常驻 ≈100 tokens/skill */
  metadataTokens: number;
}

export interface HomeLintReport {
  skills: SkillLintResult[];
  conflicts: ConflictResult;
  budget: {
    perAgent: AgentBudgetRow[];
    plan?: { totalTokens: number; budget: number; loaded: number; skipped: number };
  };
  hasErrors: boolean;
}

const METADATA_TOKENS_PER_SKILL = 100;
const KNOWN_PLATFORM_FIELDS = new Set(Object.keys(CLAUDE_ONLY_FIELDS));

function filterSpecErrors(
  specErrors: string[],
  metadata: Record<string, unknown>,
): string[] {
  const extra = Object.keys(metadata).filter((k) => !ALLOWED_FIELDS.has(k));
  const allKnownPlatform = extra.length > 0 && extra.every((k) => KNOWN_PLATFORM_FIELDS.has(k));
  if (!allKnownPlatform) return specErrors;
  // 全部额外字段都是已知平台扩展 → 撤掉 "Unexpected fields" 这一条
  return specErrors.filter((e) => !e.startsWith('Unexpected fields in frontmatter'));
}

export async function lintSkillDir(dir: string, target: LintTarget): Promise<SkillLintResult> {
  const name = basename(dir);
  try {
    const raw = await readFile(`${dir}/SKILL.md`, 'utf8');
    const { data, content } = matter(raw, {}); // 空 options 防缓存污染(S1.3 教训)
    const metadata = data as Record<string, unknown>;
    const specErrors = filterSpecErrors(validateMetadata(metadata, name), metadata);
    return { dir, name, specErrors, issues: checkPortability(metadata, content, target) };
  } catch (cause) {
    return {
      dir,
      name,
      specErrors: [cause instanceof Error ? cause.message : String(cause)],
      issues: [],
    };
  }
}

export async function lintHome(
  home: string,
  target: LintTarget,
  budget = 8000,
): Promise<HomeLintReport> {
  const records = await scanHome(home);
  const skills: SkillLintResult[] = [];
  for (const record of records) {
    skills.push(await lintSkillDir(dirname(record.path), target));
  }

  // vendor 模块上游零测试,防御:只把解析得动的 skill 交给它们
  const cleanDirs = records.filter((r) => !r.error).map((r) => dirname(r.path));
  const conflicts = await detectConflicts(cleanDirs);

  const perAgentMap = new Map<string, number>();
  for (const record of records) {
    perAgentMap.set(record.relSkillsDir, (perAgentMap.get(record.relSkillsDir) ?? 0) + 1);
  }
  const perAgent: AgentBudgetRow[] = [...perAgentMap.entries()].map(
    ([relSkillsDir, skillCount]) => ({
      relSkillsDir,
      skillCount,
      metadataTokens: skillCount * METADATA_TOKENS_PER_SKILL,
    }),
  );

  let plan: HomeLintReport['budget']['plan'];
  try {
    // minRelevance: 0 —— 这里要的是"全量加载估算",不做相关性过滤
    // (vendor 默认 10,在无代码信号的 home 下会把所有 skill 滤成 0)
    const p = await buildContextPlan(cleanDirs, { budget, minRelevance: 0, projectDir: home });
    plan = {
      totalTokens: p.totalTokens,
      budget: p.budget,
      loaded: p.loaded.length,
      skipped: p.skipped.length,
    };
  } catch {
    plan = undefined; // 预算估算失败不阻断 lint
  }

  const hasErrors =
    skills.some((s) => s.specErrors.length > 0 || s.issues.some((i) => i.severity === 'error')) ||
    conflicts.summary.critical > 0;

  return { skills, conflicts, budget: { perAgent, plan }, hasErrors };
}
