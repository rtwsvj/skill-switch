// Trojan-Source + 隐藏指令不可见字符检测规则。
// 威胁模型:
//   1. Trojan-Source(CVE-2021-42574)及其变体——攻击者在 skill 内容里插入
//      Unicode 双向覆盖或隔离控制字符,使人眼看到的代码逻辑与解析器/模型实际处理的顺序不符。
//   2. LLM 隐藏指令——攻击者用 Unicode Tag 字符(U+E0000–U+E007F)把人眼看不到但模型仍能
//      读取的文本藏入 skill,实现"让 LLM 执行隐秘指令"攻击。
//   3. 废弃格式字符(U+206A–U+206F)与不可见数学运算符(U+2061–U+2064)——在正常散文或
//      代码中几乎从不出现,出现即为可疑。
//
// ── 当前覆盖范围(仅高置信度攻击字符) ────────────────────────────────────────
//
// 规则 1: obfuscation/invisible-bidi-chars
//   U+202A  LRE  Left-to-Right Embedding
//   U+202B  RLE  Right-to-Left Embedding
//   U+202C  PDF  Pop Directional Formatting
//   U+202D  LRO  Left-to-Right Override
//   U+202E  RLO  Right-to-Left Override
//   U+2066  LRI  Left-to-Right Isolate
//   U+2067  RLI  Right-to-Left Isolate
//   U+2068  FSI  First Strong Isolate
//   U+2069  PDI  Pop Directional Isolate
//
// 规则 2: obfuscation/unicode-tag-chars
//   U+E0000–U+E007F  Unicode Tag 字符块(可编码隐藏 ASCII 文本)
//   这些字符对人眼完全不可见,但 LLM 在 token 层可以处理它们。在 skill 文件中
//   几乎没有任何合法用途;标准 Unicode 仅将其用于特定的语言标记应用,与 skill
//   内容无关。
//
// 规则 3: obfuscation/invisible-math-operators
//   U+2061  INVISIBLE FUNCTION APPLICATION
//   U+2062  INVISIBLE TIMES
//   U+2063  INVISIBLE SEPARATOR
//   U+2064  INVISIBLE PLUS
//   这些字符专为数学 ML/MathML 标记设计,不应出现在 skill 散文或 shell 脚本中。
//
// 规则 4: obfuscation/deprecated-bidi-format
//   U+206A  INHIBIT SYMMETRIC SWAPPING
//   U+206B  ACTIVATE SYMMETRIC SWAPPING
//   U+206C  INHIBIT ARABIC FORM SHAPING
//   U+206D  ACTIVATE ARABIC FORM SHAPING
//   U+206E  NATIONAL DIGIT SHAPES
//   U+206F  NOMINAL DIGIT SHAPES
//   Unicode 3.0 已将其废弃(deprecated in UAX #9);在任何合法现代文本中均不应出现。
//
// ── 有意排除(已由相邻规则覆盖或误报风险已排除) ────────────────────────────
//   U+200B / U+200C / U+200D / U+2060 / U+FEFF — 已由 prompt-injection/zero-width-chars 覆盖(severity: medium)
//   U+200E / U+200F (LRM/RLM)                  — 合法用于阿拉伯语/希伯来语/波斯语双向文本,不检测
//   U+00AD (软连字符)                            — 合法用于断字排版,不检测
//
// ── 语言/格式安全性 ────────────────────────────────────────────────────────
//   普通中/日/韩/阿拉伯语/希伯来语/波斯语散文、Emoji ZWJ 序列、UTF-8 BOM 文件
//   均不含以上字符,误报率极低。

import type { AuditFileRule, AuditFileTarget } from '../src/core/audit/types.ts';

const SECTION = '自写:Trojan-Source (CVE-2021-42574) Bidi override/isolate detection + Unicode Tag char LLM hiding';

// ── 字符集 ────────────────────────────────────────────────────────────────────

/**
 * 高置信度 Trojan-Source 攻击字符:双向嵌入/覆盖(U+202A–U+202E)和双向隔离(U+2066–U+2069)。
 * 这些控制字符在正常散文、代码或多语言文本(包括阿拉伯语/希伯来语/波斯语)中几乎从不出现。
 */
const BIDI_OVERRIDE_ISOLATE = /[‪-‮⁦-⁩]/;

/**
 * Unicode Tag 字符块 (U+E0000–U+E007F)。
 * 这些字符能以人眼不可见的方式编码完整的 ASCII 文本,已被用于向 LLM 注入隐藏指令。
 * 在 skill 文件等任何非专用 Unicode 语言标记应用中没有合法用途。
 * 需要 /u 标志以访问补充多语言平面(SMP)码位。
 */
const UNICODE_TAG_CHARS = /[\u{E0000}-\u{E007F}]/u;

