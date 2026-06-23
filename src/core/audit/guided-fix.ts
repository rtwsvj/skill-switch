// 受控/引导式修复引擎。
//
// 安全边界(非协商):
//   - 只修 audit 目标路径(passedTargetRoot)下的文件;拒绝 --configs 路径。
//   - passedTargetRoot 必须由调用方负责传入;引擎不扫描 home 或任何外部路径。
//   - 写盘前先建 .skill-switch.bak 备份;若已存在则不覆盖(保护最原始版本)。
//   - finding.file 是相对 audit root 的路径;引擎拼出绝对路径后写盘。
//   - 纯函数修复器 + 幂等保护在 fixers.ts 层已保证。
//
// 流程:
//   1. 按文件分组 findings。
//   2. 对每个文件,依次尝试 FIXER_REGISTRY.get(ruleId)。
//   3. dry-run: 仅产出 diff 字符串,不写盘。
//   4. apply:  写 .bak(如未存在),再写修复后内容。
import { existsSync, readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { generateUnifiedDiff } from '../skill-diff.ts';
import { applyFixer, hasFixer } from './fixers.ts';
import type { AuditFinding } from './types.ts';

// ── 结果类型 ───────────────────────────────────────────────────────────────────

export interface FixableResult {
  kind: 'fixable';
  relFile: string;
  absFile: string;
  finding: AuditFinding;
  /** unified diff 预览(dry-run 和 apply 模式均产出) */
  diffPreview: string;
  /** apply 模式才有:备份路径 */
  backupPath?: string;
  /** apply 模式才有:备份是否是此次新建(false = 已存在,跳过覆盖) */
  backupCreated?: boolean;
}

export interface ManualResult {
  kind: 'manual';
  relFile: string;
  finding: AuditFinding;
}

export interface SkippedConfigResult {
  kind: 'skipped-config';
  relFile: string;
  finding: AuditFinding;
}

export type FixResult = FixableResult | ManualResult | SkippedConfigResult;

export interface GuidedFixSummary {
  results: FixResult[];
  /** 实际写盘的文件数量(apply 模式下才 > 0) */
  filesModified: number;
  /** dry-run 模式下可修复的 finding 数量 */
  fixableCount: number;
  /** 需手动处理的 finding 数量 */
  manualCount: number;
  /** 因来自 --configs 路径而跳过的 finding 数量 */
  configSkipCount: number;
}

// ── 辅助 ──────────────────────────────────────────────────────────────────────

/**
 * 把 finding.file(相对 root 的路径)转成绝对路径。
 * 强制 resolve 后判断是否仍在 root 下(防路径穿越)。
 */
function safeAbsPath(root: string, relFile: string): string | null {
  const abs = resolve(join(root, relFile));
  const absRoot = resolve(root);
  // 必须以 absRoot + sep 开头或恰好等于 absRoot
  if (abs !== absRoot && !abs.startsWith(`${absRoot}/`) && !abs.startsWith(`${absRoot}\\`)) {
    return null; // 路径穿越,拒绝
  }
  return abs;
}

// ── 主入口 ─────────────────────────────────────────────────────────────────────

export interface GuidedFixOptions {
  /** audit 目标目录的绝对路径(由 CLI 调用方传入) */
  targetRoot: string;
  /** 找到的 findings;只处理 skill findings,config findings 要标记为 skipped-config */
  skillFindings: AuditFinding[];
  /** --configs 模式下来自 config 文件的 findings(这些绝不修改) */
  configFindings?: AuditFinding[];
  /** true = 实际写盘;false = 仅预览 */
  apply: boolean;
}

/**
 * 执行引导式修复(或 dry-run 预览)。
 * 纯函数部分:修复器计算、diff 生成。
 * 副作用部分(apply=true 时):writeFile 写备份 + 写修复后内容。
 */
export async function runGuidedFix(options: GuidedFixOptions): Promise<GuidedFixSummary> {
  const { targetRoot, skillFindings, configFindings = [], apply } = options;

  const results: FixResult[] = [];
  let filesModified = 0;
  let fixableCount = 0;
  let manualCount = 0;
  const configSkipCount = configFindings.length;

  // config findings 全部标 skipped-config
  for (const f of configFindings) {
    results.push({ kind: 'skipped-config', relFile: f.file, finding: f });
  }

  // 把 skill findings 按绝对文件路径分组,保持 finding 原顺序
  const byFile = new Map<string, { abs: string; rel: string; findings: AuditFinding[] }>();
  for (const f of skillFindings) {
    const abs = safeAbsPath(targetRoot, f.file);
    if (!abs) continue; // 路径穿越:静默跳过
    if (!byFile.has(abs)) {
      byFile.set(abs, { abs, rel: f.file, findings: [] });
    }
    byFile.get(abs)!.findings.push(f);
  }

  for (const { abs, rel, findings } of byFile.values()) {
    // 读文件内容(同步,保持简单;skill 文件很小)
    let currentContent: string;
    try {
      currentContent = readFileSync(abs, 'utf8');
    } catch {
      // 读不到文件:所有 findings 标 manual
      for (const f of findings) {
        results.push({ kind: 'manual', relFile: rel, finding: f });
        manualCount++;
      }
      continue;
    }

    const originalContent = currentContent;
    let modified = false;

    for (const f of findings) {
      if (!hasFixer(f.ruleId)) {
        results.push({ kind: 'manual', relFile: rel, finding: f });
        manualCount++;
        continue;
      }

      const fixed = applyFixer(currentContent, f);
      if (fixed === null) {
        // null = 幂等(已修复)或无法处理;算 fixable(已处理)但不重复注解
        // 仍生成空 diff 以通知用户"无变化"
        results.push({
          kind: 'fixable',
          relFile: rel,
          absFile: abs,
          finding: f,
          diffPreview: '', // 已幂等,diff 为空
        });
        fixableCount++;
        continue;
      }

      // 生成 diff 预览
      const diffPreview = generateUnifiedDiff(
        rel,
        Buffer.from(currentContent, 'utf8'),
        Buffer.from(fixed, 'utf8'),
      );

      results.push({
        kind: 'fixable',
        relFile: rel,
        absFile: abs,
        finding: f,
        diffPreview,
      });
      fixableCount++;

      // 合并内容以便后续 finding 基于新内容计算(行号保持正确)
      currentContent = fixed;
      modified = true;
    }

    // apply 模式:有修改才写盘
    if (apply && modified) {
      const bakPath = `${abs}.skill-switch.bak`;
      let backupCreated = false;
      if (!existsSync(bakPath)) {
        await writeFile(bakPath, originalContent, 'utf8');
        backupCreated = true;
      }
      await writeFile(abs, currentContent, 'utf8');
      filesModified++;

      // 回填 backupPath/backupCreated 到该文件的 fixable 结果
      for (const r of results) {
        if (r.kind === 'fixable' && r.absFile === abs) {
          r.backupPath = bakPath;
          r.backupCreated = backupCreated;
        }
      }
    }
  }

  return {
    results,
    filesModified,
    fixableCount,
    manualCount,
    configSkipCount,
  };
}
