// Taint / 数据流多步攻击链检测(单文件内)。
//
// 威胁模型:
//   单看一个「读敏感源」(source)或一个「外发」(sink)动作,可能都不足以判定为恶意——
//   `echo $TOKEN` 也许只是调试,`curl https://api.example.com` 也许只是正常 API 调用。
//   但当二者在**同一个文件内近距离共现**(行距 ≤ N 或处于同一条 shell 管道/命令链)时,
//   就构成「读取敏感数据 → 立刻外发」的数据外渗链,这是典型的凭据窃取 / C2 回传形态。
//
// 与现有规则的分工:
//   - exfiltration.ts 的 sensitive-file-exfil 只看**同一行**「敏感路径 + 外发动词」共现。
//   - base64-payload.ts 只看「base64 -d | sh」解码后内容。
//   - 本规则补的缺口是**跨行**关联:source 在第 3 行读取、sink 在第 7 行外发,
//     单行规则都看不到,但人眼一看就是一条外渗链。
//
// ── 检测要点 ──────────────────────────────────────────────────────────────────
//   source(读敏感):
//     - env 变量读取:process.env / $ENV_VAR / printenv / env(裸命令)
//     - 凭据文件:~/.ssh、id_rsa/id_ed25519/id_ecdsa/id_dsa、~/.aws/credentials、
//       ~/.config、.env、keychain、*token* 文件、.netrc、.git-credentials
//     - history:.bash_history / .zsh_history
//     - 浏览器 / 钱包数据:Chrome/Brave Login Data、Exodus/Electrum/Phantom 等钱包目录
//   sink(外发):
//     - curl/wget 携带 POST/--data/-d/--form/-T 上传
//     - nc / netcat / /dev/tcp/(反向通道)
//     - webhook / 已知外渗端点 / http(s) 上传
//     - base64 后管道外发(base64 … | curl/nc/…)
//     - scp / sftp / ftp / rsync 远程推送
//
// ── 关联规则 ──────────────────────────────────────────────────────────────────
//   按行扫描,分别记录 source 命中行与 sink 命中行。对每个 sink:
//     - 若存在某 source 与该 sink 行距 ≤ LINE_WINDOW(8 行),或二者出现在同一行
//       (同一 shell 命令链/管道),则该 sink 产出**一条** finding。
//   line 指向 sink 行,excerpt 取 sink 行,severity = high。
//   每个 sink 最多产出一条(避免一个 sink 配多个 source 时重复报)。
//
// ── 重精确、低误报(宁漏不滥) ─────────────────────────────────────────────────
//   关键防误报手段:source / sink 只在**带有命令上下文**的行上才计数。
//   纯散文(例如文档里写「本工具会读取环境变量并上传报告」)不含 shell 命令特征
//   (管道符、命令前缀、重定向、明确的命令 token),因此不计入,不会触发。
//   无状态;受引擎 MAX_AUDIT_MATCH_LINE_LENGTH(2048)逐行截断保护;
//   全部用线性、定界量词的简单正则,无嵌套回溯,避免 ReDoS。
//
// 来源:自写 + ags SECURITY.md › Data Exfiltration(source/sink 用词对齐 exfiltration.ts)。
import type { AuditFileRule, AuditFileTarget } from '../src/core/audit/types.ts';

const SECTION = '自写 › 单文件内 source→sink 数据外渗链(taint)';

// source 与 sink 之间允许的最大行距(含)。超过即视为不相关。
const LINE_WINDOW = 8;

// ── 命令上下文判定 ────────────────────────────────────────────────────────────
// 一行必须看起来像「命令」而非散文,source/sink 才计数。命令特征(任一):
//   - 管道 / 逻辑连接 / 命令分隔:|  ||  &&  ;
//   - 重定向:>  >>  <  以及 /dev/tcp 等
//   - 以已知命令 token 开头(允许前导空白 / $ 提示符 / 行内 `code`)
//   - 命令替换 / 子 shell:$( … )  反引号  < ( … )
// 这些特征在描述性散文里极少自然出现,因此能把「文档提到环境变量+上传」过滤掉。
const SHELL_COMMAND_TOKENS =
  String.raw`(?:curl|wget|nc|ncat|netcat|cat|echo|printenv|env|export|scp|sftp|ftp|rsync|ssh|base64|tar|gzip|zip|openssl|http|https|fetch|xxd|head|tail|tee|dd|node|python[0-9.]*|perl|ruby|bash|sh|eval|source)`;

