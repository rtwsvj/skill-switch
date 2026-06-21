// Base64 编码 payload 检测规则。
// 策略:检测 "…| base64 -d | sh" 模式,提取 base64 blob,解码后对解码结果重新跑外渗/反向 shell 规则。
// 只对"解码后管道到 shell"这一高置信形态启用解码检测,避免把普通 base64 用法误报。
//
// 精度保障:
//   1. 必须同行出现 `base64 -d`(或 `--decode`)且同行有 `| sh` 或 `| bash`。
//   2. 提取出的 blob 必须是合法 base64(仅 [A-Za-z0-9+/=]);解码失败则忽略。
//   3. 解码结果的危险判定复用现有正则规则;不增加新的模糊匹配。
//   4. blob 长度下限 20 字符:太短的 blob 不可能编码完整的恶意命令。
//
// 来源:自写 + ags SECURITY.md › Data Exfiltration、Reverse Shells。
import type { AuditFileRule, AuditFileTarget } from '../src/core/audit/types.ts';

const SECTION = '自写 › base64 编码 payload 解码检测';

// 检测 "base64 -d | sh" 或 "base64 --decode | bash"(允许中间有空格或其他标志)
const BASE64_DECODE_PIPE_SHELL = /\bbase64\b[^\n]*--?d(?:ecode)?\b[^\n]*\|\s*(?:ba)?sh\b/i;

// 从命令行中提取一个或多个 base64 blob(>=20 字符)
const B64_BLOB = /\b([A-Za-z0-9+/]{20,}={0,2})\b/g;

// 复用现有规则中的关键危险模式,仅作为解码后检测,不暴露给外部
const DANGEROUS_DECODED_PATTERNS: RegExp[] = [
  // 数据外渗:curl/wget 携带 token 作为 body
  /\b(?:curl|wget)\b[^\n]*(?:-d\b|--data|--data-binary|-F\b|--form)[^\n]*\$[A-Za-z_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CRED)/i,
  // 已知外渗端点
  /\b(?:curl|wget|fetch|requests\.post|axios\.post|http\.post)\b[^\n]*\b(?:webhook\.site|requestbin\.com|pipedream\.net|ngrok\.io|burpcollaborator\.net|interact\.sh)\b/i,
  // 反向 shell
  /\/dev\/tcp\//,
  /\bn(?:c|cat)\b[^\n]*-(?:e|c)\s+\/?(?:bin\/)?(?:ba)?sh\b/i,
  /\b(?:python[0-9.]*|perl|ruby)\b[^\n]*(?:import\s+socket|socket\.socket|rsocket|IO::Socket|\/dev\/tcp)/i,
  // 敏感路径外渗
  /(?:\bid_(?:rsa|ed25519|ecdsa|dsa)\b|\.pem\b|~\/\.aws\/|~\/\.gnupg\/).*\b(?:curl|wget|nc|netcat|scp|rsync|fetch)\b|\b(?:curl|wget|nc|netcat|scp|rsync|fetch)\b.*(?:\bid_(?:rsa|ed25519|ecdsa|dsa)\b|\.pem\b|~\/\.aws\/|~\/\.gnupg\/)/i,
  // 破坏性命令
  /\brm\s+-[^\s]*r[^\s]*f\s+\/(?!\s*$)|\bmkfs\b|\bdd\b[^\n]*of=\/dev\//i,
];

function isDecodedDangerous(decoded: string): boolean {
  for (const pat of DANGEROUS_DECODED_PATTERNS) {
    if (pat.test(decoded)) return true;
  }
  return false;
}

function tryDecode(blob: string): string | null {
  try {
    const buf = Buffer.from(blob, 'base64');
    // 解码结果必须是可读文本(UTF-8 且不含太多不可打印字符)
    const text = buf.toString('utf8');
    const printable = [...text].filter((c) => c.codePointAt(0)! >= 0x20 || c === '\n' || c === '\t').length;
    if (printable / text.length < 0.8) return null; // 非文本 blob,跳过
    return text;
  } catch {
    return null;
  }
}

function evaluateBase64Payload(target: AuditFileTarget): { line: number; excerpt: string } | null {
  const lines = target.content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!BASE64_DECODE_PIPE_SHELL.test(line)) continue;

    // 找出该行所有 base64 blob 候选
    B64_BLOB.lastIndex = 0;
    let match = B64_BLOB.exec(line);
    while (match !== null) {
      const blob = match[1]!;
      const decoded = tryDecode(blob);
      if (decoded !== null && isDecodedDangerous(decoded)) {
        return {
          line: i + 1,
          excerpt: `${line.slice(0, 120)} [decoded: ${decoded.slice(0, 80).replace(/\n/g, '↵')}]`,
        };
      }
      match = B64_BLOB.exec(line);
    }
  }
  return null;
}

export const base64PayloadRules: AuditFileRule[] = [
  {
    id: 'obfuscation/base64-encoded-payload',
    severity: 'critical',
    message: 'base64 解码后管道到 shell 且解码内容含危险模式(数据外渗 / 反向 shell 等)',
    source: SECTION,
    evaluate: evaluateBase64Payload,
  },
];