/**
 * 不可见数学运算符 (U+2061–U+2064)。
 * 仅用于 MathML/数学语义标记;在 skill 散文或 shell 脚本中毫无用途。
 * 出现即为可疑。
 */
const INVISIBLE_MATH_OPERATORS = /[⁡-⁤]/;

/**
 * Unicode 3.0 废弃双向格式字符 (U+206A–U+206F)。
 * 已在 UAX #9 中废弃;任何合法现代软件均不应生成这些字符。
 */
const DEPRECATED_BIDI_FORMAT = /[⁪-⁯]/;

// ── 工具函数 ─────────────────────────────────────────────────────────────────

/** 返回码位的 U+ 表示,方便摘要阅读 */
function codepointLabel(ch: string): string {
  return `U+${ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}`;
}

// ── 评估函数 ─────────────────────────────────────────────────────────────────

function evaluateBidi(target: AuditFileTarget): { line: number; excerpt: string } | null {
  if (!BIDI_OVERRIDE_ISOLATE.test(target.content)) return null;

  const lines = target.content.split('\n');
  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const line = lines[lineIdx]!;
    for (const ch of line) {
      if (BIDI_OVERRIDE_ISOLATE.test(ch)) {
        return {
          line: lineIdx + 1,
          excerpt: `发现双向覆盖/隔离控制字符 ${codepointLabel(ch)} — "${line.trim().slice(0, 120)}"`,
        };
      }
    }
  }
  return null;
}

function evaluateTagChars(target: AuditFileTarget): { line: number; excerpt: string } | null {
  if (!UNICODE_TAG_CHARS.test(target.content)) return null;

  const lines = target.content.split('\n');
  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const line = lines[lineIdx]!;
    // 用迭代器遍历以正确处理补充平面字符(每个字符占 2 个 UTF-16 代码单元)
    for (const ch of line) {
      if (UNICODE_TAG_CHARS.test(ch)) {
        return {
          line: lineIdx + 1,
          excerpt: `发现 Unicode Tag 字符 ${codepointLabel(ch)}(U+E0000–U+E007F)— 可编码隐藏 ASCII 指令 — "${line.trim().slice(0, 100)}"`,
        };
      }
    }
  }
  return null;
}

function evaluateInvisibleMath(target: AuditFileTarget): { line: number; excerpt: string } | null {
  if (!INVISIBLE_MATH_OPERATORS.test(target.content)) return null;

  const lines = target.content.split('\n');
  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const line = lines[lineIdx]!;
    for (const ch of line) {
      if (INVISIBLE_MATH_OPERATORS.test(ch)) {
        return {
          line: lineIdx + 1,
          excerpt: `发现不可见数学运算符 ${codepointLabel(ch)}(U+2061–U+2064)— 非 MathML 上下文中可疑 — "${line.trim().slice(0, 110)}"`,
        };
      }
    }
  }
  return null;
}

function evaluateDeprecatedBidi(target: AuditFileTarget): { line: number; excerpt: string } | null {
  if (!DEPRECATED_BIDI_FORMAT.test(target.content)) return null;

  const lines = target.content.split('\n');
  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const line = lines[lineIdx]!;
    for (const ch of line) {
      if (DEPRECATED_BIDI_FORMAT.test(ch)) {
        return {
          line: lineIdx + 1,
          excerpt: `发现 Unicode 废弃双向格式字符 ${codepointLabel(ch)}(U+206A–U+206F)— 已废弃,任何合法现代文本均不应包含 — "${line.trim().slice(0, 100)}"`,
        };
      }
    }
  }
  return null;
}

// ── 规则导出 ─────────────────────────────────────────────────────────────────

export const invisibleCharRules: AuditFileRule[] = [
  {
    id: 'obfuscation/invisible-bidi-chars',
    severity: 'high',
    message:
      '内容包含双向覆盖/隔离控制字符(U+202A–U+202E / U+2066–U+2069),可能用于 Trojan-Source 式混淆',
    source: SECTION,
    evaluate: evaluateBidi,
  },
  {
    id: 'obfuscation/unicode-tag-chars',
    severity: 'high',
    message:
      '内容包含 Unicode Tag 字符(U+E0000–U+E007F),可编码对人眼不可见的 ASCII 指令——常见 LLM 隐藏注入载体',
    source: SECTION,
    evaluate: evaluateTagChars,
  },
  {
    id: 'obfuscation/invisible-math-operators',
    severity: 'high',
    message:
      '内容包含不可见数学运算符(U+2061–U+2064),在非 MathML 上下文中可疑——可用于隐藏文本片段',
    source: SECTION,
    evaluate: evaluateInvisibleMath,
  },
  {
    id: 'obfuscation/deprecated-bidi-format',
    severity: 'high',
    message:
      '内容包含 Unicode 3.0 废弃双向格式字符(U+206A–U+206F),任何合法现代文本均不应包含',
    source: SECTION,
    evaluate: evaluateDeprecatedBidi,
  },
];
