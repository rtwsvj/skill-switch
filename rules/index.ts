// audit 规则总注册表。S2.2–S2.4 按类目逐片填充:
//   S2.2 数据外渗 + 反向 shell;S2.3 破坏命令 + ClickFix + 分阶段投毒;
//   S2.4 持久化 + 全局文件篡改(自写)。
// 每条规则的 source 字段必须注明 ags SECURITY.md 章节或自写依据。
import type { AuditRule } from '../src/core/audit/types.ts';
import { clickfixRules } from './clickfix.ts';
import { destructiveRules } from './destructive.ts';
import { exfiltrationRules } from './exfiltration.ts';
import { globalTamperRules } from './global-tamper.ts';
import { persistenceRules } from './persistence.ts';
import { reverseShellRules } from './reverse-shell.ts';
import { stagedRules } from './staged.ts';

export const allRules: AuditRule[] = [
  ...exfiltrationRules,
  ...reverseShellRules,
  ...destructiveRules,
  ...clickfixRules,
  ...stagedRules,
  ...persistenceRules,
  ...globalTamperRules,
];
