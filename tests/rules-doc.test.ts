// Sync test: 确保 docs/rules.md 记录了代码中每一个可能 emit 的 ruleId。
//
// 枚举策略：
//   1. rules/ 目录：直接 import allRules + allFileRules（导出数组），取每条规则的 .id 字段。
//      不用正则扫描文件——类型系统保证 id 字段就是运行时 emit 的 ruleId，不会有假阴性。
//
//   2. mcp-audit.ts / settings-audit.ts：这两个文件直接把 ruleId 字符串字面量传给内部
//      finding() 辅助函数。它们不导出 ruleId 列表，所以用正则扫描源文件。
//      避免假阴性的措施：
//        a. 跳过以 // 开头的纯注释行和以 * 开头的块注释行（注释里有大量对 ruleId 的引用）。
//        b. 只匹配 category/name 形态的字符串字面量（单引号 + 小写 + 连字符 + /）。
//        c. 这两个文件中的 ruleId 字面量均为单引号、无变量插值，正则完全覆盖。
//
// 假阴性风险：
//   - allRules / allFileRules 是运行时数组，import 拿到的 id 与实际 emit 的 ruleId 完全
//     一一对应，不存在假阴性。
//   - 源文件扫描排除注释行后，剩余的 'category/name' 字面量只有两种用途：
//       i. 作为 finding() 的第一个参数（ruleId）← 我们需要
//      ii. 作为 RISKY_INLINE / SECRET_VALUE_PATTERNS 等常量对象的 ruleId 字段值 ← 同样需要
//     这两种都应在文档中出现，无需进一步筛选。
//
// 假阳性风险：
//   - 扫描文件时若字符串字面量碰巧是 'category/name' 形态但不是真正的 ruleId，会产生假阳性。
//     经检查：mcp-audit.ts / settings-audit.ts 中唯一符合该格式的字符串字面量就是 ruleId，
//     不存在其他同形态的普通字符串，风险极低。

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { allFileRules, allRules } from '../rules/index.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// ── 1. 从 rules/ 导出的数组拿 ruleId ──────────────────────────────────────────

function collectRulesRuleIds(): Set<string> {
  const ids = new Set<string>();
  for (const rule of allRules) {
    ids.add(rule.id);
  }
  for (const rule of allFileRules) {
    ids.add(rule.id);
  }
  return ids;
}

// ── 2. 扫描 mcp-audit.ts / settings-audit.ts 拿内联 ruleId ──────────────────

/**
 * 匹配单引号括起来的 category/name 形态字符串字面量：
 *   'mcp/some-rule-name'
 *   'settings/hook-curl-pipe-sh'
 *
 * 格式：小写字母开头，category 和 name 均只含小写字母、数字、连字符。
 * 不含大写，不含路径分隔符以外的 /，不匹配双引号（避免混入 JSX 属性等）。
 */
const INLINE_RULE_ID_RE = /'([a-z][a-z0-9-]*\/[a-z0-9-]+)'/g;

function scanSourceFileForRuleIds(absPath: string): Set<string> {
  const ids = new Set<string>();
  const content = readFileSync(absPath, 'utf8');

  for (const rawLine of content.split('\n')) {
    const trimmed = rawLine.trim();
    // 跳过纯注释行（// 注释、* 块注释行）
    if (trimmed.startsWith('//') || trimmed.startsWith('*')) continue;

    INLINE_RULE_ID_RE.lastIndex = 0;
    let m = INLINE_RULE_ID_RE.exec(rawLine);
    while (m !== null) {
      ids.add(m[1]!);
      m = INLINE_RULE_ID_RE.exec(rawLine);
    }
  }
  return ids;
}

function collectInlineRuleIds(): Set<string> {
  const ids = new Set<string>();
  const filesToScan = [
    join(ROOT, 'src/core/audit/mcp-audit.ts'),
    join(ROOT, 'src/core/audit/settings-audit.ts'),
    join(ROOT, 'src/core/audit/config-baseline.ts'),
  ];
  for (const f of filesToScan) {
    for (const id of scanSourceFileForRuleIds(f)) {
      ids.add(id);
    }
  }
  return ids;
}

// ── 3. 读取 docs/rules.md，提取其中出现的所有 ruleId ─────────────────────────

/**
 * 文档中 ruleId 以反引号括起来出现：`exfiltration/curl-body-with-secret`
 * 仅匹配该格式，与代码扫描的单引号格式正交，无重叠。
 */
const DOC_RULE_ID_RE = /`([a-z][a-z0-9-]*\/[a-z0-9-]+)`/g;

function collectDocRuleIds(): Set<string> {
  const ids = new Set<string>();
  const doc = readFileSync(join(ROOT, 'docs/rules.md'), 'utf8');
  let m = DOC_RULE_ID_RE.exec(doc);
  while (m !== null) {
    ids.add(m[1]!);
    m = DOC_RULE_ID_RE.exec(doc);
  }
  return ids;
}

// ── 4. 测试 ───────────────────────────────────────────────────────────────────

describe('rules-doc sync', () => {
  it('docs/rules.md 包含 rules/ 中每一个 ruleId', () => {
    const codeIds = collectRulesRuleIds();
    const docIds = collectDocRuleIds();

    const missing = [...codeIds].filter((id) => !docIds.has(id)).sort();
    expect(missing, `以下 ruleId 在 rules/ 代码中存在但 docs/rules.md 未记录:\n${missing.join('\n')}`).toEqual([]);
  });

  it('docs/rules.md 包含 mcp-audit.ts / settings-audit.ts 中每一个内联 ruleId', () => {
    const inlineIds = collectInlineRuleIds();
    const docIds = collectDocRuleIds();

    const missing = [...inlineIds].filter((id) => !docIds.has(id)).sort();
    expect(missing, `以下内联 ruleId 在审计源文件中存在但 docs/rules.md 未记录:\n${missing.join('\n')}`).toEqual([]);
  });

  it('所有 ruleId 均符合 category/name 命名规范（小写 + 连字符）', () => {
    const codeIds = new Set([...collectRulesRuleIds(), ...collectInlineRuleIds()]);
    const VALID_RE = /^[a-z][a-z0-9-]*\/[a-z][a-z0-9-]*$/;

    const invalid = [...codeIds].filter((id) => !VALID_RE.test(id)).sort();
    expect(invalid, `以下 ruleId 不符合命名规范:\n${invalid.join('\n')}`).toEqual([]);
  });
});
