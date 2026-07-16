// 从 audit.ts 机械拆出(2026-07-16),行为零变化。
// 格式/过滤/策略解析:输出格式、严重度过滤、行内抑制、忽略文件、git diff、策略加载。
//
// 原 audit.ts 相关说明:
// v0.5-3:新增 .skill-switch-policy.json 策略文件支持。
//   --policy <path>   指定策略文件路径(默认从 cwd 查找)
//   --no-policy       忽略策略文件,使用默认行为
//   策略文件可调整 failOn(阻断严重度下限)和 suppress(按 ruleId 抑制 finding)。
//   无策略文件 / --no-policy 时行为与旧版完全一致。
import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  loadPolicyFile,
  DEFAULT_POLICY,
  type ResolvedPolicy,
} from '../../core/audit/policy.ts';
import type { AuditFinding, Severity } from '../../core/audit/types.ts';
import { SEVERITY_RANK } from '../../core/audit/service.ts';

/** 默认策略文件在 cwd 的文件名 */
export const POLICY_FILE_NAME = '.skill-switch-policy.json';

/** 默认忽略文件名 */
export const IGNORE_FILE_NAME = '.skill-switch-ignore';

const execFileAsync = promisify(execFile);

/**
 * 用 `git diff --name-only <commit>...HEAD` 取出改动文件集合(相对仓库根的路径)。
 * 失败时返回 null(调用方视同未指定 --diff-from,全量审计)。
 */
export async function getChangedFiles(commit: string, cwd: string): Promise<Set<string> | null> {
  try {
    // Resolve user input to an object id first. `--end-of-options` prevents an
    // option-looking ref from becoming a git flag; the subsequent diff receives
    // only the canonical hexadecimal id.
    const { stdout: resolvedStdout } = await execFileAsync(
      'git',
      ['rev-parse', '--verify', '--end-of-options', `${commit}^{commit}`],
      { cwd },
    );
    const resolved = resolvedStdout.trim();
    if (!/^[0-9a-f]{40,64}$/iu.test(resolved)) return null;
    const { stdout } = await execFileAsync(
      'git',
      ['diff', '--name-only', '--end-of-options', `${resolved}...HEAD`],
      { cwd },
    );
    const files = stdout.split('\n').map((l) => l.trim()).filter(Boolean);
    return new Set(files);
  } catch {
    return null;
  }
}

/**
 * 解析 .gitignore 风格忽略文件,返回逐行 glob/前缀列表。
 * 忽略空行和 # 注释行。文件不存在时返回空列表。
 */
export async function loadIgnorePatterns(ignoreFilePath: string): Promise<string[]> {
  try {
    const content = await readFile(ignoreFilePath, 'utf8');
    return content
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith('#'));
  } catch {
    return [];
  }
}

/**
 * 判断相对路径 rel 是否被忽略模式列表中的某条规则命中。
 * 支持:
 *   - 精确路径匹配(e.g. `foo/bar.md`)
 *   - 前缀目录匹配(e.g. `vendor` → 匹配 `vendor/...`)
 *   - 简单 glob:`*` 匹配任意非 `/` 字符;`**` 匹配任意字符(含 `/`)
 * 不引入外部依赖,纯 JS 实现。
 */

// 解析最终输出格式:--format 优先;若无 --format 但有 --json 则等价于 json。
export type OutputFormat = 'human' | 'json' | 'sarif' | 'github' | 'junit' | 'codeclimate' | 'rdjson';

export function resolveFormat(options: { format?: string; json?: boolean }): OutputFormat {
  if (options.format === 'sarif') return 'sarif';
  if (options.format === 'github') return 'github';
  if (options.format === 'junit') return 'junit';
  if (options.format === 'codeclimate') return 'codeclimate';
  if (options.format === 'rdjson') return 'rdjson';
  if (options.format === 'json' || options.json === true) return 'json';
  return 'human';
}

// ── 最低严重度过滤 ────────────────────────────────────────────────────────────

/**
 * 解析 --min-severity 参数为 Severity 类型。
 * 无效值时抛出 RangeError(由调用方捕获并 exit 1)。
 */
