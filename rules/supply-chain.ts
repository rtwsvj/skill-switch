// 供应链规则。规格来源:ags SECURITY.md `### Supply Chain`。
// 检测:仿名/错拼包名与从不可信远端直接安装依赖。
import type { AuditRule } from '../src/core/audit/types.ts';

const SECTION = 'ags SECURITY.md › Supply Chain';

export const supplyChainRules: AuditRule[] = [
  {
    id: 'supply-chain/typosquat-package',
    severity: 'medium',
    pattern:
      /\b(?:pip(?:3)?\s+install|uv\s+pip\s+install)\s+(?:python-requests|reqeusts|djanga|setup-tools)\b|\b(?:npm|pnpm|yarn)\s+(?:add|install|i)\s+(?:cross-envs|lodahs|react-domm)\b/i,
    message: '安装疑似仿名/错拼的依赖包(供应链投毒风险)',
    source: SECTION,
  },
  {
    id: 'supply-chain/untrusted-install-source',
    severity: 'medium',
    pattern:
      /\b(?:pip(?:3)?\s+install|uv\s+pip\s+install|npm\s+(?:install|i)|pnpm\s+add|yarn\s+add)\b[^\n]*(?:--(?:extra-)?index-url\s+http:\/\/|http:\/\/|https:\/\/(?:raw\.githubusercontent\.com|gist\.githubusercontent\.com|pastebin\.com|bit\.ly|tinyurl\.com|example\.com))/i,
    message: '从不可信 URL、短链、gist/raw 或明文 HTTP 源安装依赖',
    source: SECTION,
  },
];
