// ANSI 转义序列 / 终端控制序列注入检测规则。
// 威胁模型:攻击者在 skill 内容(SKILL.md / instructions)里嵌入原始 ESC 字节(U+001B),
// 利用 CSI/OSC/其他 ANSI 引导符操控终端显示:隐藏文字、伪造输出、移动光标,
// 实现混淆或注入——此向量已被 trailofbits/mcp-context-protector 明确标记。
//
// 精度保障(关键):
//   - 只检测原始 ESC 控制字节(U+001B, 0x1B);
//   - 文档里写作字面文本的 `\x1b`、`\033`、`ESC[` 等字符串 **不** 含真正的 ESC 字节,
//     因此绝对不会被误报。
//   - 普通英文/中文/日文/阿拉伯文/代码 skill 内容从不含原始 ESC 字节,误报率极低。
//   - 检测范围:ESC 后跟 `[`(CSI)、`]`(OSC)、`(`/`)`/`>`(字符集/私用)、
//     `P`(DCS)、`^`/`_`(SOS/APC)或独立 ESC(只有 ESC 字节本身)均视为可疑。
//
// 实现说明:
//   使用 String.fromCodePoint(0x1b) 得到 ESC 字符常量,再以 indexOf / includes 检测,
//   避免在正则字面量中直接写控制字符(biome noControlCharactersInRegex 规则)。
//   replace 同理,用 new RegExp(ESC_CHAR, 'g') 构造。
//
// 来源:自写 — 参照 trailofbits/mcp-context-protector 风险分析(ANSI/terminal injection)。

import type { AuditFileRule, AuditFileTarget } from '../src/core/audit/types.ts';

const SECTION = '自写:ANSI escape / terminal control sequence injection (ref: trailofbits/mcp-context-protector)';

// 原始 ESC 字节(U+001B)字符串常量——通过 fromCodePoint 构造,不写字面量。
const ESC_CHAR: string = String.fromCodePoint(0x1b);

// 用于快速扫描整体内容,及在 replace 时替换全部 ESC 字节
const ESC_RE_GLOBAL: RegExp = new RegExp(ESC_CHAR, 'g');

/** 返回码位的 U+ 表示 */
function codepointLabel(ch: string): string {
  return `U+${ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}`;
}

/** 将 ESC 后续引导符映射为人可读名称 */
function introducer(following: string | undefined): string {
  if (!following) return '(孤立 ESC)';
  switch (following) {
    case '[': return 'CSI (Control Sequence Introducer)';
    case ']': return 'OSC (Operating System Command)';
    case 'P': return 'DCS (Device Control String)';
    case '^': return 'SOS (Start of String)';
    case '_': return 'APC (Application Program Command)';
    case '(': return '字符集指定 G0';
    case ')': return '字符集指定 G1';
    case '>': return '私用模式';
    default:  return `引导符 0x${following.codePointAt(0)!.toString(16).toUpperCase()}`;
  }
}

function evaluateAnsiInjection(target: AuditFileTarget): { line: number; excerpt: string } | null {
  // 快速路径:整体扫描一次,无命中则立即返回
  if (!target.content.includes(ESC_CHAR)) return null;

  const lines = target.content.split('\n');
  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const line = lines[lineIdx]!;
    const idx = line.indexOf(ESC_CHAR);
    if (idx === -1) continue;

    const following = line[idx + 1];
    const name = introducer(following);
    // 截取命中上下文(最多 120 字符),将原始 ESC 替换为可读占位符以免污染终端
    const safe = line.replace(ESC_RE_GLOBAL, '<ESC>').slice(0, 120);
    return {
      line: lineIdx + 1,
      excerpt: `发现原始 ESC 字节 ${codepointLabel(ESC_CHAR)} — ${name} — "${safe}"`,
    };
  }
  return null;
}

export const ansiInjectionRules: AuditFileRule[] = [
  {
    id: 'obfuscation/ansi-escape-injection',
    severity: 'high',
    message:
      '内容包含原始 ANSI 转义序列(ESC U+001B),可操控终端显示、隐藏文字或伪造输出,疑似注入攻击',
    source: SECTION,
    evaluate: evaluateAnsiInjection,
  },
];
