// 供应链规则。规格来源:ags SECURITY.md `### Supply Chain`。
// 检测:仿名/错拼包名与从不可信远端直接安装依赖。
import type { AuditRule } from '../src/core/audit/types.ts';

const SECTION = 'ags SECURITY.md › Supply Chain';

// R12-a: 非官方 registry 检测的可疑 URL 模式。
// 仅对高信号恶意特征告警,避免对企业内网 registry(如 https://npm.mycompany.com)误报:
//   - http:// 明文 HTTP(企业 registry 几乎总用 https)
//   - 原始 IP 地址(非域名)
//   - 保留/测试 TLD:invalid / test / local / example / localhost
//   - 已知短链/粘贴域名(bit.ly / tinyurl / pastebin / gist)
// 合法企业 registry 有正式域名 + https,不会命中上述任一条件。
const UNOFFICIAL_REGISTRY_PATTERN = new RegExp(
  // 安装命令前缀(npm/pnpm/yarn/pip 及 npm config set registry)
  String.raw`\b(?:npm\s+(?:install|i|ci)|pnpm\s+(?:install|add|i)|yarn\s+(?:install|add)|pip(?:3)?\s+install|uv\s+pip\s+install|npm\s+config\s+set\s+registry)\b` +
    // 跳过同行其他参数直到 --registry / --index-url / --extra-index-url
    String.raw`[^\n]*(?:--registry|--index-url|--extra-index-url)\s+` +
    // URL 须符合以下可疑特征之一:
    // 1. 明文 HTTP
    // 2. 原始 IP 地址(IPv4)
    // 3. 保留/测试 TLD(.invalid .test .local .example .localhost)
    //    注意:TLD 后必须跟 / 或空白或行尾,避免将 nexus.corp.example.org 中的 .example 误判为 TLD
    // 4. 已知短链/粘贴域名作为 registry host
    '(?:' +
    String.raw`http:\/\/\S+` +
    String.raw`|https?:\/\/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}(?:\/\S*)?` +
    String.raw`|https?:\/\/[^\s/]*\.(?:invalid|test|local|example|localhost)(?:[\s/]|$)` +
    String.raw`|https?:\/\/(?:bit\.ly|tinyurl\.com|pastebin\.com|gist\.github\.com|raw\.githubusercontent\.com)\/\S*` +
    ')',
  'i',
);

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
  {
    // R12-a: 检测安装命令中使用可疑非官方 registry/index-url。
    // 精度策略:仅对明文 HTTP、原始 IP、保留 TLD、短链域名四类高信号特征告警(medium),
    // 合法企业内网 registry(https://npm.mycompany.com 等)不会命中任何一类。
    id: 'supply-chain/unofficial-registry',
    severity: 'medium',
    pattern: UNOFFICIAL_REGISTRY_PATTERN,
    message:
      '安装命令使用可疑 registry/index-url(明文 HTTP、原始 IP、保留 TLD 或已知短链域名);企业内网 registry 应使用 https:// 和正式域名',
    source: SECTION,
  },
];
