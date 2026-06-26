// v0.8-2 ci 子命令:一键生成 GitHub Actions 工作流,接入 skill-switch CI 审计。
//
// 用法:
//   skill-switch ci                    # 写 .github/workflows/skill-switch.yml(sarif 格式)
//   skill-switch ci --format github    # github 注解格式(无需 security-events: write)
//   skill-switch ci --pin v0.8.0       # 固定 action 版本
//   skill-switch ci --out path/to.yml  # 指定输出路径
//   skill-switch ci --force            # 已有文件时覆盖
//   skill-switch ci --baseline         # 同时运行 audit 写入基线文件
//   skill-switch ci --json             # 机器可读输出
//
// 安全边界:
//   - 仅在 cwd 下写文件(workflow 文件 + 可选基线文件)。
//   - 无网络、无 spawn(基线逻辑直接调模块函数)、无新依赖。
//   - 已有文件时拒绝覆盖(需 --force)。

import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { Command } from 'commander';
import { auditSkillDir } from './audit.ts';
import { buildBaselineFile, writeBaselineFile } from '../../core/audit/baseline.ts';

/** 默认 workflow 输出路径(相对 cwd) */
const DEFAULT_WORKFLOW_PATH = join('.github', 'workflows', 'skill-switch.yml');

/** 默认 action 版本引脚 */
const DEFAULT_PIN = 'v0.7.0';

/** 默认基线文件路径(相对 cwd) */
const DEFAULT_BASELINE_PATH = '.skill-switch-baseline.json';

/**
 * 生成 sarif 格式的 GitHub Actions 工作流 YAML。
 * 包含 security-events: write 权限(上传 SARIF 到 code-scanning 必需)。
 */
function buildSarifWorkflow(pin: string, baselinePath?: string): string {
  const baselineArgs = baselinePath ? ` --baseline ${baselinePath}` : '';
  return `name: skill-switch audit
on: [push, pull_request]

permissions:
  contents: read
  security-events: write   # 上传 SARIF 到 code-scanning 必需

jobs:
  audit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: rtwsvj/skill-switch@${pin}
        with:
          args: --configs${baselineArgs}
`;
}

/**
 * 生成 github 格式的 GitHub Actions 工作流 YAML。
 * github 注解格式无需 security-events: write 权限。
 */
function buildGithubWorkflow(pin: string, baselinePath?: string): string {
  const baselineArgs = baselinePath ? ` --baseline ${baselinePath}` : '';
  return `name: skill-switch audit
on: [push, pull_request]

permissions:
  contents: read   # github 注解格式只需 read 权限

jobs:
  audit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: rtwsvj/skill-switch@${pin}
        with:
          format: github
          args: --configs${baselineArgs}
`;
}

export function registerCiCommand(program: Command): void {
  program
    .command('ci')
    .description('生成 GitHub Actions 工作流,一键接入 skill-switch CI 审计(已存在则不覆盖,需 --force)')
    .option('--format <fmt>', '工作流输出格式:sarif(默认,上传 code-scanning)/ github(PR 内联注解)', 'sarif')
    .option('--pin <ref>', `Action 版本引脚(默认 ${DEFAULT_PIN})`, DEFAULT_PIN)
    .option('--out <path>', `工作流文件输出路径(默认 ${DEFAULT_WORKFLOW_PATH})`)
    .option('--force', '已有工作流文件时强制覆盖')
    .option('--baseline', `同时对当前仓库运行 audit 并写入基线文件(${DEFAULT_BASELINE_PATH}),CI 仅对新 finding 报错`)
    .option('--json', '机器可读 JSON 输出')
    .action(
      async (options: {
        format?: string;
        pin?: string;
        out?: string;
        force?: boolean;
        baseline?: boolean;
        json?: boolean;
      }) => {
        const fmt = options.format ?? 'sarif';
        const pin = options.pin ?? DEFAULT_PIN;
        const workflowPath = resolve(options.out ?? join(process.cwd(), DEFAULT_WORKFLOW_PATH));
        const baselineFilePath = options.baseline
          ? resolve(join(process.cwd(), DEFAULT_BASELINE_PATH))
          : undefined;

        // 校验 format 参数
        if (fmt !== 'sarif' && fmt !== 'github') {
          process.stderr.write(`错误: --format 仅支持 sarif 或 github,收到: ${fmt}\n`);
          process.exitCode = 1;
          return;
        }

        // 已有 workflow 文件时拒绝覆盖(除非 --force)
        if (!options.force && existsSync(workflowPath)) {
          process.stderr.write(
            `错误: 工作流文件已存在: ${workflowPath}\n` +
            `  用 --force 强制覆盖,或用 --out <path> 指定其他路径。\n`,
          );
          process.exitCode = 1;
          return;
        }

        // ── 可选基线写入 ────────────────────────────────────────────────────────
        let baselineFingerprintCount = 0;
        if (baselineFilePath !== undefined) {
          try {
            // 对当前目录运行 audit 获取所有 finding
            const report = await auditSkillDir(process.cwd());
            const baseline = buildBaselineFile(report.findings);
            await writeBaselineFile(baselineFilePath, baseline);
            baselineFingerprintCount = baseline.fingerprints.length;
          } catch (err) {
            process.stderr.write(
              `错误: 无法写入基线文件 ${baselineFilePath}: ${(err as Error).message}\n`,
            );
            process.exitCode = 1;
            return;
          }
        }

        // ── 生成工作流 YAML ─────────────────────────────────────────────────────
        // 基线路径在 workflow 里用相对路径(相对仓库根),保持跨机器兼容
        const baselineRelPath = options.baseline ? DEFAULT_BASELINE_PATH : undefined;
        const workflowContent =
          fmt === 'github'
            ? buildGithubWorkflow(pin, baselineRelPath)
            : buildSarifWorkflow(pin, baselineRelPath);

        // 确保父目录存在
        await mkdir(dirname(workflowPath), { recursive: true });
        await writeFile(workflowPath, workflowContent, 'utf8');

        // ── 输出 ────────────────────────────────────────────────────────────────
        const filesWritten: string[] = [workflowPath];
        if (baselineFilePath !== undefined) filesWritten.push(baselineFilePath);

        if (options.json) {
          const result: Record<string, unknown> = {
            status: 'ok',
            workflowPath,
            format: fmt,
            pin,
            filesWritten,
          };
          if (baselineFilePath !== undefined) {
            result.baselinePath = baselineFilePath;
            result.baselineFingerprintCount = baselineFingerprintCount;
          }
          console.log(JSON.stringify(result, null, 2));
          return;
        }

        // 人类可读输出
        console.log(`已写入工作流文件: ${workflowPath}`);
        if (baselineFilePath !== undefined) {
          console.log(`已写入基线文件:   ${baselineFilePath}(${baselineFingerprintCount} 条 finding)`);
        }

        // 下一步提示
        console.log('');
        console.log('下一步:');

        const filesToCommit = filesWritten.map((f) => `  ${f}`).join('\n');
        console.log(`1. 提交以下文件到仓库:`);
        console.log(filesToCommit);

        if (fmt === 'sarif') {
          console.log('2. 确认仓库已开启 GitHub Advanced Security / code-scanning。');
          console.log('   (Settings → Security → Code security and analysis → Code scanning)');
        } else {
          console.log('2. 合并 PR 后,findings 会直接以注解形式显示在 PR diff 上。');
        }

        if (baselineFilePath !== undefined) {
          console.log('3. 工作流已自动配置 --baseline 参数,CI 只对新 finding 报错。');
        }
      },
    );
}
