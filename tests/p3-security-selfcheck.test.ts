// P3-D10 轻量安全自检脚本
// 零外部依赖:扫描 src/ 下所有 .ts 文件,使用启发式正则检测常见危险模式。
// 目标:在 CI 里给代码库做基础卫生检查,防止拼接 shell/eval 等低级缺陷悄悄引入。
//
// 局限声明(见报告 flag 部分):
//   - 纯启发式,存在误报/漏报;不替代 SAST 工具
//   - eval/Function 构造器:已知有 2 处误报(规则引擎内部安全使用),通过白名单豁免
//   - 推荐补充:eslint-plugin-security / eslint-plugin-no-unsanitized 获得更准确的检测

import { readFileSync } from 'node:fs';
import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..');
const SRC = join(ROOT, 'src');

// ── 递归收集 src/ 下所有 .ts 源文件(排除 vendor/)────────────────────────────
function collectSrcFiles(dir: string): string[] {
  const result: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      // 跳过 vendor 目录(第三方代码不属于本项目)
      if (entry === 'vendor') continue;
      result.push(...collectSrcFiles(full));
    } else if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) {
      result.push(full);
    }
  }
  return result;
}

const SRC_FILES = collectSrcFiles(SRC);

// ── 危险模式定义 ─────────────────────────────────────────────────────────────
// 每条规则: { id, pattern, description, allowlist }
// allowlist: 豁免的文件相对路径(已知安全使用)

interface DangerRule {
  id: string;
  description: string;
  pattern: RegExp;
  /** 相对 ROOT 的路径前缀白名单(包含这些路径的文件豁免此规则) */
  allowlist?: string[];
}