// 行内是否带有 shell/命令上下文特征。
// 注意:各分支均为线性匹配,无嵌套量词,RE2 安全。
const COMMAND_CONTEXT = new RegExp(
  [
    // 管道 / 逻辑连接 / 分号串联
    String.raw`[|;&]`,
    // 重定向操作符
    String.raw`(?:^|\s)(?:>>?|<)\s`,
    // /dev/tcp /dev/udp 网络重定向
    String.raw`/dev/(?:tcp|udp)/`,
    // 命令替换 / 进程替换
    String.raw`\$\(`,
    String.raw`<\(`,
    // 行首(允许缩进 / $ 或 # 提示符 / markdown 列表符 / 行内 code 反引号 \x60)出现已知命令 token
    String.raw`(?:^|[\s$#>\x60])` + SHELL_COMMAND_TOKENS + String.raw`\b`,
    // env 读取本身即足够「代码/脚本上下文」:shell 变量引用 $UPPERCASE、process.env、printenv。
    // 这些在散文里极少出现(散文写 "the FOO variable" 不带 $),却常出现在 `KEY=$SECRET` 这类
    // 既无管道也无命令前缀的赋值行,需要据此把它们算作 source 行。
    String.raw`\$\{?[A-Z][A-Z0-9_]{1,}\}?`,
    String.raw`\bprocess\.env\b`,
    String.raw`\bprintenv\b`,
  ].join('|'),
);

