// Prompt-injection / 隐藏指令规则。对齐 Snyk SkillSpector「hidden instructions / prompt
// injection」类目(见 docs/research/competitive-landscape.md C8)。检测:试图覆盖既有指令、
// 指示对用户隐瞒行为、用零宽字符或 CSS 藏匿对模型的文本。
// 注:instruction-override / conceal 为 high(会触发 severity-floor 阻断);误报由 F-C2
// 「填原因强制安装」兜底(讲解 prompt injection 的安全类 skill 可走该旁路)。
import type { AuditRule } from '../src/core/audit/types.ts';

const SECTION = '自写:对齐 Snyk SkillSpector「hidden instructions / prompt injection」(M1 competitive C8)';

export const promptInjectionRules: AuditRule[] = [
  {
    id: 'prompt-injection/instruction-override',
    severity: 'high',
    // 「ignore/disregard/forget/override … previous/prior/above/all … instructions」
    pattern: /\b(?:ignore|disregard|forget|override)\b[^\n]{0,40}\b(?:previous|prior|above|earlier|all|any|your|the)\b[^\n]{0,24}\binstructions?\b/i,
    message: '试图覆盖/忽略既有指令(典型 prompt injection)',
    source: SECTION,
  },
  {
    id: 'prompt-injection/conceal-from-user',
    severity: 'high',
    // 「do not / don't / without … tell/inform/reveal/notify/warn … (the) user」
    pattern: /\b(?:do not|don't|never|without|avoid)\b[^\n]{0,30}\b(?:tell|telling|inform|informing|notify|notifying|mention|mentioning|reveal|revealing|alert|alerting|warn|warning|show|showing)\b[^\n]{0,20}\buser\b/i,
    message: '指示对用户隐瞒行为(隐藏指令 / 声明与行为不符迹象)',
    source: SECTION,
  },
  {
    id: 'prompt-injection/zero-width-chars',
    severity: 'medium',
    // 零宽空格 U+200B、word joiner U+2060、BOM U+FEFF——从不出现在合法 emoji/文字排版中,任意位置出现即报。
    // ZWNJ U+200C / ZWJ U+200D 另有合法用途:emoji ZWJ 序列(家庭/职业/彩虹旗 emoji)与波斯语/印度系文字靠它们连接,
    // 这些场景相邻码点为非 ASCII(emoji 为 astral 代理对,亦非 [A-Za-z]),不应误报;
    // 仅当 ZWNJ/ZWJ 紧贴 ASCII 字母(把关键词如 IGNORE / system 拆开绕过扫描)才报——真实 evasion 签名。
    //
    // RE2 兼容重写:原版用 lookbehind (?<=[A-Za-z]) 和 lookahead (?=[A-Za-z]),RE2 不支持。
    // 等价重写:把相邻的 ASCII 字母纳入匹配主体——
    //   [A-Za-z][\u200C\u200D]  — ASCII 字母后接 ZWNJ/ZWJ(等价于原 lookbehind 分支)
    //   [\u200C\u200D][A-Za-z]  — ZWNJ/ZWJ 后接 ASCII 字母(等价于原 lookahead 分支)
    // 语义等价:test() 只看"有无匹配",相邻字母被消费不影响命中/不命中的二值结果。
    // 边界验证:A+ZWNJ→hit、ZWJ+B→hit、emoji ZWJ→miss(emoji 非[A-Za-z])、阿拉伯 ZWNJ→miss。
    pattern: /[\u200B\u2060\uFEFF]|[A-Za-z][\u200C\u200D]|[\u200C\u200D][A-Za-z]/,
    message: '出现零宽/不可见 Unicode 字符(常用于隐藏注入指令或拆词绕过扫描)',
    source: SECTION,
  },
  {
    id: 'prompt-injection/hidden-style-text',
    severity: 'medium',
    // 用 CSS 把文本藏起来(display:none / 字号 0 / visibility:hidden / 白底白字)。
    pattern: /style\s*=\s*["'][^"'\n]*(?:display\s*:\s*none|font-size\s*:\s*0|visibility\s*:\s*hidden|color\s*:\s*#?f{3,6}\b)/i,
    message: '用 CSS 隐藏文本(可能藏匿对模型的指令)',
    source: SECTION,
  },
];
