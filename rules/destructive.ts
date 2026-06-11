// 破坏命令规则。规格来源:ags SECURITY.md `### Destructive Commands`(已逐字核实)。
// 检测:删除或破坏系统的命令。
import type { AuditRule } from '../src/core/audit/types.ts';

const SECTION = 'ags SECURITY.md › Destructive Commands';

export const destructiveRules: AuditRule[] = [
  {
    id: 'destructive/rm-rf-root',
    severity: 'critical',
    // rm -rf 作用于 / 、~ 、* 等高破坏目标(允许 -rf/-fr/-r -f 顺序与额外标志)
    pattern: /\brm\s+-[a-z]*r[a-z]*f[a-z]*\s+(?:--no-preserve-root\s+)?(?:\/(?:\s|$)|~|\*)/i,
    message: 'rm -rf 作用于根/家目录/通配:破坏性删除',
    source: SECTION,
  },
  {
    id: 'destructive/disk-overwrite',
    severity: 'critical',
    // dd 覆写磁盘 或 mkfs 格式化文件系统
    pattern: /\bdd\b[^\n]*\bif=\/dev\/(?:zero|urandom|random)\b|\bmkfs\.[a-z0-9]+/i,
    message: 'dd 覆写磁盘 / mkfs 格式化文件系统',
    source: SECTION,
  },
  {
    id: 'destructive/fork-bomb',
    severity: 'critical',
    // 经典 fork bomb :(){ :|:& };:
    pattern: /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/,
    message: 'fork bomb:耗尽进程资源',
    source: SECTION,
  },
  {
    id: 'destructive/chmod-777-root',
    severity: 'high',
    pattern: /\bchmod\s+(?:-R\s+)?0?777\s+\/(?:\s|$)/,
    message: 'chmod 777 / :破坏全系统权限',
    source: SECTION,
  },
];
