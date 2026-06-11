// 反向 shell 规则。规格来源:ags SECURITY.md `### Reverse Shells`(已逐字核实)。
// 检测:为攻击者打开 shell 访问的命令。
import type { AuditRule } from '../src/core/audit/types.ts';

const SECTION = 'ags SECURITY.md › Reverse Shells';

export const reverseShellRules: AuditRule[] = [
  {
    id: 'reverse-shell/dev-tcp',
    severity: 'critical',
    // bash 的 /dev/tcp 重定向(交互式反弹 shell 的典型形态)
    pattern: /\/dev\/tcp\//,
    message: 'bash /dev/tcp 重定向:典型反向 shell',
    source: SECTION,
  },
  {
    id: 'reverse-shell/netcat-exec',
    severity: 'critical',
    // nc -e /bin/bash 及其常见变体(-c、ncat)
    pattern: /\bn(?:c|cat)\b[^\n]*-(?:e|c)\s+\/?(?:bin\/)?(?:ba)?sh\b/i,
    message: 'netcat 带 -e/-c 执行 shell:反向 shell',
    source: SECTION,
  },
  {
    id: 'reverse-shell/scripting-socket',
    severity: 'critical',
    // python/perl/ruby 一行 socket 反弹 shell
    pattern:
      /\b(?:python[0-9.]*|perl|ruby)\b[^\n]*(?:import\s+socket|socket\.socket|rsocket|IO::Socket|\/dev\/tcp)/i,
    message: 'python/perl/ruby 内联 socket 反向 shell',
    source: SECTION,
  },
];
