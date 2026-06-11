// 分阶段投毒规则。规格来源:ags SECURITY.md `### Staged Malware Delivery`(已逐字核实)。
// 检测:看似正常的第一阶段去拉取恶意第二阶段。
import type { AuditRule } from '../src/core/audit/types.ts';

const SECTION = 'ags SECURITY.md › Staged Malware Delivery';

export const stagedRules: AuditRule[] = [
  {
    id: 'staged/chained-download-exec',
    severity: 'high',
    // 下载脚本后 chmod +x 再执行(下载→赋权→运行 链)
    pattern: /\bchmod\s+\+x\b[^\n]*&&[^\n]*\.\/|\bcurl\b[^\n]*-o\s+\S+[^\n]*&&[^\n]*(?:sh|bash|\.\/)\s*\S/i,
    message: '下载脚本→赋可执行→运行的分阶段执行链',
    source: SECTION,
  },
  {
    id: 'staged/prerequisite-install',
    severity: 'medium',
    // "先安装这个" 前置步骤指向可疑下载(ClawHavoc 模式)
    pattern:
      /(?:prerequisite|install\s+this\s+first|first\s+run|before\s+you\s+(?:start|begin))[^\n]*(?:pip\s+install|npm\s+i(?:nstall)?|curl|wget|brew\s+install)/i,
    message: '"先安装这个"前置步骤指向额外下载(分阶段投毒的典型外壳)',
    source: SECTION,
  },
];
