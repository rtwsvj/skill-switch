// rule-explain.ts — 根据规则元数据组装人类可读的解释。
// 纯只读函数:从 allRules / allFileRules 中查找规则,派生类目级描述。
// 不硬编码逐条说明——从 category + rule.message 组合,覆盖全部 80+ 条规则。

import { allFileRules, allRules } from '../../rules/index.ts';
import type { AuditFileRule, AuditRule, Severity } from './audit/types.ts';

// ── 公共类型 ──────────────────────────────────────────────────────────────────

export interface RuleExplanation {
  ruleId: string;
  severity: Severity;
  /** 规则所属类目(ruleId 的第一段) */
  category: string;
  /** 这条规则检测什么(来自 rule.message) */
  what: string;
  /** 为什么危险(类目级风险摘要) */
  why: string;
  /** 修复思路(类目级通用建议) */
  howToFix: string;
  /** 三种抑制方式说明 */
  howToSuppress: string;
}

// ── 类目 → 风险说明 ───────────────────────────────────────────────────────────

const CATEGORY_WHY: Record<string, string> = {
  'reverse-shell':
    '反弹 shell 会让攻击者在宿主机上获得远程交互式 shell 访问权,可执行任意命令、横向移动或提权。',
  exfiltration:
    '数据外传规则检测把本机密钥、凭据或敏感文件发往外部服务器的命令——一旦泄露,攻击者可冒用身份或接管账号。',
  destructive:
    '破坏性命令会不可逆地删除文件系统、格式化磁盘或耗尽进程资源,可导致服务中断或数据永久丢失。',
  clickfix:
    'ClickFix / 远程下载执行手法诱导用户或 agent 拉取并直接执行未经审查的代码,相当于绕过所有准入控制的后门安装通道。',
  staged:
    '分阶段投毒把恶意负载拆散到多步操作中(下载 → chmod → 执行),逃避单步扫描,最终同样实现任意代码执行。',
  persistence:
    '持久化机制(crontab / shell 启动文件 / 系统服务 / git hook)让攻击代码在重启或重新登录后自动复活,难以彻底清除。',
  'global-tamper':
    '篡改 agent 自身的配置文件(settings.json / CLAUDE.md)可注入隐藏指令、静默扩权或关闭安全确认,影响所有后续会话。',
  'credential-theft':
    '凭据窃取规则检测钓鱼索要密码/API key,或读取本机钥匙串/token 文件后将其发往收集端点,可导致账号被接管。',
  'supply-chain':
    '供应链攻击通过仿名包、不可信 registry 或短链安装依赖,在依赖树中植入恶意代码,影响所有使用该依赖的环境。',
  'prompt-injection':
    '提示注入尝试覆盖 AI agent 的内置指令、隐藏行为或绕过扫描,可让攻击者在不被用户察觉的情况下操控 agent 行为。',
  obfuscation:
    '混淆载荷(base64 编码命令、不可见 Unicode 字符、ANSI 终端注入)用来对人眼或简单扫描器隐藏恶意内容,是攻击链的前置步骤。',
  mcp:
    'MCP 配置安全规则检测危险的 MCP server 配置——反弹 shell 内联命令、硬编码密钥、无版本号供应链、元数据提示注入等——任何一项都可让 AI agent 成为攻击跳板。',
  settings:
    'agent 配置(settings.json)安全规则检测恶意 hook 命令、过宽权限、硬编码密钥及禁用确认等设置——被植入后会在每次 agent 事件中静默执行。',
};

