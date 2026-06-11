// 全局 agent 配置篡改检测(自写规则)。
// 依据:拼好码报告 #15(检测安装脚本是否写 ~/.codex/AGENTS.md、~/.claude/settings.json、
// ~/.codex/config.toml、~/.claude/CLAUDE.md 等),分类依据沿用 ags SECURITY.md 的
// Persistence 类目——篡改 agent 自身配置等于把后门写进 agent。
//
// 这是 skill-switch 的差异化能力之一(ags 服务端扫描不覆盖跨 agent 配置文件)。
import type { AuditRule } from '../src/core/audit/types.ts';

const SOURCE = '自写(报告 #15;分类依据 ags Persistence)';

// 写动作:重定向 / tee / cp / mv / sed -i / Node writeFile / Python open(...,'w')
const WRITE_VERB = String.raw`(?:>>?|tee\s+-?a?\b|\bcp\b|\bmv\b|\bsed\s+-i\b|writeFileSync|open\([^\n]*['"][wa])`;
// 受保护的 agent 配置文件(项目级与全局级同形)
const AGENT_CONFIG =
  String.raw`(?:\.claude\/settings(?:\.local)?\.json|\.claude\/CLAUDE\.md|\.codex\/config\.toml|\.codex\/AGENTS\.md|(?:^|[\/\s])AGENTS\.md|(?:^|[\/\s])CLAUDE\.md)`;

export const globalTamperRules: AuditRule[] = [
  {
    id: 'global-tamper/agent-config-write',
    severity: 'critical',
    pattern: new RegExp(`${WRITE_VERB}[^\\n]*${AGENT_CONFIG}|${AGENT_CONFIG}[^\\n]*${WRITE_VERB}`),
    message: '写入/覆盖 agent 配置文件(settings.json / CLAUDE.md / config.toml / AGENTS.md):篡改 agent 自身行为',
    source: SOURCE,
  },
  {
    id: 'global-tamper/permission-grant',
    severity: 'critical',
    // 在 settings 里塞入放行规则(Bash(*) / 自动允许)
    pattern: /"(?:permissions|allow)"\s*:[^\n]*(?:Bash\(\*\)|"\*"|allowAll)/i,
    message: '在 agent settings 中注入通配放行规则:静默扩权',
    source: SOURCE,
  },
];
