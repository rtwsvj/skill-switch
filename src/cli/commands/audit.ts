// S2.5 audit 子命令:对一个 skill 目录做装前/存量安全体检。纯读。
//
// 阻断策略(严重度下限,见 docs/changes/2026-06-12-S2.4.md):
//   纯按 ags 分数带会把"单条 HIGH 的登录后门"判成 SAFE(90 分)。所以阻断判据是
//   "审计覆盖不完整 OR 任意 finding 严重度 ∈ {critical, high} OR score < 70" → exit 1。
//   分数带(SAFE/REVIEW/DANGER)仅用于展示。
//
// v0.5-1:新增 --format sarif 输出 SARIF 2.1.0 文档(GitHub code-scanning 可用)。
//   --json 旧标志保留,行为完全不变;--format json 与其等价。
//
// v0.5-3:新增 .skill-switch-policy.json 策略文件支持。
//   --policy <path>   指定策略文件路径(默认从 cwd 查找)
//   --no-policy       忽略策略文件,使用默认行为
//   策略文件可调整 failOn(阻断严重度下限)和 suppress(按 ruleId 抑制 finding)。
//   无策略文件 / --no-policy 时行为与旧版完全一致。
//
// v0.7-1:新增基线模式(baseline mode)。
//   --write-baseline <path>  将当前所有 finding 的指纹写入基线文件,exit 0。
//   --baseline <path>        加载基线;已基线化的 finding 不计入退出码(仍出现在输出中)。
//   两者同时使用时,--write-baseline 优先(写入当前状态)。
//
// v0.8-1:新增 MCP 配置漂移检测(仅在 --configs 时生效)。
// v0.8-3:统一配置漂移检测(--write-config-baseline / --config-baseline),
//   同时覆盖 MCP server 漂移 + settings 文件(hooks/permissions/auto-approve)漂移。
//   --write-config-baseline <path>  把当前发现的 MCP server + settings 指纹写入基线文件,exit 0。
//   --config-baseline <path>        与基线对比:MCP 变化/新增 + settings 变化/新增。
//   两个标志必须配合 --configs 使用;单独使用会产生友好错误。
//   写入时:--write-config-baseline 优先,写完 exit 0,不再继续常规审计流程。
//   对比时:drift finding 与其它 config finding 走同一输出/退出码路径。
import { join, resolve } from 'node:path';
import type { Command } from 'commander';
import { flattenConfigFindings, readMcpConfigsRaw, readSettingsConfigsRaw } from '../../core/audit/config-discovery.ts';
import {
  PolicyFileError,
  type ResolvedPolicy,
} from '../../core/audit/policy.ts';
import {
  buildBaselineFile,
  fingerprintFinding,
  loadBaselineFile,
  writeBaselineFile,
  BaselineFileError,
} from '../../core/audit/baseline.ts';
import {
  fingerprintMcpServersFromRaw,
  fingerprintSettingsFilesFromRaw,
  writeConfigBaseline,
  loadConfigBaseline,
  diffConfigBaseline,
  configDiffToFindings,
  ConfigBaselineError,
} from '../../core/audit/config-baseline.ts';
import { runGuidedFix } from '../../core/audit/guided-fix.ts';
import { toCodeClimateEntries } from '../../core/audit/codeclimate.ts';
import { toGithubAnnotations } from '../../core/audit/github-annotations.ts';
import { toJunitDocument } from '../../core/audit/junit.ts';
import { toRdJsonDocument } from '../../core/audit/rdjson.ts';
import { toSarifDocument } from '../../core/audit/sarif.ts';
import type { AuditFinding, Severity } from '../../core/audit/types.ts';
import {
  applyPolicyAndBaselineToFindings,
  auditHome,
  auditSkillDirWithContents,
  SEVERITY_RANK,
  shouldBlockWithAll,
  shouldBlockWithPolicy,
} from '../../core/audit/service.ts';
import { resolveHomeRoot } from '../../core/paths.ts';
import { SKILL_SWITCH_VERSION } from '../../version.ts';
import {
  formatAuditHomeTable,
  formatAuditReport,
  formatGuidedFixOutput,
  serializeGuidedFix,
} from './audit-format.ts';
import {
  filterBySeverity,
  getChangedFiles,
  IGNORE_FILE_NAME,
  isInlineSuppressed,
  loadIgnorePatterns,
  resolveFormat,
  resolveMinSeverity,
  resolvePolicy,
} from './audit-options.ts';

