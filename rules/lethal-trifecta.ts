// 「致命三要素」(Lethal Trifecta)能力合成检测 — advisory 规则。
//
// 威胁模型(Simon Willison 提出、OWASP 2026 Agentic 目录收录):
// 一个 agent/skill **同时**具备三种能力时,即便代码本身无漏洞,也可能被一段
// 投毒内容(恶意 URL / issue 正文 / PR 评论 / 邮件正文等)诱导外泄数据:
//   1. axis-1 读私有数据(env / 凭据 / 历史 / 浏览器 / 钱包)
//   2. axis-2 摄入不可信内容并据此行动(读 web / issue / email 正文 / PR 评论
//      等攻击者可控输入并作为指令执行)
//   3. axis-3 对外发送(curl -d / fetch POST / nc / scp 等)
//
// 本规则**复用** `rules/taint.ts` 已实现的两轴(axis-1 / axis-3)逐行判定
// —— `privateDataAccessLine` 与 `externalCommLine` 即为 TF-1 重构的导出;
// 仅新增 axis-2(不可信内容摄入)与合成判定。
//
// 与既有 taint 的分工:
//   - taint 抓「同一文件近距离 source→sink 链」(数据已成形开始外渗);
//   - lethal-trifecta 抓「能力共存」(即便三者不在一条链上,
//     skill 仍然可能被诱导后发生外渗)。前者 high,后者 medium(advisory)。
//
// 定位:report-only。三轴俱全才返回 finding,默认不改退出码、不阻断 CI,
// 与既有 finding 共存,各自独立计入(详见 `applyPolicy*` 通路)。
//
// ── 设计取舍(为什么这条规则宁可漏报) ────────────────────────────────────────
//   - axis-2 故意不强制命令上下文门控:摄入常是自然语言指令,
//     与 axis-1/axis-3 的代码/命令上下文不同。
//   - 自然语言路径用「this/the following/these」桥接词收紧边界,避免
//     「read the config file」「fetch data from API」之类正常描述误中。
//   - 攻击者可控容器名词表刻意不含「file」「input」「content」之类通用词
//     (尽管规格草稿列出),这些词在合法 skill 文档里出现频率太高,
//     包含会破坏「良性样本零误报」硬约束。
//   - 全部正则线性、定界常量,RE2 安全。
import type { AuditFileRule, AuditFileTarget } from '../src/core/audit/types.ts';
import { externalCommLine, privateDataAccessLine } from './taint.ts';

const SECTION = 'OWASP Agentic 2026 › Lethal Trifecta(自写合成判定)';

