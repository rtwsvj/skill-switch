// Trojan-Source 双向覆盖/隔离字符检测规则。
// 威胁模型:Trojan-Source(CVE-2021-42574)及其变体——攻击者在 skill 内容里插入
// Unicode 双向覆盖或隔离控制字符,使人眼看到的代码逻辑与解析器/模型实际处理的顺序不符,
// 从而隐藏恶意指令或命令片段。
//
// 最终覆盖范围(仅高置信度攻击字符):
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
// 意图遗漏(由相邻规则处理或因误报风险已排除):
//   U+200B / U+200C / U+200D / U+FEFF — 已由 prompt-injection/zero-width-chars 覆盖(severity: medium)
//   U+200E / U+200F (LRM/RLM)         — 合法用于阿拉伯语/希伯来语/波斯语双向文本,不检测
//   U+00AD (软连字符)                  — 不足以作为高置信度攻击指标,不检测
//
// 普通中文/日文/英文/阿拉伯文/希伯来文/波斯文的正常内容不含 U+202A-202E / U+2066-2069,
// 误报率极低。本规则仅覆盖本质上从未出现在正常散文或代码中的双向控制字符。

import type { AuditFileRule, AuditFileTarget } from '../src/core/audit/types.ts';

const SECTION = '自写:Trojan-Source (CVE-2021-42574) Bidi override/isolate detection';

/**
 * 高置信度 Trojan-Source 攻击字符:双向嵌入/覆盖(U+202A–U+202E)和双向隔离(U+2066–U+2069)。
 * 这些控制字符在正常散文、代码或多语言文本(包括阿拉伯语/希伯来语/波斯语)中几乎从不出现。
 */
const BIDI_OVERRIDE_ISOLATE = /[‪-‮⁦-⁩]/;

/** 返回码位的 U+ 表示,方便摘要阅读 */
function codepointLabel(ch: string): string {
  return `U+${ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}`;
}

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

export const invisibleCharRules: AuditFileRule[] = [
  {
    id: 'obfuscation/invisible-bidi-chars',
    severity: 'high',
    message:
      '内容包含双向覆盖/隔离控制字符(U+202A–U+202E / U+2066–U+2069),可能用于 Trojan-Source 式混淆',
    source: SECTION,
    evaluate: evaluateBidi,
  },
];