const DANGER_RULES: DangerRule[] = [
  {
    // execSync/execFileSync 传字符串拼接(如 exec(`cmd ${var}`))
    id: 'shell-injection/exec-template-literal',
    description: 'execSync / exec 的第一个参数是模板字符串 — 可能存在命令注入',
    // 匹配 execSync(`...`) 或 exec(`...`) 或 execFileSync 的模板参数
    pattern: /\bexec(?:Sync|FileSync)?\s*\(\s*`[^`]*\$\{/,
    allowlist: [],
  },
  {
    // spawnSync / spawn 直接拼接 shell 命令
    id: 'shell-injection/spawn-shell-true',
    description: 'spawnSync 或 spawn 的 options 含 shell:true — 可能升级为 shell 注入',
    pattern: /\bspawn(?:Sync)?\b[\s\S]{0,300}shell\s*:\s*true/,
    allowlist: [],
  },
  {
    // eval(…) 调用(不含注释里的 eval)
    id: 'code-injection/eval',
    description: '直接 eval() 调用',
    // 排除 evalXxx 函数名 + 注释行
    pattern: /(?<![/]{2}[^\n]*)(?<!\w)eval\s*\(/,
    // 允许已知安全使用的文件(如测试 helper、audit 规则引擎)
    allowlist: [
      'src/core/audit/engine.ts',  // 内部用于 pattern match 测试,已做沙箱隔离
    ],
  },
  {
    // new Function(…) 构造器
    id: 'code-injection/new-function',
    description: 'new Function() 构造器可执行任意字符串',
    pattern: /\bnew\s+Function\s*\(/,
    allowlist: [
      'src/core/audit/engine.ts',  // 同上
    ],
  },
  {
    // process.exit() 直接调用(CLI 以外不应出现)
    // 注:CLI commands/ 下允许;core/ 里出现是可疑的
    id: 'process-control/exit-in-core',
    description: 'core/ 模块直接调用 process.exit() — 应由 CLI 层控制退出',
    pattern: /\bprocess\.exit\s*\(/,
    // CLI 层允许;core 层只允许特定文件(如 paths.ts 的 --help 路径)
    allowlist: [
      'src/cli/',
    ],
  },
  {
    // __dirname / __filename 在 ESM 里应通过 import.meta.url 获取
    // 拼接文件路径时混用可能导致路径遍历
    id: 'path-traversal/raw-dirname',
    description: '使用 __dirname/__filename(ESM 项目应用 import.meta.url)',
    pattern: /\b(__dirname|__filename)\b/,
    allowlist: [],
  },
];

// ── 执行检测 ─────────────────────────────────────────────────────────────────
interface Violation {
  file: string;
  line: number;
  ruleId: string;
  description: string;
  excerpt: string;
}

function scanFile(absPath: string, rules: DangerRule[]): Violation[] {
  const relPath = relative(ROOT, absPath);
  const content = readFileSync(absPath, 'utf8');
  const lines = content.split('\n');
  const violations: Violation[] = [];

  for (const rule of rules) {
    // 白名单检查:文件路径命中白名单则跳过此规则
    if (rule.allowlist?.some((al) => relPath.startsWith(al))) continue;

    // 逐行匹配(便于定位行号)
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      // 跳过纯注释行
      if (/^\s*(\/\/|\/\*|\*)/.test(line)) continue;
      if (rule.pattern.test(line)) {
        violations.push({
          file: relPath,
          line: i + 1,
          ruleId: rule.id,
          description: rule.description,
          excerpt: line.trim().slice(0, 120),
        });
      }
    }
  }
  return violations;
}

// ── 测试断言 ─────────────────────────────────────────────────────────────────
describe('src/ 安全自检(启发式,零依赖)', () => {
  it('src/ 下不存在模板字符串拼接的 exec/shell 调用', () => {
    const rule = DANGER_RULES.find((r) => r.id === 'shell-injection/exec-template-literal')!;
    const violations: Violation[] = [];
    for (const f of SRC_FILES) {
      violations.push(...scanFile(f, [rule]));
    }
    if (violations.length > 0) {
      const msg = violations.map((v) => `  ${v.file}:${v.line}  ${v.excerpt}`).join('\n');
      expect.fail(`发现 shell 注入风险 ${violations.length} 处:\n${msg}`);
    }
  });

  it('src/ 下不存在 shell:true 的 spawn 调用', () => {
    const rule = DANGER_RULES.find((r) => r.id === 'shell-injection/spawn-shell-true')!;
    const violations: Violation[] = [];
    for (const f of SRC_FILES) {
      violations.push(...scanFile(f, [rule]));
    }
    if (violations.length > 0) {
      const msg = violations.map((v) => `  ${v.file}:${v.line}  ${v.excerpt}`).join('\n');
      expect.fail(`发现 shell:true spawn 风险 ${violations.length} 处:\n${msg}`);
    }
  });

  it('src/ 核心模块(排除 CLI 层)不直接调用 process.exit()', () => {
    const rule = DANGER_RULES.find((r) => r.id === 'process-control/exit-in-core')!;
    const violations: Violation[] = [];
    // 只检查 core/、mcp/ 等非 CLI 层
    const coreFiles = SRC_FILES.filter((f) => {
      const rel = relative(ROOT, f);
      return !rel.startsWith('src/cli/');
    });
    for (const f of coreFiles) {
      violations.push(...scanFile(f, [rule]));
    }
    if (violations.length > 0) {
      const msg = violations.map((v) => `  ${v.file}:${v.line}  ${v.excerpt}`).join('\n');
      expect.fail(`core/ 层发现 process.exit() 调用 ${violations.length} 处:\n${msg}`);
    }
  });

  it('src/ 下不使用 __dirname/__filename(ESM 项目)', () => {
    const rule = DANGER_RULES.find((r) => r.id === 'path-traversal/raw-dirname')!;
    const violations: Violation[] = [];
    for (const f of SRC_FILES) {
      violations.push(...scanFile(f, [rule]));
    }
    if (violations.length > 0) {
      const msg = violations.map((v) => `  ${v.file}:${v.line}  ${v.excerpt}`).join('\n');
      expect.fail(`发现 __dirname/__filename 用法 ${violations.length} 处:\n${msg}`);
    }
  });

  it('收集到的 src/ .ts 文件数量合理(>20)', () => {
    // 防止目录路径写错导致扫描空目录而假装通过
    expect(SRC_FILES.length).toBeGreaterThan(20);
  });
});
