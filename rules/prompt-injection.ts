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
    // 零宽空格/连接符(U+200B–U+200D)、word joiner(U+2060)、BOM(U+FEFF)——常用于藏匿注入指令。
    pattern: /[\u200B-\u200D\u2060\uFEFF]/,
    message: '出现零宽/不可见 Unicode 字符(常用于隐藏注入指令)',
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