export function registerAuditCommand(program: Command): void {
  program
    .command('audit')
    .description('对 skill 目录或 home 内全部已装 skill 做安全体检(纯读;覆盖不完整、任意 critical/high 或评分<70 → exit 1)')
    .argument('[path]', 'skill 目录或 SKILL.md 路径;省略时扫描 --home 下全部已装 skill')
    .option('--home [dir]', '启用 home 全量模式;可选覆盖 home 根目录(默认取系统 home)')
    .option('--json', '机器可读 JSON 输出(等价于 --format json;保留向后兼容)')
    .option('--format <fmt>', '输出格式:human(默认)/ json / sarif / github / junit / codeclimate / rdjson', 'human')
    .option('--configs', '同时审查 home 下的 agent 配置文件(settings.json / MCP 等)')
    .option('--policy <path>', '指定策略文件路径(默认: ./.skill-switch-policy.json)')
    .option('--no-policy', '忽略策略文件,使用默认阻断行为(等同于无策略文件)')
    .option('--fix', '受控引导修复(dry-run):展示每条可修复 finding 的差异预览;不写盘。加 --apply 才实际修改。')
    .option('--apply', '与 --fix 搭配:实际写盘修复,并在 HOME/.skill-switch/fix-backups 隔离保存原文(已存在则不覆盖)。单独使用无效。')
    .option('--write-baseline <path>', '将当前所有 finding 的指纹写入基线文件,exit 0(与 --baseline 同时使用时本标志优先)')
    .option('--baseline <path>', '加载基线文件;已基线化的 finding 不影响退出码(仍出现在输出中)')
    .option('--write-config-baseline <path>', '将当前发现的 MCP server + settings 指纹写入配置漂移基线文件,exit 0(须配合 --configs)')
    .option('--config-baseline <path>', '与配置漂移基线对比;MCP server 变化/新增 + settings 文件变化/新增均产生 finding(须配合 --configs)')
    .option('--exit-code <n>', '覆盖进程退出码(如 --exit-code 0 = 报告但不阻断 CI);不影响 finding 输出。无标志时保持旧版行为。')
    .option('--min-severity <level>', '只报告并计入阻断的最低严重度(critical|high|medium|low);无标志时全部严重度均有效(旧版行为)。')
    .option('--diff-from <commit>', '仅报告落在 git diff <commit>...HEAD 改动文件内的 finding(PR 增量模式);无此标志 → 全量(旧版行为不变)')
    .option('--ignore-file <path>', `路径忽略列表文件(.gitignore 格式;默认: ./${IGNORE_FILE_NAME})`)
    .action(async (
      path: string | undefined,
      options: {
        home?: string | boolean;
        json?: boolean;
        format?: string;
        configs?: boolean;
        policy?: string;
        fix?: boolean;
        apply?: boolean;
        writeBaseline?: string;
        baseline?: string;
        writeConfigBaseline?: string;
        configBaseline?: string;
        exitCode?: string;
        minSeverity?: string;
        diffFrom?: string;
        ignoreFile?: string;
        // commander 将 --no-policy 映射为 options.policy === false
        // 但类型里用 noPolicy 更清晰;实际通过 options['policy'] 判断
      },
      command: Command,
    ) => {
      const fmt = resolveFormat(options);

      // ── --exit-code:解析覆盖退出码(可选) ─────────────────────────────────────
      // 无标志时 overrideExitCode=undefined,保持旧版行为。
      let overrideExitCode: number | undefined;
      if (options.exitCode !== undefined) {
        const parsed = Number(options.exitCode);
        if (!Number.isInteger(parsed) || parsed < 0 || parsed > 255) {
          process.stderr.write(`audit: --exit-code 无效值 "${options.exitCode}";须为 0–255 的整数\n`);
          process.exitCode = 1;
          return;
        }
        overrideExitCode = parsed;
      }

      // ── --min-severity:解析最低严重度过滤(可选) ────────────────────────────────
      // 无标志时 minSeverity=undefined,全部严重度均有效(旧版行为)。
      let minSeverity: Severity | undefined;
      try {
        minSeverity = resolveMinSeverity(options.minSeverity);
      } catch (err) {
        process.stderr.write(`audit: ${(err as Error).message}\n`);
        process.exitCode = 1;
        return;
      }

      // 加载策略文件;损坏时打印错误并 exit 1
      let policy: ResolvedPolicy;
      let policyActive: boolean;
      try {
        // commander 的 --no-policy 会把 options.policy 置为 false(boolean)
        const noPolicyFlag = (options as Record<string, unknown>).policy === false;
        ({ policy, policyActive } = await resolvePolicy({
          noPolicy: noPolicyFlag,
          policy: typeof options.policy === 'string' ? options.policy : undefined,
        }));
      } catch (err) {
        if (err instanceof PolicyFileError) {
          process.stderr.write(`audit: 策略文件错误 — ${err.message}\n`);
          process.exitCode = 1;
          return;
        }
        throw err;
      }

      // 加载基线文件(若指定了 --baseline 且未指定 --write-baseline)
      // --write-baseline 优先:此时跳过基线加载,直接写出当前状态。
      let baselinedFingerprints: ReadonlySet<string> = new Set();
      const writeBaselinePath = options.writeBaseline;
      const baselinePath = options.baseline;
      const baselineActive = baselinePath !== undefined && writeBaselinePath === undefined;

      if (baselineActive) {
        try {
          baselinedFingerprints = await loadBaselineFile(baselinePath!);
        } catch (err) {
          if (err instanceof BaselineFileError) {
            process.stderr.write(`audit: 基线文件错误 — ${err.message}\n`);
            process.exitCode = 1;
            return;
          }
          throw err;
        }
      }

      // ── --write-config-baseline / --config-baseline 前置校验 ──────────────────
      // 这两个标志仅在 --configs 时有意义(MCP server 和 settings 文件来自 config 发现);
      // 单独使用时给出友好错误,而非静默无效。
      const writeConfigBaselinePath = options.writeConfigBaseline;
      const configBaselinePath = options.configBaseline;
      const hasConfigBaselineFlag = writeConfigBaselinePath !== undefined || configBaselinePath !== undefined;
      if (hasConfigBaselineFlag && options.configs !== true) {
        process.stderr.write(
          `audit: --write-config-baseline / --config-baseline 须配合 --configs 使用\n` +
          `  示例: skill-switch audit --configs --config-baseline config-baseline.json\n`,
        );
        process.exitCode = 1;
        return;
      }
      // 若同时指定两者,--write-config-baseline 优先(写出后 exit 0;不再对比)
      const configBaselineCompareActive = configBaselinePath !== undefined && writeConfigBaselinePath === undefined;
      const optionHome = typeof options.home === 'string' ? options.home : undefined;
      const home = resolveHomeRoot(optionHome ?? command.parent?.opts<{ home?: string }>().home);
      const guidedFixBackupRoot = join(home, '.skill-switch', 'fix-backups');

      // ── --ignore-file / .skill-switch-ignore:加载路径忽略规则 ──────────────────
      // 无标志时尝试读取默认忽略文件;文件不存在 → 空规则列表(行为不变)。
      const ignoreFilePath = options.ignoreFile
        ? resolve(options.ignoreFile)
        : join(process.cwd(), IGNORE_FILE_NAME);
      const ignorePatterns: string[] = await loadIgnorePatterns(ignoreFilePath);

      // ── --diff-from:取 git 改动文件集合(供后续 finding 过滤) ────────────────
      // 无标志时 changedFiles=null → 全量(不变)。
      let changedFiles: Set<string> | null = null;
      if (options.diffFrom !== undefined) {
        changedFiles = await getChangedFiles(options.diffFrom, process.cwd());
        // git 失败时 changedFiles 仍为 null → 降级全量(不退出,只提示)
        if (changedFiles === null) {
          process.stderr.write(
            `audit: --diff-from 无法运行 git diff(非 git 仓库或 ${options.diffFrom} 不存在?);降级为全量审计\n`,
          );
        }
      }

      /**
       * 将 findings 列表按 --diff-from 的改动文件集合过滤。
       * changedFiles=null(无此标志 / git 失败) → 原样返回(全量,旧版行为不变)。
       */
      function filterByDiff<T extends AuditFinding>(findings: T[]): T[] {
        if (changedFiles === null) return findings;
        return findings.filter((f) => changedFiles!.has(f.file));
      }

      // ── 辅助:将 findingsActive(过滤后)构建行内抑制 finding Set ──────────────
      // 仅当 minSeverity 或行内抑制激活时才计算;否则返回空集(零开销)。
      // 注意:行内抑制标注在输出中可见(suppressed/inlineSuppressed),但不计入退出码。

      if (path) {
        const fullReport = await auditSkillDirWithContents(path, ignorePatterns);

        // ── --write-baseline:写出当前 finding 指纹,exit 0 ──────────────────────
        if (writeBaselinePath !== undefined) {
          const allFindings: AuditFinding[] = fullReport.findings;
          const baseline = buildBaselineFile(allFindings);
          try {
            await writeBaselineFile(writeBaselinePath, baseline);
          } catch (err) {
            process.stderr.write(`audit: 无法写入基线文件 ${writeBaselinePath}: ${(err as Error).message}\n`);
            process.exitCode = 1;
            return;
          }
          process.stdout.write(`audit: 已写入基线 ${writeBaselinePath}(${baseline.fingerprints.length} 条 finding)\n`);
          return; // exit 0
        }

        // 按 --min-severity 过滤;无标志时与原始 findings 完全相同(引用相等)。
        // 再按 --diff-from 改动文件过滤;无此标志 → 全量(旧版行为不变)。
        const filteredFindings = filterByDiff(filterBySeverity(fullReport.findings, minSeverity));

        // 行内抑制:标注被 skill-switch:suppress 注释抑制的 finding。
        // 只在 filteredFindings 上做标注(未过滤的不进入输出)。
        const inlineSuppressedSet = new Set<AuditFinding>(
          filteredFindings.filter((f) => isInlineSuppressed(f, fullReport.fileContents.get(f.file))),
        );

        // 使用过滤后的 findings 构建视图报告(分数/verdict 不变;来自原始报告)
        const report = { ...fullReport, findings: filteredFindings };

        if (fmt === 'codeclimate') {
          // GitLab Code Quality JSON 数组
          console.log(JSON.stringify(toCodeClimateEntries(filteredFindings), null, 2));
        } else if (fmt === 'rdjson') {
          // reviewdog Diagnostic Format JSON
          console.log(JSON.stringify(toRdJsonDocument(filteredFindings), null, 2));
        } else if (fmt === 'sarif') {
          // SARIF 模式:被抑制/已基线化的 finding 写入 suppressions
          // --fix 对 SARIF 输出无影响;机器消费者通过 --format json 取修复信息。
          const doc = toSarifDocument(filteredFindings, SKILL_SWITCH_VERSION, policy.suppressedRuleIds, baselinedFingerprints);
          console.log(JSON.stringify(doc, null, 2));
        } else if (fmt === 'github') {
          // GitHub Actions 注解模式:每条 finding 输出一行工作流注解命令。
          // 被抑制/已基线化的 finding 输出为 ::notice,不触发阻断。
          // --fix 对 github 格式输出无影响(同 sarif)。
          const findings = applyPolicyAndBaselineToFindings(filteredFindings, policy, baselinedFingerprints);
          console.log(toGithubAnnotations(findings));
        } else if (fmt === 'junit') {
          // JUnit XML 模式:一个 <testsuite>,每条 finding 一个 <testcase>。
          // 阻断 finding → <failure>;被抑制/基线化/行内抑制 finding → <system-out>。
          const junitBlockingSeverities = new Set<Severity>(
            (Object.keys(SEVERITY_RANK) as Severity[]).filter(
              (s) => SEVERITY_RANK[s] <= SEVERITY_RANK[policy.failOn],
            ),
          );
          // 行内抑制的 finding 也视为非阻断(合并到 suppressedRuleIds 外部判断)
          const inlineSuppressedRuleIdsForJunit = new Set<string>(
            [...inlineSuppressedSet].map((f) => f.ruleId),
          );
          const effectiveSuppressedForJunit = new Set<string>([
            ...policy.suppressedRuleIds,
            ...inlineSuppressedRuleIdsForJunit,
          ]);
          const xml = toJunitDocument(filteredFindings, {
            suiteName: `skill-switch-audit:${path}`,
            blockingSeverities: junitBlockingSeverities,
            suppressedRuleIds: effectiveSuppressedForJunit,
            baselinedFingerprints,
            fingerprintFn: fingerprintFinding,
          });
          process.stdout.write(xml);
        } else if (fmt === 'json') {
          // 无策略且无基线时,输出与旧版完全一致(不含 suppressed/baselined 字段)。
          // fileContents 是 Map,不可序列化为 JSON;通过解构排除。
          const { fileContents: _fc, ...reportForJson } = report;
          const findings = (policyActive || baselineActive)
            ? applyPolicyAndBaselineToFindings(filteredFindings, policy, baselinedFingerprints)
            : filteredFindings;

          // --fix + json:先跑引导修复(dry-run 或 apply),再把摘要嵌入 JSON 对象一次性输出。
          // 无 --fix 时:不含 guidedFix 键,与旧版逐字节一致。
          if (options.fix) {
            const doApply = options.apply === true;
            const summary = await runGuidedFix({
              targetRoot: path,
              skillFindings: fullReport.findings,
              configFindings: [],
              apply: doApply,
              backupRoot: guidedFixBackupRoot,
            });
            const guidedFix = serializeGuidedFix(summary, doApply);
            console.log(JSON.stringify({ path, ...reportForJson, findings, guidedFix }, null, 2));
          } else {
            console.log(JSON.stringify({ path, ...reportForJson, findings }, null, 2));
          }
        } else {
          // human 格式:基线化的 finding 用括号标注
          console.log(formatAuditReport(path, report, baselinedFingerprints));
        }

        // 退出码决策:使用过滤后的 findings + 策略 + 基线 + 行内抑制
        const blocked = shouldBlockWithAll(report, policy, baselinedFingerprints, inlineSuppressedSet);
        if (overrideExitCode !== undefined) {
          // --exit-code 覆盖:无论是否阻断都使用指定退出码
          if (blocked) process.exitCode = overrideExitCode;
        } else {
          if (blocked) process.exitCode = 1;
        }

        // --fix human 格式:打印人类可读差异预览/应用报告(原有行为不变)
        // json 格式已在上方 json 块中处理;sarif 格式 --fix 无输出。
        if (options.fix && fmt === 'human') {
          const doApply = options.apply === true;
          const summary = await runGuidedFix({
            targetRoot: path,
            skillFindings: fullReport.findings,
            configFindings: [], // path 模式无 --configs findings
            apply: doApply,
            backupRoot: guidedFixBackupRoot,
          });
          console.log('');
          console.log(formatGuidedFixOutput(summary, doApply));
        }
        return;
      }

      const report = await auditHome(home, { includeConfigs: options.configs === true });

      // ── --write-config-baseline:写出 MCP server + settings 指纹基线,exit 0 ────
      if (writeConfigBaselinePath !== undefined) {
        const rawMcpContents = await readMcpConfigsRaw(home);
        const rawSettingsContents = await readSettingsConfigsRaw(home);
        const mcpFp = fingerprintMcpServersFromRaw(rawMcpContents);
        const settingsFp = fingerprintSettingsFilesFromRaw(rawSettingsContents);
        // 合并两个指纹映射到统一 Map
        const fp = new Map<string, string>([...mcpFp, ...settingsFp]);
        try {
          await writeConfigBaseline(writeConfigBaselinePath, fp);
        } catch (err) {
          process.stderr.write(`audit: 无法写入配置基线文件 ${writeConfigBaselinePath}: ${(err as Error).message}\n`);
          process.exitCode = 1;
          return;
        }
        process.stdout.write(`audit: 已写入配置漂移基线 ${writeConfigBaselinePath}(${mcpFp.size} 个 MCP server,${settingsFp.size} 个 settings 文件)\n`);
        return; // exit 0
      }

      // ── --config-baseline:对比当前 MCP + settings 与基线,将漂移 finding 注入 configs ──
      if (configBaselineCompareActive) {
        let configBaselineMap: Map<string, string>;
        try {
          configBaselineMap = await loadConfigBaseline(configBaselinePath!);
        } catch (err) {
          if (err instanceof ConfigBaselineError) {
            process.stderr.write(`audit: 配置基线文件错误 — ${err.message}\n`);
            process.exitCode = 1;
            return;
          }
          throw err;
        }
        const rawMcpContents = await readMcpConfigsRaw(home);
        const rawSettingsContents = await readSettingsConfigsRaw(home);
        const mcpFp = fingerprintMcpServersFromRaw(rawMcpContents);
        const settingsFp = fingerprintSettingsFilesFromRaw(rawSettingsContents);
        const currentFp = new Map<string, string>([...mcpFp, ...settingsFp]);
        const diff = diffConfigBaseline(currentFp, configBaselineMap);
        const driftFindings = configDiffToFindings(diff);
        // 将漂移 finding 注入到虚拟 config 条目,
        // 以便与其它 config finding 走同一输出/退出码路径。
        if (driftFindings.length > 0 && report.configs !== undefined) {
          report.configs.push({
            absPath: '',
            relPath: 'config-drift',
            findings: driftFindings,
          });
          // 同步更新 configsBlocked:使用策略 failOn 确保 --policy suppress 生效。
          const failOnRank = SEVERITY_RANK[policy.failOn];
          const driftBlocked = driftFindings.some(
            (f) =>
              !policy.suppressedRuleIds.has(f.ruleId) &&
              !baselinedFingerprints.has(fingerprintFinding(f)) &&
              SEVERITY_RANK[f.severity] <= failOnRank,
          );
          (report as { configsBlocked?: boolean }).configsBlocked =
            (report.configsBlocked === true) || driftBlocked;
        }
      }

      // ── --write-baseline(home 模式):合并所有 skill + config findings 后写出 ──
      if (writeBaselinePath !== undefined) {
        const allFindings: AuditFinding[] = [
          ...report.skills.flatMap((s) => s.findings),
          ...(report.configs ? flattenConfigFindings(report.configs) : []),
          ...(report.crossSkillFindings ?? []),
        ];
        const baseline = buildBaselineFile(allFindings);
        try {
          await writeBaselineFile(writeBaselinePath, baseline);
        } catch (err) {
          process.stderr.write(`audit: 无法写入基线文件 ${writeBaselinePath}: ${(err as Error).message}\n`);
          process.exitCode = 1;
          return;
        }
        process.stdout.write(`audit: 已写入基线 ${writeBaselinePath}(${baseline.fingerprints.length} 条 finding)\n`);
        return; // exit 0
      }

      if (fmt === 'codeclimate') {
        // GitLab Code Quality JSON 数组(home 全量):合并所有 skill findings 后序列化
        const allFindings: AuditFinding[] = filterByDiff(filterBySeverity(
          [
            ...report.skills.flatMap((s) => s.findings),
            ...(report.configs ? flattenConfigFindings(report.configs) : []),
            ...(report.crossSkillFindings ?? []),
          ],
          minSeverity,
        ));
        console.log(JSON.stringify(toCodeClimateEntries(allFindings), null, 2));
      } else if (fmt === 'rdjson') {
        // reviewdog Diagnostic Format(home 全量)
        const allFindings: AuditFinding[] = filterByDiff(filterBySeverity(
          [
            ...report.skills.flatMap((s) => s.findings),
            ...(report.configs ? flattenConfigFindings(report.configs) : []),
            ...(report.crossSkillFindings ?? []),
          ],
          minSeverity,
        ));
        console.log(JSON.stringify(toRdJsonDocument(allFindings), null, 2));
      } else if (fmt === 'sarif') {
        // home 全量模式:合并所有 skill findings(+ configs findings)后序列化
        const allFindings: AuditFinding[] = filterByDiff(filterBySeverity(
          [
            ...report.skills.flatMap((s) => s.findings),
            ...(report.configs ? flattenConfigFindings(report.configs) : []),
            ...(report.crossSkillFindings ?? []),
          ],
          minSeverity,
        ));
        const doc = toSarifDocument(allFindings, SKILL_SWITCH_VERSION, policy.suppressedRuleIds, baselinedFingerprints);
        console.log(JSON.stringify(doc, null, 2));
      } else if (fmt === 'github') {
        // GitHub Actions 注解模式(home 全量):合并所有 skill + config findings 后输出注解。
        // 被抑制/已基线化的 finding 输出为 ::notice,不触发阻断。
        const allFindings: AuditFinding[] = filterByDiff(filterBySeverity(
          [
            ...report.skills.flatMap((s) => s.findings),
            ...(report.configs ? flattenConfigFindings(report.configs) : []),
            ...(report.crossSkillFindings ?? []),
          ],
          minSeverity,
        ));
        const annotatedFindings = applyPolicyAndBaselineToFindings(allFindings, policy, baselinedFingerprints);
        console.log(toGithubAnnotations(annotatedFindings));
      } else if (fmt === 'junit') {
        // JUnit XML 模式(home 全量):合并所有 skill findings 后序列化。
        const allFindings: AuditFinding[] = filterByDiff(filterBySeverity(
          [
            ...report.skills.flatMap((s) => s.findings),
            ...(report.configs ? flattenConfigFindings(report.configs) : []),
            ...(report.crossSkillFindings ?? []),
          ],
          minSeverity,
        ));
        // 行内抑制:合并各 skill 的 fileContents Map 来标注
        const combinedFileContents = new Map<string, string>();
        for (const skill of report.skills) {
          if (skill.fileContents) {
            for (const [file, content] of skill.fileContents) {
              combinedFileContents.set(file, content);
            }
          }
        }
        const inlineSuppressedSetHome = new Set<AuditFinding>(
          allFindings.filter((f) => isInlineSuppressed(f, combinedFileContents.get(f.file))),
        );
        const inlineSuppressedRuleIdsForJunit = new Set<string>(
          [...inlineSuppressedSetHome].map((f) => f.ruleId),
        );
        const effectiveSuppressedForJunit = new Set<string>([
          ...policy.suppressedRuleIds,
          ...inlineSuppressedRuleIdsForJunit,
        ]);
        const junitBlockingSeverities = new Set<Severity>(
          (Object.keys(SEVERITY_RANK) as Severity[]).filter(
            (s) => SEVERITY_RANK[s] <= SEVERITY_RANK[policy.failOn],
          ),
        );
        const xml = toJunitDocument(allFindings, {
          suiteName: `skill-switch-audit:${home}`,
          blockingSeverities: junitBlockingSeverities,
          suppressedRuleIds: effectiveSuppressedForJunit,
          baselinedFingerprints,
          fingerprintFn: fingerprintFinding,
        });
        process.stdout.write(xml);
      } else if (fmt === 'json') {
        // JSON 序列化:fileContents 是 Map,必须从输出中排除以保证向后兼容。
        // 使用 replacer 过滤掉 Map 实例(序列化时跳过 fileContents 键)。
        const jsonReplacer = (_key: string, value: unknown) =>
          value instanceof Map ? undefined : value;

        // --fix + json:对每个 skill 跑引导修复(dry-run 或 apply),结果嵌入对应 skill 的 guidedFix 字段。
        // 无 --fix 时:不含任何 guidedFix 键,与旧版逐字节一致。
        if (options.fix) {
          const doApply = options.apply === true;
          const skillConfigFindings = report.configs ? flattenConfigFindings(report.configs) : [];
          const skillsWithFix = await Promise.all(
            report.skills.map(async (skill) => {
              const summary = await runGuidedFix({
                targetRoot: skill.path,
                skillFindings: skill.findings,
                configFindings: skillConfigFindings,
                apply: doApply,
                backupRoot: guidedFixBackupRoot,
              });
              const base = (policyActive || baselineActive)
                ? {
                    ...skill,
                    findings: applyPolicyAndBaselineToFindings(skill.findings, policy, baselinedFingerprints),
                    blocked: shouldBlockWithPolicy(skill, policy, baselinedFingerprints),
                  }
                : skill;
              return { ...base, guidedFix: serializeGuidedFix(summary, doApply) };
            }),
          );
          console.log(JSON.stringify({ ...report, skills: skillsWithFix }, jsonReplacer, 2));
        } else if (policyActive || baselineActive) {
          // 有策略或基线:每个 skill 的 findings 附带 suppressed/baselined 字段,blocked 按策略+基线重算
          const reportWithAnnotations = {
            ...report,
            skills: report.skills.map((skill) => ({
              ...skill,
              findings: applyPolicyAndBaselineToFindings(skill.findings, policy, baselinedFingerprints),
              blocked: shouldBlockWithPolicy(skill, policy, baselinedFingerprints),
            })),
          };
          console.log(JSON.stringify(reportWithAnnotations, jsonReplacer, 2));
        } else {
          // 无策略且无基线:输出与旧版完全一致(fileContents Map 被 replacer 排除)
          console.log(JSON.stringify(report, jsonReplacer, 2));
        }
      } else {
        console.log(formatAuditHomeTable(report, baselinedFingerprints));
      }

      // 退出码决策:home 模式下逐 skill 检查(同时支持行内抑制 + --min-severity)
      const skillsBlocked = report.skills.some((skill) => {
        const filteredSkillFindings = filterBySeverity(skill.findings, minSeverity);
        const skillInlineSuppressed = new Set<AuditFinding>(
          filteredSkillFindings.filter((f) => isInlineSuppressed(f, skill.fileContents?.get(f.file))),
        );
        return shouldBlockWithAll(
          { ...skill, findings: filteredSkillFindings },
          policy,
          baselinedFingerprints,
          skillInlineSuppressed,
        );
      });
      const configBlocked = report.configsBlocked === true;
      // A4:跨-skill 协同 finding 的阻断判定(沿用 policy.failOn + 抑制 + 基线规则)。
      const crossSkillBlocked = (report.crossSkillFindings ?? []).some(
        (f) =>
          !policy.suppressedRuleIds.has(f.ruleId) &&
          !baselinedFingerprints.has(fingerprintFinding(f)) &&
          SEVERITY_RANK[f.severity] <= SEVERITY_RANK[policy.failOn],
      );
      const anyBlocked = skillsBlocked || configBlocked || crossSkillBlocked;
      if (overrideExitCode !== undefined) {
        if (anyBlocked) process.exitCode = overrideExitCode;
      } else {
        if (anyBlocked) process.exitCode = 1;
      }

      // --fix human 格式:对每个 skill 目录分别跑引导修复,打印人类可读报告。
      // json 格式已在上方 json 块中处理;sarif 格式 --fix 无输出。
      // --configs 的 finding 永远不修改(config 只读保护)。
      if (options.fix && fmt === 'human') {
        const doApply = options.apply === true;
        for (const skill of report.skills) {
          const skillConfigFindings = report.configs ? flattenConfigFindings(report.configs) : [];
          const summary = await runGuidedFix({
            targetRoot: skill.path,
            skillFindings: skill.findings,
            configFindings: skillConfigFindings,
            apply: doApply,
            backupRoot: guidedFixBackupRoot,
          });
          if (summary.results.length > 0) {
            console.log('');
            console.log(`--- ${skill.name} (${skill.path}) ---`);
            console.log(formatGuidedFixOutput(summary, doApply));
          }
        }
      }
    });
}