const CATEGORY_HOW_TO_FIX: Record<string, string> = {
  'reverse-shell':
    '删除或注释掉含 /dev/tcp/ 重定向、nc -e、python socket 等模式的命令行。若命令确有合法用途,用 --baseline 或策略文件记录豁免理由。',
  exfiltration:
    '检查外传命令是否必要:若仅是正常 API 调用,改用 Authorization 头而非把密钥放进请求体;若涉及敏感路径,评估是否需要发往外部。确认无误可用策略文件抑制低严重度告警。',
  destructive:
    '删除 rm -rf / 、dd of=/dev/ 、mkfs 等命令。若 skill 需要清理文件,将路径改为明确的相对路径或以变量限定范围,避免通配符。',
  clickfix:
    '将 curl | bash 改为:先下载到本地文件 → 人工核查 → 再执行。引用外部脚本时固定到内容哈希或已知版本,不要直接从 main/HEAD 拉取。',
  staged:
    '把多步下载+执行链拆开,明确每一步的来源和哈希校验。若是合法的前置安装步骤,在 .skill-switch-policy.json 的 suppress[] 中注明原因。',
  persistence:
    '确认是否真的需要修改 crontab / shell 启动文件 / 系统服务。若是必要操作,在 skill 说明中明确记录意图,并在策略文件中抑制对应规则。',
  'global-tamper':
    '不要在 skill 中直接写入 settings.json / CLAUDE.md;若需配置 agent,引导用户手动操作或通过官方 CLI 命令执行,保留人工确认环节。',
  'credential-theft':
    '不要在 skill 中索要用户密码或 token;让用户通过环境变量或 secret manager 传入凭据。读取 ~/.ssh / keychain 等操作须在文档中明示。',
  'supply-chain':
    '改用官方 registry(npm/pypi)、指定精确版本号(如 package@1.2.3),并在锁文件中固定哈希。避免 npx/uvx 不带版本号的临时安装。',
  'prompt-injection':
    '移除"忽略之前的指令"、"不要告诉用户"等覆盖性短语;确保 skill 说明对用户透明。若是误报(如引用该短语做说明),用行内注释抑制: # skill-switch:suppress[ruleId]',
  obfuscation:
    '检查 base64 解码后的内容;若内容安全,在 .skill-switch-policy.json suppress[] 中记录原因。不可见 Unicode 字符应直接删除——现代文本中没有合法用途。',
  mcp:
    '检查 MCP server 配置:移除 shell 包装器中的危险命令;为 npx/uvx 指定版本;把密钥改为环境变量引用(如 $MY_KEY);对远程 server 改用 https://。',
  settings:
    '检查 hooks 中的每条命令是否只做必要操作;移除通配符权限(Bash(*) / *);把硬编码密钥改为环境变量引用($ENV_VAR);避免 dangerouslySkipPermissions: true。',
};

// 兜底(未知类目)
const DEFAULT_WHY =
  '该规则标记了可能存在安全风险的模式,请结合上下文评估是否构成实际威胁。';
const DEFAULT_HOW_TO_FIX =
  '参阅 docs/rules.md 了解该规则的检测意图,评估是否需要修改或抑制。';

// ── 抑制说明(通用,不随规则变化) ─────────────────────────────────────────────

const SUPPRESS_HELP = `
三种抑制方式(任选其一,从窄到宽):

  1. 行内注释(仅抑制该文件该行):
       在命中行末尾加:  # skill-switch:suppress[{ruleId}]

  2. 策略文件(按 ruleId 抑制整个项目的 finding,finding 仍显示但不阻断 CI):
       在 .skill-switch-policy.json 中添加:
       {
         "suppress": [
           { "ruleId": "{ruleId}", "reason": "说明原因" }
         ]
       }

  3. 基线化(把现有 finding 全部存档,只对新增 finding 失败):
       skill-switch audit <skill-dir> --write-baseline .skill-switch-baseline.json
       # 之后 CI 中使用:
       skill-switch audit <skill-dir> --baseline .skill-switch-baseline.json
`.trimStart();

// ── 核心函数 ──────────────────────────────────────────────────────────────────

/**
 * 从 allRules / allFileRules 中按 ruleId 查找并组装解释对象。
 * 未找到返回 null。
 */
export function explainRule(ruleId: string): RuleExplanation | null {
  // 合并两种规则类型
  const all: Array<AuditRule | AuditFileRule> = [...allRules, ...allFileRules];
  const rule = all.find((r) => r.id === ruleId);
  if (!rule) return null;

  const category = ruleId.split('/')[0] ?? ruleId;
  const why = CATEGORY_WHY[category] ?? DEFAULT_WHY;
  const howToFix = CATEGORY_HOW_TO_FIX[category] ?? DEFAULT_HOW_TO_FIX;
  const howToSuppress = SUPPRESS_HELP.replace(/\{ruleId\}/g, ruleId);

  return {
    ruleId: rule.id,
    severity: rule.severity,
    category,
    what: rule.message,
    why,
    howToFix,
    howToSuppress,
  };
}

// ── 模糊近似建议 ──────────────────────────────────────────────────────────────

/**
 * 未找到精确 ruleId 时,返回按前缀/类目相似度排序的候选列表(最多 5 条)。
 */
export function suggestRules(query: string): string[] {
  const all: Array<AuditRule | AuditFileRule> = [...allRules, ...allFileRules];
  const lower = query.toLowerCase();

  // 评分:前缀匹配 > 包含匹配 > 类目匹配
  const scored = all.map((r) => {
    const id = r.id.toLowerCase();
    let score = 0;
    if (id === lower) score = 100;
    else if (id.startsWith(lower)) score = 60;
    else if (id.includes(lower)) score = 40;
    else {
      const category = id.split('/')[0] ?? '';
      if (category === lower || category.startsWith(lower) || lower.startsWith(category)) {
        score = 20;
      }
      // slug 部分匹配
      const slug = id.split('/')[1] ?? '';
      if (slug.startsWith(lower) || slug.includes(lower)) {
        score = Math.max(score, 30);
      }
    }
    return { id: r.id, score };
  });

  return scored
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
    .map((x) => x.id);
}
