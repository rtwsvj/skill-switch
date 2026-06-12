// 凭据窃取规则。规格来源:ags SECURITY.md `### Credential Theft`。
// 检测:钓鱼式索要凭据、读取本机凭据库、把认证 token 发往外部收集端点。
import type { AuditRule } from '../src/core/audit/types.ts';

const SECTION = 'ags SECURITY.md › Credential Theft';
const EXTERNAL_ENDPOINT =
  String.raw`(?:webhook\.site|requestbin\.com|pipedream\.net|ngrok\.io|burpcollaborator\.net|interact\.sh)`;
const AUTH_TOKEN = String.raw`(?:GITHUB_TOKEN|GH_TOKEN|NPM_TOKEN|API_TOKEN|AUTH_TOKEN|auth[_-]?token)`;

export const credentialTheftRules: AuditRule[] = [
  {
    id: 'credential-theft/phishing-request',
    severity: 'high',
    pattern:
      /\b(?:enter|provide|send|share|paste)\s+(?:your\s+)?(?:password|api\s*key|secret|token|credentials?)\b/i,
    message: '钓鱼式索要用户密码/API key/secret/token 等凭据',
    source: SECTION,
  },
  {
    id: 'credential-theft/credential-store-read',
    severity: 'high',
    pattern:
      /\bsecurity\s+(?:dump-keychain|find-generic-password)\b|(?:~\/\.config\/gh\/hosts\.yml|~\/\.docker\/config\.json|~\/\.npmrc|~\/\.netrc)\b/i,
    message: '读取本机钥匙串、CLI token 文件或凭据库',
    source: SECTION,
  },
  {
    id: 'credential-theft/token-exfil',
    severity: 'high',
    pattern: new RegExp(
      `(?:${AUTH_TOKEN}[^\\n]*${EXTERNAL_ENDPOINT}|${EXTERNAL_ENDPOINT}[^\\n]*${AUTH_TOKEN})`,
      'i',
    ),
    message: '把认证 token 或 API token 发送到外部收集端点',
    source: SECTION,
  },
];
