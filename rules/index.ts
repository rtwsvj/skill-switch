// audit 规则总注册表。S2.2–S2.4、F6 按类目逐片填充:
//   S2.2 数据外渗 + 反向 shell;S2.3 破坏命令 + ClickFix + 分阶段投毒;
//   S2.4 持久化 + 全局文件篡改(自写);F6 Credential Theft + Supply Chain。
// 每条规则的 source 字段必须注明 ags SECURITY.md 章节或自写依据。
import type { AuditFileRule, AuditRule } from '../src/core/audit/types.ts';
import { ansiInjectionRules } from './ansi-injection.ts';
import { base64PayloadRules } from './base64-payload.ts';
import { binaryMasqueradeRules } from './binary-masquerade.ts';
import { clickfixRules } from './clickfix.ts';
import { credentialTheftRules } from './credential-theft.ts';
import { destructiveRules } from './destructive.ts';
import { exfiltrationRules } from './exfiltration.ts';
import { globalTamperRules } from './global-tamper.ts';
import { invisibleCharRules } from './invisible-chars.ts';
import { persistenceRules } from './persistence.ts';
import { promptInjectionRules } from './prompt-injection.ts';
import { reverseShellRules } from './reverse-shell.ts';
import { stagedRules } from './staged.ts';
import { stagedExfilRules } from './staged-exfil.ts';
import { supplyChainRules } from './supply-chain.ts';
import { taintRules } from './taint.ts';

export const allRules: AuditRule[] = [
  ...exfiltrationRules,
  ...reverseShellRules,
  ...destructiveRules,
  ...clickfixRules,
  ...stagedRules,
  ...persistenceRules,
  ...globalTamperRules,
  ...credentialTheftRules,
  ...supplyChainRules,
  ...promptInjectionRules, // C3:对齐 Snyk hidden-instructions / prompt-injection
];

export const allFileRules: AuditFileRule[] = [
  ...stagedExfilRules,
  ...base64PayloadRules,    // A5:base64 编码 payload 解码检测
  ...invisibleCharRules,    // Trojan-Source bidi/控制字符(CVE-2021-42574)
  ...ansiInjectionRules,    // R2-b:ANSI 转义序列/终端控制序列注入
  ...binaryMasqueradeRules, // A1:二进制魔数伪装(文本扩展名却以可执行/归档魔数开头)
  ...taintRules,            // A3:taint 单文件内 source→sink 数据外渗链
];
