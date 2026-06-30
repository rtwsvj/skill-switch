// 跨-skill 协同攻击检测(任务 A4)。
//
// 目标:识别"单看每个 skill 都不致命、组合起来才构成攻击链"的多-skill 协同攻击,
// 补全 mcp-audit.ts 已有的跨-MCP-server 检测。典型场景:
//
//   攻击链 1(敏感读取 + 外发,经共享 dropzone):
//     skill A —— 能读取凭据(env / ~/.ssh / ~/.aws / .netrc 等)并把内容写到某约定路径
//                (如 /tmp/dropzone、共享临时文件)。
//     skill B —— 从同一约定路径读取,然后 curl/POST/webhook 外发出去。
//     单看 A:只是"读 + 写本地文件";单看 B:只是"读本地文件 + 发网络"。
//     组合:A 把凭据搬到 dropzone,B 把 dropzone 外发 —— 完整的凭据窃取链。
//
//   攻击链 2(凭据读取 + 外发,经共享外部域名 / webhook URL):
//     skill A 读凭据,且引用了某可疑外部域名/URL;
//     skill B 向同一域名/URL 外发数据。
//     共享的"约定 endpoint"是把两者绑成一条链的具体线索。
//
//   攻击链 3(配置蔓延):
//     一个 skill 改写全局 agent 配置(写 ~/.claude/settings.json、settings/hooks 等),
//     另一个 skill 引用/依赖被改的同一配置路径来获得提权能力。
//
// 设计原则(重精确、低误报):
//   - 纯函数、无副作用:不读盘、不联网、不 spawn;输入已是内存中的审计目标。
//   - 必须有**具体关联线索**(共享路径 / 共享域名 / 共享 dropzone)才报。
//     绝不因为"A 能读 + B 能发"就报 —— 那会产生海量误报。
//   - 能力 + 链路必须横跨**两个不同的 skill**;单个 skill 自身的完整链交给单文件规则
//     (A3 / rules/*),本函数显式跳过,避免与单文件规则重复出 finding。
//
// 严重度说明:Severity 只有 critical/high/medium/low(见 types.ts);"review" 是
//   评分档位(verdict band)而非 severity。外泄链用 high(默认会阻断);配置蔓延
//   用 medium(落 REVIEW 档,提示人工复核而不直接阻断)。
//
// 集成:编排者在跑完每个 skill 目录的 auditContents 后,把各 skill 的
//   { skillId, files } 收集成数组传入 analyzeCrossSkillCollusion(),
//   返回的 AuditFinding[] 直接并入总报告 findings(详见文件末尾"集成说明")。
import type { AuditFileTarget, AuditFinding, Severity } from './types.ts';

// ──────────────────────────────────────────────────────────────────────────────
// 公开输入 / 输出类型
// ──────────────────────────────────────────────────────────────────────────────

/**
 * 单个 skill 的跨文件分析输入。
 * `files` 即该 skill 目录下已读入内存的审计目标(与单文件审计共用同一结构)。
 */
export interface CrossSkillInput {
  /** skill 标识(展示用名称 / 目录名 / id 均可)。 */
  skillId: string;
  /** 该 skill 的全部审计文件目标(已在内存中,本函数只读不改)。 */
  files: AuditFileTarget[];
}

/**
 * analyzeCrossSkillCollusion 的可选项。
 * 默认值已为大多数场景调好;暴露出来便于测试与未来调参。
 */
export interface CrossSkillOptions {
  /**
   * 摘要(excerpt)截断长度。默认 200,与 engine.ts 一致。
   */
  excerptLimit?: number;
}

// ──────────────────────────────────────────────────────────────────────────────
// 内部:能力 / 线索探测正则
// ──────────────────────────────────────────────────────────────────────────────

const DEFAULT_EXCERPT_LIMIT = 200;

/** 防御性单行扫描上限(与 engine 的行截断同量级)。 */
const MAX_SCAN_LINE_LENGTH = 2048;

/**
 * 敏感读取能力:读取凭据 / 密钥 / 私钥目录的迹象。
 * 路径段用边界锚定(行首 / 斜杠 / 波浪号 / 引号 / 等号 / 空白前缀),
 * 避免命中无关词里的子串(参考 mcp-audit.ts 的 CREDENTIAL_PATH_RE 做法)。
 */
