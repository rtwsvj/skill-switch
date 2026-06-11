// ClickFix / 社工安装规则。规格来源:ags SECURITY.md `### ClickFix / Social Engineering Installers`。
// 检测:诱导用户绕过安全机制、把不可信代码粘进终端执行的手法。
import type { AuditRule } from '../src/core/audit/types.ts';

const SECTION = 'ags SECURITY.md › ClickFix / Social Engineering Installers';

export const clickfixRules: AuditRule[] = [
  {
    id: 'clickfix/gatekeeper-bypass',
    severity: 'critical',
    // 移除 macOS 隔离属性 / 关闭 Gatekeeper
    pattern: /\bxattr\b[^\n]*-d[^\n]*com\.apple\.quarantine|\bspctl\b[^\n]*--master-disable/i,
    message: '移除 macOS 隔离属性或关闭 Gatekeeper(绕过系统安全)',
    source: SECTION,
  },
  {
    id: 'clickfix/curl-pipe-shell',
    severity: 'critical',
    // 一行式 curl|bash 安装器(下载即执行)
    pattern: /\b(?:curl|wget)\b[^\n|]*\|\s*(?:sudo\s+)?(?:ba|z|d)?sh\b/i,
    message: 'curl|bash 一行式安装:下载即执行远程脚本',
    source: SECTION,
  },
  {
    id: 'clickfix/copy-paste-lure',
    severity: 'medium',
    // "复制粘贴这条命令到终端" 社工诱导
    pattern:
      /(?:copy\s+(?:and\s+)?paste|paste\s+this|run\s+this\s+command)[^\n]*(?:terminal|shell|command\s+line)|把(?:这|以下)[^\n]*粘贴[^\n]*(?:终端|命令行)/i,
    message: '诱导"复制粘贴到终端"运行不可信命令(ClickFix 社工)',
    source: SECTION,
  },
];