// ── source 模式(读敏感) ─────────────────────────────────────────────────────
// 每条都是定界、线性的简单正则。
const SOURCE_PATTERNS: RegExp[] = [
  // env 变量:process.env / $ENV(全大写,长度≥2,避免 $1 $* 等)/ printenv / 裸 env 命令
  /\bprocess\.env\b/,
  /\$\{?[A-Z][A-Z0-9_]{1,}\}?/, // $TOKEN / ${SECRET_KEY}
  /\bprintenv\b/i,
  /(?:^|[\s$#>|;&])env\b(?![a-zA-Z._-])/i, // 裸 `env`(不含 env.NODE 这类属性访问)
  // 凭据 / 密钥文件与目录
  /~?\/?\.ssh\//i,
  /\bid_(?:rsa|ed25519|ecdsa|dsa)\b/i,
  /~?\/?\.aws\/(?:credentials|config)\b/i,
  /~?\/?\.config\//i,
  // .env 文件:'.env' 前必须是路径分隔/引号/空白/行首,避免误吃 `config.env`、`process.env` 等标识符片段。
  /(?:^|[\s/'"`])\.env(?:\.[\w.-]+)?\b/i,
  /\bkeychain\b/i,
  /Library\/Keychains\//,
  /~?\/?\.netrc\b/i,
  /\.git-credentials\b/i,
  /\btokens?\b[^\n]{0,40}\.(?:txt|json|dat|key|pem)\b/i, // *token*.<ext> 文件
  // history 文件
  /~?\/?\.(?:bash|zsh|sh)_history\b/i,
  // 浏览器 / 钱包数据
  /Application Support\/Google\/Chrome\//,
  /Application Support\/BraveSoftware\//,
  /\bLogin Data\b/i,
  /Application Support\/(?:Exodus|Atomic|Electrum|Binance|Phantom)\//,
  /~?\/?\.electrum\//i,
  /\bwallet\.dat\b/i,
];

// ── sink 模式(外发) ────────────────────────────────────────────────────────
const SINK_PATTERNS: RegExp[] = [
  // curl/wget 携带请求体 / 上传标志。
  // 短旗标(-d/-F/-T)前必须是空白或行首:`\b-d` 无效,因为 '-' 是非单词字符,
  // 空白与 '-' 之间不存在单词边界;改用 (?:^|\s) 锚定。
  /\b(?:curl|wget)\b[^\n]*(?:(?:^|\s)-d\b|--data(?:-binary|-raw|-urlencode)?\b|(?:^|\s)-F\b|--form\b|(?:^|\s)-T\b|--upload-file\b|-X\s*POST\b|--request\s*POST\b)/i,
  // nc / netcat / ncat 外发(带端口参数)
  /\b(?:nc|ncat|netcat)\b[^\n]*\b\d{1,5}\b/i,
  // /dev/tcp /dev/udp 反向通道
  /(?:>|<)?\s*\/dev\/(?:tcp|udp)\//i,
  // 已知外渗端点(任一上传客户端)
  /\b(?:curl|wget|fetch|requests\.post|axios\.post|http\.post)\b[^\n]*\b(?:webhook\.site|requestbin\.com|pipedream\.net|ngrok\.io|burpcollaborator\.net|interact\.sh)\b/i,
  // base64 后管道外发:base64 … | (curl|wget|nc|ncat|netcat|scp|ftp)
  /\bbase64\b[^\n]*\|\s*(?:curl|wget|nc|ncat|netcat|scp|ftp|sftp)\b/i,
  // scp / sftp 远程推送(含 host:path 形态)
  /\bscp\b[^\n]*\s\S+@\S+:/i,
  /\bsftp\b[^\n]*\s\S+@\S+/i,
  // ftp / rsync 远程上传
  /\bftp\b[^\n]*\b(?:put|mput)\b/i,
  /\brsync\b[^\n]*\s\S+@\S+:/i,
  // 通用 http(s) POST 上传(脚本语言客户端)
  /\b(?:requests\.post|axios\.post|http\.post|fetch)\b[^\n]*https?:\/\//i,
];

function matchAny(patterns: RegExp[], line: string): boolean {
  for (const pat of patterns) {
    if (pat.test(line)) return true;
  }
  return false;
}

function hasCommandContext(line: string): boolean {
  return COMMAND_CONTEXT.test(line);
}

interface LineClass {
  /** 该行是否(在命令上下文里)命中 source */
  source: boolean;
  /** 该行是否(在命令上下文里)命中 sink */
  sink: boolean;
}

function classifyLines(lines: string[]): LineClass[] {
  return lines.map((line) => {
    const ctx = hasCommandContext(line);
    if (!ctx) return { source: false, sink: false };
    return {
      source: matchAny(SOURCE_PATTERNS, line),
      sink: matchAny(SINK_PATTERNS, line),
    };
  });
}

/**
 * 找出所有「source→sink」链对应的 sink 行(1-based)。
 * 关联条件:某 sink 行的前后 LINE_WINDOW 行范围内存在 source 行,或该 sink 行本身也是 source 行
 * (同一条 shell 命令链 / 管道内既读又发)。每个 sink 行至多产出一次。
 *
 * 导出供测试核验「一个文件多条链 → 各链 sink 行各自命中、不串扰」。
 * AuditFileRule.evaluate 单条返回的约定下,本函数是判定逻辑的真相来源。
 */
export function findChainSinkLines(lines: string[]): number[] {
  const classes = classifyLines(lines);
  const result: number[] = [];

  for (let i = 0; i < classes.length; i++) {
    const cls = classes[i]!;
    if (!cls.sink) continue;

    // 同一行内既是 source 又是 sink → 同一命令链,直接成链。
    if (cls.source) {
      result.push(i + 1);
      continue;
    }

    // 否则在 ±LINE_WINDOW 窗口内寻找 source 行。
    const lo = Math.max(0, i - LINE_WINDOW);
    const hi = Math.min(classes.length - 1, i + LINE_WINDOW);
    let linked = false;
    for (let j = lo; j <= hi; j++) {
      if (j === i) continue;
      if (classes[j]!.source) {
        linked = true;
        break;
      }
    }
    if (linked) result.push(i + 1);
  }

  return result;
}

function evaluateTaintChain(target: AuditFileTarget): { line: number; excerpt: string } | null {
  const lines = target.content.split('\n');
  const sinkLines = findChainSinkLines(lines);
  if (sinkLines.length === 0) return null;
  // AuditFileRule.evaluate 约定返回单条命中;取第一条链的 sink 行。
  // 引擎按文件聚合;一个文件内若有多条链,首条已足以将该文件标记为高危。
  const first = sinkLines[0]!;
  return { line: first, excerpt: lines[first - 1]!.slice(0, 200) };
}

export const taintRules: AuditFileRule[] = [
  {
    id: 'exfiltration/taint-source-to-sink',
    severity: 'high',
    message: '同一文件内读取敏感源(环境变量/凭据文件/历史/浏览器或钱包数据)后近距离外发——疑似数据外渗链',
    source: SECTION,
    evaluate: evaluateTaintChain,
  },
];
