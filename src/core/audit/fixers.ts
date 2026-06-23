// 受控修复器注册表。
//
// 设计约束(非常重要):
//   1. 每个修复器是纯函数 (fileContent, finding) => fileContent | null。
//      null 表示"不确定如何安全修复,跳过"。
//   2. 只修注释化(COMMENT OUT)那一行,不删除内容。
//      注释行前插入 # [skill-switch] 已隔离可疑命令(规则 <ruleId>),请人工复核。
//   3. 幂等:若目标行已经是注释或已含 skill-switch 注解,直接返回 null(原文不变)。
//   4. 只注册"单行 shell exec 类"——线条明确、撤销容易、误删风险最低。
//      规则复杂(跨行/结构性/文件级)的一律不注册,报 manual。
//
// 注册规则说明:
//   clickfix/curl-pipe-shell  — curl|bash / wget|sh 一行式安装器。
//     单行 shell 命令,注释化后完全可逆,不破坏文件结构。
//     在 Markdown 的 ``` 代码块内也只是把那一行变成注释,人工看了很容易还原。
//
//   reverse-shell/dev-tcp     — bash /dev/tcp 一行式反向 shell。
//     同上,单行 shell,注释化安全。
//
//   reverse-shell/netcat-exec — nc -e /bin/bash。
//     同上。
//
//   reverse-shell/scripting-socket — python/perl/ruby 单行 socket。
//     同上。
//
//   staged/chained-download-exec — curl -o + chmod + exec 链。
//     单行。有时 && 连接多条命令,但整行注释化安全。
//
// 未注册(需手动修复)的规则:
//   exfiltration/* — 经常混在合法 API 调用中,误判注释化风险高。
//   clickfix/copy-paste-lure — 文字描述,注释化会破坏 Markdown 可读性。
//   clickfix/gatekeeper-bypass — 有时合法工具需要这步骤。
//   persistence/* — 结构性配置,非单行。
//   global-tamper/* — 文件级规则,结构性。
//   credential-theft/* — 需人工判断是否合法使用。
//   supply-chain/* — 是否误报率高;人工确认更稳。
//   staged/prerequisite-install — 文字描述型,注释化可能误伤。
//   prompt-injection/* — 不产生单行 shell。
//   base64-payload/* — 文件级,结构性。
//   invisible-chars/* — 字符级,不适合整行注释。
//   ansi-injection/* — 字符级。
//   staged-exfil/* — 文件级。

import type { AuditFinding } from './types.ts';

/** 修复器纯函数:接受文件原文和 finding,返回修复后全文;null 表示无法安全修复。 */
export type FixerFn = (fileContent: string, finding: AuditFinding) => string | null;

/** 注释前缀(用于幂等检测和注解插入)。 */
const ANNOTATION_PREFIX = '# [skill-switch]';

/**
 * 对给定 1-based 行号进行"注释化"处理:
 *   1. 幂等保护:若该行已以 # 开头(或已含 skill-switch 注解),返回 null。
 *   2. 否则把那行替换为注释行,并在其前插入一行人工复核注解。
 *
 * 返回 null 表示无需修改(幂等)或无法修改。
 */
function commentOutLine(
  fileContent: string,
  lineNo: number,
  ruleId: string,
): string | null {
  const lines = fileContent.split('\n');
  const idx = lineNo - 1; // 转 0-based
  if (idx < 0 || idx >= lines.length) return null;

  const original = lines[idx]!;
  const trimmed = original.trimStart();

  // 幂等:已经是注释行 或 已含 skill-switch 注解 → 不重复处理
  if (trimmed.startsWith('#') || trimmed.includes('[skill-switch]')) return null;

  const annotation = `${ANNOTATION_PREFIX} 已隔离可疑命令(规则 ${ruleId}),请人工复核`;
  // 保留原行缩进前缀,注释符插在缩进后
  const indent = original.slice(0, original.length - trimmed.length);
  const commented = `${indent}# ${trimmed}`;

  const newLines = [
    ...lines.slice(0, idx),
    annotation,
    commented,
    ...lines.slice(idx + 1),
  ];
  return newLines.join('\n');
}

/** 通用单行注释化修复器工厂。 */
function makeLineCommenter(ruleId: string): FixerFn {
  return (fileContent: string, finding: AuditFinding): string | null =>
    commentOutLine(fileContent, finding.line, ruleId);
}

// ── 注册表 ─────────────────────────────────────────────────────────────────────

/**
 * ruleId → FixerFn 映射。
 * 仅注册安全可逆的单行注释化规则(见文件头注释)。
 */
export const FIXER_REGISTRY: ReadonlyMap<string, FixerFn> = new Map<string, FixerFn>([
  // ClickFix — curl|bash 一行式安装
  ['clickfix/curl-pipe-shell', makeLineCommenter('clickfix/curl-pipe-shell')],

  // 反向 shell 三类
  ['reverse-shell/dev-tcp',        makeLineCommenter('reverse-shell/dev-tcp')],
  ['reverse-shell/netcat-exec',    makeLineCommenter('reverse-shell/netcat-exec')],
  ['reverse-shell/scripting-socket', makeLineCommenter('reverse-shell/scripting-socket')],

  // 分阶段执行链(chained download → chmod → exec,单行)
  ['staged/chained-download-exec', makeLineCommenter('staged/chained-download-exec')],
]);

/** 判断某 ruleId 是否有注册修复器。 */
export function hasFixer(ruleId: string): boolean {
  return FIXER_REGISTRY.has(ruleId);
}

/**
 * 对文件内容应用一条 finding 的修复(纯函数,不写盘)。
 * 返回修复后全文;null 表示不需要修改(幂等)或无修复器。
 */
export function applyFixer(
  fileContent: string,
  finding: AuditFinding,
): string | null {
  const fixer = FIXER_REGISTRY.get(finding.ruleId);
  if (!fixer) return null;
  return fixer(fileContent, finding);
}