// ── axis-2:不可信内容摄入模式 ─────────────────────────────────────────────────
// 高信号、保守清单。漏报优于误报。
const UNTRUSTED_CONTENT_PATTERNS: RegExp[] = [
  // Claude Code / Cursor / Zed 等内置 web 工具——只要使用即说明在主动拉取
  // 外部内容并会将其带入 agent 上下文。
  /\bWebFetch\b/,
  /\bWebSearch\b/,

  // 自然语言路径:动作动词 + 桥接词 + 攻击者可控容器。
  // 动词表:read / process / summarize / follow / execute / apply / implement /
  //        parse / handle。
  // 桥接词:this / the following / these / the attached / the provided /
  //        the user-provided / the given。
  // 容器表(刻意收紧,排除「file/input/content」通用词):
  //   URL / link / page / issue / ticket / PR / comment / message / email /
  //   inbox / attachment / webpage / body / instructions(须在桥接词之后)。
  //   「instructions」单用时过于通用,故用桥接词锚定:
  //   「follow these instructions」语义上是攻击者模式,
  //   而「follow the user's instructions」属良性对话。
  // 间距上界固定(80 / 40 字符),RE2 线性安全。
  /\b(?:read|process|summarize|follow|execute|apply|implement|parse|handle)\b[^\n]{0,80}\b(?:this|the following|these|the attached|the provided|the user-provided|the given)\b[^\n]{0,40}\b(?:url|link|page|webpage|issue|ticket|PR|comment|message|email|inbox|attachment|body|instructions?)\b/i,

  // 程序化路径:把 fetch 输出直接管道送入解释器执行。
  // 「curl page | python」「wget page | node」之类——意图即「拉下来当代码跑」。
  // clickfix/curl-pipe-shell 拦截的是 shell 解释器(curl | bash / sh),本规则
  // 拦截其它解释器;两条规则在「摄入不可信内容」语义上互不重叠。
  // python 允许带版本号后缀(python3 / python3.11)。
  /\b(?:curl|wget)\b[^\n]*\|\s*(?:python[0-9.]*|node|perl|ruby)\b/i,

  // eval / bash -c 把外部命令输出注入到当前解释器上下文。
  // 「eval $(curl …)」「bash -c "$(curl …)"」——直接执行外部内容。
  /\beval\b[^\n]*\$\(\s*(?:curl|wget|cat)\b/i,
  /\b(?:bash|sh)\b[^\n]*-c\b[^\n]*"\$\(\s*(?:curl|wget)\b/i,

  // xargs 把外部输入回灌解释器——「外部 stdin/argv 当指令」。
  // 排除 xargs 单独使用(配合 cat/grep 等只读工具时属正常用法)。
  // python 允许带版本号后缀(python3 / python3.11);其它解释器无版本后缀。
  /\bxargs\b[^\n]*\|\s*(?:bash|sh|python[0-9.]*|node|perl|ruby)\b/i,
];

/**
 * 一行是否构成「摄入不可信内容并据此行动」(axis-2 of Lethal Trifecta)。
 *
 * 与 axis-1/axis-3 不同,**不强制命令上下文门控**——摄入常是自然语言指令,
 * 与代码/命令上下文无关。匹配严格按 UNTRUSTED_CONTENT_PATTERNS 真值表。
 *
 * 导出供单元测试直接验证(避免 rule.evaluate 路径间接覆盖)。
 */
export function untrustedContentLine(line: string): boolean {
  for (const pat of UNTRUSTED_CONTENT_PATTERNS) {
    if (pat.test(line)) return true;
  }
  return false;
}

/**
 * 三轴合成判定:同一文件同时具备 axis-1(读私有数据)、axis-2(摄入不可信内容)、
 * axis-3(对外发送)即命中。返回第 axis-2 命中行作 excerpt——
 * 摄入是攻击链的入口,定位到该行更便于用户复核。
 *
 * 单文件多条 axis 命中时只产出一条 finding(沿用既有 AuditFileRule 约定);
 * 引擎按文件聚合,本规则与 `exfiltration/taint-source-to-sink` 各自独立计入。
 */
function evaluateLethalTrifecta(target: AuditFileTarget): { line: number; excerpt: string } | null {
  const lines = target.content.split('\n');
  let hasPrivate = false;
  let hasUntrusted = false;
  let hasExternal = false;
  let untrustedLine = 0;
  let untrustedText = '';

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (!hasPrivate && privateDataAccessLine(line)) hasPrivate = true;
    if (!hasExternal && externalCommLine(line)) hasExternal = true;
    if (!hasUntrusted && untrustedContentLine(line)) {
      hasUntrusted = true;
      untrustedLine = i + 1;
      untrustedText = line;
    }
    // 三轴俱全即可提前退出——untrustedLine 受 !hasUntrusted 守卫已锁定为最早
    // 命中行,break 不改变上报行,仅省去大文件的无谓扫描。
    if (hasPrivate && hasUntrusted && hasExternal) break;
  }

  if (!(hasPrivate && hasUntrusted && hasExternal)) return null;
  return { line: untrustedLine, excerpt: untrustedText.slice(0, 200) };
}

export const lethalTrifectaRules: AuditFileRule[] = [
  {
    id: 'agentic/lethal-trifecta',
    severity: 'medium',
    message:
      '此 skill 同时能①读私有数据 ②摄入不可信内容 ③对外发送——满足『致命三要素』,' +
      '一段被投毒的内容就可能诱导它把你的数据带出去。缓解:移除其中任一能力(架构边界隔离)。',
    source: SECTION,
    evaluate: evaluateLethalTrifecta,
  },
];