export function resolveMinSeverity(raw: string | undefined): Severity | undefined {
  if (raw === undefined) return undefined;
  const valid: Severity[] = ['critical', 'high', 'medium', 'low'];
  const lower = raw.toLowerCase() as Severity;
  if (!valid.includes(lower)) {
    throw new RangeError(`--min-severity 无效值 "${raw}";合法值: critical | high | medium | low`);
  }
  return lower;
}

/**
 * 按最低严重度过滤 findings。
 * minSeverity=undefined → 全部保留(默认,与旧版行为完全一致)。
 * minSeverity='high'    → 只保留 critical 和 high。
 */
export function filterBySeverity(
  findings: AuditFinding[],
  minSeverity: Severity | undefined,
): AuditFinding[] {
  if (minSeverity === undefined) return findings;
  const minRank = SEVERITY_RANK[minSeverity];
  return findings.filter((f) => SEVERITY_RANK[f.severity] <= minRank);
}

// ── 行内抑制:skill-switch:suppress ──────────────────────────────────────────

/**
 * 检测 finding 是否被行内抑制注释抑制。
 * 抑制条件:finding 所在行或其上一行包含 `skill-switch:suppress` 注释。
 * 可选的 `[ruleId]` 后缀使抑制只针对特定规则:
 *   - `# skill-switch:suppress`            → 抑制当前行所有 finding
 *   - `// skill-switch:suppress[rule/id]`  → 仅抑制 ruleId === 'rule/id'
 * 无内容(fileContent=undefined)时返回 false。
 */
export function isInlineSuppressed(
  finding: AuditFinding,
  fileContent: string | undefined,
): boolean {
  if (fileContent === undefined) return false;
  // 将文件内容按行分割(1-based 行号 → 数组下标 line-1)
  const lines = fileContent.split('\n');
  // 检查指定行和上一行
  const checkLines = [finding.line - 1, finding.line - 2].filter((i) => i >= 0);
  for (const idx of checkLines) {
    const lineText = lines[idx] ?? '';
    // 匹配 skill-switch:suppress 注释(含可选 [ruleId])
    const match = lineText.match(/skill-switch:suppress(?:\[([^\]]*)\])?/);
    if (!match) continue;
    const targetRule = match[1]; // undefined → 无 ruleId 限制 → 抑制全部
    if (targetRule === undefined || targetRule === finding.ruleId) {
      return true;
    }
  }
  return false;
}

/**
 * 将 findings 列表按行内抑制注释标注 inlineSuppressed 字段。
 * fileContents: Map<相对文件路径 → 文件内容字符串>。
 * 仅补 inlineSuppressed 字段;不过滤;与 applyPolicyToFindings 可链式组合。
 */
export function applyInlineSuppression(
  findings: AuditFinding[],
  fileContents: Map<string, string>,
): Array<AuditFinding & { inlineSuppressed: boolean }> {
  return findings.map((f) => ({
    ...f,
    inlineSuppressed: isInlineSuppressed(f, fileContents.get(f.file)),
  }));
}

// ── 策略加载辅助 ─────────────────────────────────────────────────────────────

/**
 * 根据 CLI 选项加载策略。
 * - noPolicy=true → 返回 { policy: DEFAULT_POLICY, policyActive: false }
 * - 文件不存在 → { policy: DEFAULT_POLICY, policyActive: false }
 * - 文件存在且合法 → { policy: 解析结果, policyActive: true }
 * - 文件存在但损坏 → 抛 PolicyFileError
 *
 * policyActive=false 时输出格式与旧版完全一致(不附加 suppressed 字段)。
 */
export async function resolvePolicy(opts: {
  noPolicy?: boolean;
  policy?: string;
}): Promise<{ policy: ResolvedPolicy; policyActive: boolean }> {
  if (opts.noPolicy) return { policy: DEFAULT_POLICY, policyActive: false };
  const filePath = opts.policy ?? join(process.cwd(), POLICY_FILE_NAME);
  const loaded = await loadPolicyFile(filePath);
  if (loaded === null) return { policy: DEFAULT_POLICY, policyActive: false };
  return { policy: loaded, policyActive: true };
}