const SENSITIVE_READ_RE =
  /(?:^|[/~"'=\s`])(?:~?\/?\.ssh\b|id_rsa|id_ed25519|authorized_keys|~?\/?\.aws\b|\.aws\/credentials|~?\/?\.gnupg\b|\.netrc\b|~?\/?\.config\/gh\b|~?\/?\.docker\/config\.json|~?\/?\.kube\/config|~?\/?\.npmrc\b)/i;

/**
 * 读取环境变量 / 进程环境的迹象(env / printenv / process.env / os.environ / $ENV)。
 * 这是另一类"敏感读取"来源:把 env 里的密钥读出来。
 */
const ENV_READ_RE =
  /\b(?:printenv|process\.env|os\.environ|os\.getenv|System\.getenv)\b|(?:^|[\s;&|])env(?:\s|$)/i;

/**
 * 外发能力:把数据发到网络(curl/wget POST、fetch/axios POST、webhook、nc 等)。
 * 我们要求"看起来在发送数据",而不仅仅是 GET 取数据,以降低误报。
 */
const OUTBOUND_RE =
  /\bcurl\b[^\n]*\s(?:-d|--data|--data-binary|--data-raw|-F|--form|-T|--upload-file|-X\s*(?:POST|PUT))(?=\s|$)|\bwget\b[^\n]*--post-(?:data|file)\b|\bfetch\s*\([^)]*method\s*:\s*['"]?(?:POST|PUT)|\b(?:axios|requests)\.(?:post|put)\b|\b(?:nc|ncat|netcat)\b[^\n]*\d{2,5}|\bwebhook\b/i;

/**
 * 写全局 agent 配置的迹象(攻击链 3 的"配置蔓延"源)。
 * 命中:写 ~/.claude/settings.json、.claude/settings、hooks 配置、mcp 配置等。
 */
const GLOBAL_CONFIG_WRITE_RE =
  /(?:^|[/~"'=\s`])(?:~?\/?\.claude\/(?:settings|mcp|hooks)[A-Za-z0-9._/-]*|claude_desktop_config\.json|~?\/?\.cursor\/mcp\.json|~?\/?\.config\/Claude\/[A-Za-z0-9._/-]*)/i;

/**
 * 写入 / 落盘动词 —— 用于判定一个路径是被"写"还是被"读"。
 * 命中其一即视为该行在做写入(重定向 > >>、tee、cp/mv 到、写文件 API)。
 */
const WRITE_VERB_RE =
  /(?:>>?|\btee\b|\bcp\b|\bmv\b|\bdd\b|\bwriteFileSync?\b|\bwrite_text\b|\bopen\s*\([^)]*['"][wa]['"]|\becho\b[^\n]*>)/i;

/**
 * 共享落点路径(dropzone)候选:世界可写 / 临时 / 约定目录下的具体文件或子路径。
 * 我们故意只把"具体路径"当作线索 —— 裸 /tmp 不算,/tmp/<something> 才算,
 * 这样两个 skill 必须引用**同一个具体路径**才会被关联。
 */
const DROPZONE_PATH_RE =
  /(?:\/tmp\/|\/var\/tmp\/|\/dev\/shm\/|\/var\/folders\/|~\/[.\w-]*(?:share|drop|stage|outbox|exchange)[\w./-]*)[\w./-]+/gi;

/**
 * 外部 URL / 域名候选(http/https)。用于攻击链 2:两个 skill 引用同一外部 endpoint。
 */
const URL_RE = /https?:\/\/[A-Za-z0-9.-]+(?::\d+)?(?:\/[\w./%?=&#-]*)?/gi;

/**
 * 从 URL 提取可比较的主机名(去 scheme、端口、路径;小写)。
 */
function hostOf(url: string): string {
  const m = /^https?:\/\/([A-Za-z0-9.-]+)/i.exec(url);
  return m ? m[1]!.toLowerCase() : '';
}

/**
 * 公认良性 / 极常见的主机名:不作为"协同线索"。两个 skill 都连 github.com /
 * api.openai.com 这类公共服务并不构成"约定 endpoint"线索 —— 否则海量误报。
 * 注意:这只豁免"作为关联线索",不豁免单文件规则对真实外发的检测。
 */
const BENIGN_HOSTS: ReadonlySet<string> = new Set([
  'localhost',
  '127.0.0.1',
  '0.0.0.0',
  'example.com',
  'www.example.com',
  'github.com',
  'raw.githubusercontent.com',
  'api.github.com',
  'registry.npmjs.org',
  'pypi.org',
  'files.pythonhosted.org',
  'api.openai.com',
  'api.anthropic.com',
  'googleapis.com',
  'www.googleapis.com',
]);

function isBenignHost(host: string): boolean {
  if (!host) return true;
  if (BENIGN_HOSTS.has(host)) return true;
  // 末尾匹配:foo.github.com 视为 github.com 的子域,豁免
  for (const b of BENIGN_HOSTS) {
    if (host === b || host.endsWith(`.${b}`)) return true;
  }
  return false;
}

// ──────────────────────────────────────────────────────────────────────────────
// 内部:per-skill 能力画像
// ──────────────────────────────────────────────────────────────────────────────

/** 一条"命中线索"的定位信息(用于 finding 摘要)。 */
interface Hit {
  file: string;
  line: number;
  excerpt: string;
}

interface SkillProfile {
  skillId: string;
  /** 是否含敏感读取能力(凭据文件 / env)。 */
  hasSensitiveRead: boolean;
  sensitiveReadHit?: Hit;
  /** 是否含外发能力(POST / webhook / nc)。 */
  hasOutbound: boolean;
  outboundHit?: Hit;
  /** 是否写全局 agent 配置(配置蔓延源)。 */
  hasGlobalConfigWrite: boolean;
  globalConfigWriteHit?: Hit;
  /** 写入的 dropzone 路径 → 首个命中(攻击链 1 的"投放点")。 */
  writtenDropzones: Map<string, Hit>;
  /** 读取/引用的 dropzone 路径 → 首个命中(攻击链 1 的"取件点")。 */
  readDropzones: Map<string, Hit>;
  /** 引用的全局配置路径 → 首个命中(攻击链 3)。 */
  configPathRefs: Map<string, Hit>;
  /** 引用的非良性外部主机 → 首个命中(攻击链 2)。 */
  externalHosts: Map<string, Hit>;
}

function makeExcerpt(line: string, limit: number): string {
  return line.length > limit ? `${line.slice(0, limit)}…` : line;
}

/** 规范化路径用于跨 skill 比较:统一小写、去尾随标点/斜杠。 */
function normPath(p: string): string {
  return p.replace(/[)"'`,;]+$/, '').replace(/\/+$/, '').toLowerCase();
}

/**
 * 扫一个 skill 的所有文件,产出能力画像。纯函数,只读 files。
 */
function profileSkill(input: CrossSkillInput, limit: number): SkillProfile {
  const profile: SkillProfile = {
    skillId: input.skillId,
    hasSensitiveRead: false,
    hasOutbound: false,
    hasGlobalConfigWrite: false,
    writtenDropzones: new Map(),
    readDropzones: new Map(),
    configPathRefs: new Map(),
    externalHosts: new Map(),
  };

  for (const file of input.files) {
    if (!file || typeof file.content !== 'string') continue;
    const lines = file.content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i]!;
      // 截断超长行,防御性限制;不必精确,仅限制扫描成本。
      const line = raw.length > MAX_SCAN_LINE_LENGTH ? raw.slice(0, MAX_SCAN_LINE_LENGTH) : raw;
      const lineNo = i + 1;
      const hit = (): Hit => ({ file: file.file, line: lineNo, excerpt: makeExcerpt(line, limit) });

      // 能力:敏感读取
      if (!profile.hasSensitiveRead && (SENSITIVE_READ_RE.test(line) || ENV_READ_RE.test(line))) {
        profile.hasSensitiveRead = true;
        profile.sensitiveReadHit = hit();
      }
      // 能力:外发
      if (!profile.hasOutbound && OUTBOUND_RE.test(line)) {
        profile.hasOutbound = true;
        profile.outboundHit = hit();
      }
      // 能力 + 线索:写全局配置
      const isGlobalConfigLine = GLOBAL_CONFIG_WRITE_RE.test(line);
      if (isGlobalConfigLine && WRITE_VERB_RE.test(line) && !profile.hasGlobalConfigWrite) {
        profile.hasGlobalConfigWrite = true;
        profile.globalConfigWriteHit = hit();
      }
      // 线索:全局配置路径引用(读或写都记;链 3 需要"另一个 skill 引用同一配置")
      if (isGlobalConfigLine) {
        const m = GLOBAL_CONFIG_WRITE_RE.exec(line);
        if (m) {
          const key = normPath(m[0].replace(/^[/~"'=\s`]/, ''));
          if (key && !profile.configPathRefs.has(key)) profile.configPathRefs.set(key, hit());
        }
      }

      // 线索:dropzone 路径(区分读 / 写上下文)
      const isWriteLine = WRITE_VERB_RE.test(line);
      for (const m of line.matchAll(DROPZONE_PATH_RE)) {
        const key = normPath(m[0]);
        if (!key) continue;
        if (isWriteLine) {
          if (!profile.writtenDropzones.has(key)) profile.writtenDropzones.set(key, hit());
        } else if (!profile.readDropzones.has(key)) {
          profile.readDropzones.set(key, hit());
        }
      }

      // 线索:外部主机(过滤良性主机)
      for (const m of line.matchAll(URL_RE)) {
        const host = hostOf(m[0]);
        if (!host || isBenignHost(host)) continue;
        if (!profile.externalHosts.has(host)) profile.externalHosts.set(host, hit());
      }
    }
  }

  return profile;
}

// ──────────────────────────────────────────────────────────────────────────────
// finding 构造
// ──────────────────────────────────────────────────────────────────────────────

function finding(
  ruleId: string,
  severity: Severity,
  file: string,
  line: number,
  excerpt: string,
  message: string,
): AuditFinding {
  return { ruleId, severity, file, line, excerpt, message };
}

// ──────────────────────────────────────────────────────────────────────────────
// 主入口
// ──────────────────────────────────────────────────────────────────────────────

/**
 * 分析多个 skill 之间的协同攻击链。
 *
 * 仅在两个**不同** skill 之间存在**具体关联线索**(共享 dropzone 路径 / 共享外部
 * 主机 / 共享全局配置路径)且能力互补时才产出 finding。单个 skill 自身的完整链
 * 不在此报(交给单文件规则)。
 *
 * 纯函数:不读盘、不联网、不 spawn、永不抛异常。
 *
 * @param skills - 各 skill 的 { skillId, files }
 * @param options - 可选项(excerpt 截断长度等)
 * @returns AuditFinding[](可能为空)。每条 finding 的 file/line 指向能让用户最快
 *          定位的那个 skill 文件位置(投放点 / 取件点 / 配置写点)。
 */
export function analyzeCrossSkillCollusion(
  skills: CrossSkillInput[],
  options: CrossSkillOptions = {},
): AuditFinding[] {
  const findings: AuditFinding[] = [];

  // 空 / 单 skill:不可能构成跨-skill 链,直接返回空。
  if (!Array.isArray(skills) || skills.length < 2) return findings;

  const limit = options.excerptLimit ?? DEFAULT_EXCERPT_LIMIT;

  // 1. 为每个 skill 建能力画像(容错:跳过无效条目)。
  const profiles: SkillProfile[] = [];
  for (const s of skills) {
    if (!s || typeof s.skillId !== 'string' || !Array.isArray(s.files)) continue;
    profiles.push(profileSkill(s, limit));
  }
  if (profiles.length < 2) return findings;

  // 去重集:同一对 skill + 同一线索类型 + 同一线索值只报一次。
  const seen = new Set<string>();

  // 2. 两两比较(有序对:A=源/读, B=汇/发)。角色不对称,故需双向各看一次。
  for (let i = 0; i < profiles.length; i++) {
    for (let j = 0; j < profiles.length; j++) {
      if (i === j) continue;
      const a = profiles[i]!;
      const b = profiles[j]!;

      // ── 攻击链 1:A 敏感读取 + 把数据写到 dropzone;B 从同一 dropzone 读取 + 外发 ──
      // 关键约束:读能力在 A,外发能力在 B(横跨两 skill);线索 = 共享的具体 dropzone 路径。
      if (a.hasSensitiveRead && b.hasOutbound) {
        for (const [path, writeHit] of a.writtenDropzones) {
          const readHit = b.readDropzones.get(path);
          if (!readHit) continue;
          const dedupKey = `chain1|${a.skillId}|${b.skillId}|${path}`;
          if (seen.has(dedupKey)) continue;
          seen.add(dedupKey);
          findings.push(
            finding(
              'cross-skill/collusion-exfil-dropzone',
              'high',
              writeHit.file,
              writeHit.line,
              writeHit.excerpt,
              `跨-skill 协同攻击链:单独看各 skill 不致命,组合构成凭据外泄链 —— ` +
                `skill "${a.skillId}" 读取敏感凭据并写入共享投放点 "${path}",` +
                `skill "${b.skillId}" 从同一路径读取后向外发送。` +
                `(投放:${a.skillId}/${writeHit.file}:${writeHit.line};` +
                `取件+外发:${b.skillId}/${readHit.file}:${readHit.line})`,
            ),
          );
        }
      }

      // ── 攻击链 2:A 敏感读取 + 引用某外部主机;B 向同一外部主机外发数据 ──
      // 共享的"约定 endpoint" 是把两者绑成一条链的具体线索。
      if (a.hasSensitiveRead && b.hasOutbound) {
        for (const [host, aHostHit] of a.externalHosts) {
          if (!b.externalHosts.has(host)) continue;
          const dedupKey = `chain2|${a.skillId}|${b.skillId}|${host}`;
          if (seen.has(dedupKey)) continue;
          seen.add(dedupKey);
          // finding 定位到 B 的外发点(用户最该看的危险动作);若 B 无独立外发命中,退回主机命中。
          const loc = b.outboundHit ?? b.externalHosts.get(host) ?? aHostHit;
          const readLoc = a.sensitiveReadHit ?? aHostHit;
          findings.push(
            finding(
              'cross-skill/collusion-exfil-endpoint',
              'high',
              loc.file,
              loc.line,
              loc.excerpt,
              `跨-skill 协同攻击链:单独看各 skill 不致命,组合构成凭据外泄链 —— ` +
                `skill "${a.skillId}" 读取敏感凭据,skill "${b.skillId}" 向二者共同引用的外部端点 ` +
                `"${host}" 外发数据。共享的外部端点把两个 skill 绑成同一条外泄链。` +
                `(读取:${a.skillId}/${readLoc.file}:${readLoc.line};` +
                `外发:${b.skillId}/${loc.file}:${loc.line})`,
            ),
          );
        }
      }

      // ── 攻击链 3:A 改写全局 agent 配置;B 引用被改的同一配置路径(配置蔓延 / 提权) ──
      // 约束:写在 A(hasGlobalConfigWrite),引用在 B(configPathRefs)。线索 = 共享配置路径。
      // severity=medium → 落 REVIEW 档,提示人工复核而非直接阻断。
      if (a.hasGlobalConfigWrite && a.globalConfigWriteHit) {
        for (const [cfgPath, writeHit] of a.configPathRefs) {
          const bRef = b.configPathRefs.get(cfgPath);
          if (!bRef) continue;
          // 不要求 B 一定不写;但若 B 也写同一路径,链 1/2 之外这仍是"两 skill 都碰同一全局配置"的
          // 协同信号,值得复核。dedup 保证同一对+同一路径只报一次。
          const dedupKey = `chain3|${a.skillId}|${b.skillId}|${cfgPath}`;
          if (seen.has(dedupKey)) continue;
          seen.add(dedupKey);
          findings.push(
            finding(
              'cross-skill/config-spread',
              'medium',
              writeHit.file,
              writeHit.line,
              writeHit.excerpt,
              `跨-skill 协同链(配置蔓延):单独看各 skill 不致命,组合可提权 —— ` +
                `skill "${a.skillId}" 改写全局 agent 配置 "${cfgPath}",` +
                `skill "${b.skillId}" 引用同一配置路径,可利用被改配置获得额外能力,建议人工复核。` +
                `(写配置:${a.skillId}/${writeHit.file}:${writeHit.line};` +
                `引用:${b.skillId}/${bRef.file}:${bRef.line})`,
            ),
          );
        }
      }
    }
  }

  return findings;
}
