// 数据外渗规则。规格来源:ags SECURITY.md `### Data Exfiltration`(已逐字核实)。
// 检测:把敏感数据/凭据发往外部服务器的指令。
//
// 精度取舍(MVP,记录于 docs/changes/2026-06-12-S2.2.md):
// - curl-with-secret 只看请求体标志(-d/--data/-F/--form),不看 -H:
//   `-H "Authorization: Bearer $TOKEN"` 是合法鉴权头,把它算外渗会误报正常 API 调用;
//   恶意特征是把密钥当作 data 发出去。
// - sensitive-file 聚焦私钥/凭据库等几乎不该被 skill 读取的目标,不匹配裸 `~/.ssh/`
//   或裸 `.env`(skill 提到 `~/.ssh/config`、gitignored `.env` 属正常)。
import type { AuditRule } from '../src/core/audit/types.ts';

const SECTION = 'ags SECURITY.md › Data Exfiltration';
const SENSITIVE_PATH =
  String.raw`(?:\bid_(?:rsa|ed25519|ecdsa|dsa)\b|\.pem\b|~\/\.aws\/|~\/\.gnupg\/|Library\/Keychains\/|Application Support\/(?:Exodus|Atomic|Electrum|Binance|Phantom)\/|Application Support\/Google\/Chrome\/|Application Support\/BraveSoftware\/)`;
const EXFIL_VERB =
  String.raw`(?:\b(?:curl|wget|nc|netcat|scp|rsync|fetch|requests\.post|axios\.post|http\.post)\b|\/dev\/tcp|\bbase64\b[^\n]*\|)`;
const SAME_LINE_GAP = String.raw`[^\n]{0,2048}`;

export const exfiltrationRules: AuditRule[] = [
  {
    id: 'exfiltration/curl-body-with-secret',
    severity: 'critical',
    pattern:
      /\b(?:curl|wget)\b[^\n]*(?:-d\b|--data|--data-binary|-F\b|--form)[^\n]*\$[A-Za-z_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CRED)/i,
    message: '用 curl/wget 把含密钥/令牌的变量作为请求体发送到外部(数据外渗)',
    source: SECTION,
  },
  {
    id: 'exfiltration/sensitive-file-exfil',
    severity: 'critical',
    pattern: new RegExp(
      `(?:${SENSITIVE_PATH}${SAME_LINE_GAP}${EXFIL_VERB}|${EXFIL_VERB}${SAME_LINE_GAP}${SENSITIVE_PATH})`,
      'i',
    ),
    message: '同一行读取私钥/凭据库/钱包/浏览器登录数据等敏感路径并外传',
    source: SECTION,
  },
  {
    id: 'exfiltration/sensitive-path-reference',
    severity: 'low',
    pattern: new RegExp(SENSITIVE_PATH, 'i'),
    message: '提到私钥/凭据库/钱包/浏览器登录数据等敏感路径;确认没有外传',
    source: SECTION,
  },
  {
    id: 'exfiltration/exfil-endpoint',
    severity: 'high',
    pattern:
      /\b(?:curl|wget|fetch|requests\.post|axios\.post|http\.post)\b[^\n]*\b(?:webhook\.site|requestbin\.com|pipedream\.net|ngrok\.io|burpcollaborator\.net|interact\.sh)\b/i,
    message: '向已知数据外渗端点(webhook.site / requestbin 等)发送数据',
    source: SECTION,
  },
];
