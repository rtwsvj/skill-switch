// 规则引擎骨架:对目标文件内容逐行跑规则,产出 findings + 评分 + 档位。
// 纯函数:文件读取由调用方(S2.5 的 audit CLI)负责,引擎只看内容。
//
// W3:改用 RE2 线性时间引擎根治 ReDoS。
//   compileMatcher(pattern) 对每条规则 pattern 尝试用 RE2 编译;
//   能编译的走 RE2(线性,无回溯);不能编译的(含 lookahead/lookbehind/backreference 或
//   量词超限)自动回退到原生 RegExp + 行长截断兜底。
//   行长截断(MAX_AUDIT_MATCH_LINE_LENGTH=2048)作为 defense-in-depth 保留。
//   编译结果通过 WeakMap 缓存——同一 RegExp 对象只编译一次。
import { createRequire } from 'node:module';
import { sanitizeOutputText } from '../security/output-safety.ts';
import { scoreFindings, verdictForScore, type Verdict } from './score.ts';
import type { AuditFileRule, AuditFileTarget, AuditFinding, AuditRule } from './types.ts';
import { CONFUSABLES_MAP } from './confusables-data.ts';

// ── RE2 动态加载(CJS 模块,ESM 用 createRequire) ───────────────────────────────
// re2 是原生扩展(CJS),在 ESM 环境下通过 createRequire 加载。
// 若加载失败(如 SEA 环境原生模块不可用),整体降级为纯原生 RegExp。
//
// SEA(Single Executable Application)兼容:SEA 将代码打包为 CJS,
// import.meta.url 在该上下文中为 undefined —— 直接调用 createRequire(undefined) 会抛。
// 检测到 undefined 时跳过 RE2 加载,静默降级为纯原生 RegExp + 行截断。
let RE2: (new (source: string, flags?: string) => { test(s: string): boolean }) | null = null;
try {
  // 仅在 import.meta.url 有效时(ESM 环境)尝试加载 RE2
  if (typeof import.meta.url === 'string') {
    const _require = createRequire(import.meta.url);
    RE2 = _require('re2') as typeof RE2;
  }
} catch {
  // RE2 不可用时静默降级;行截断兜底确保 ReDoS 防御不失效
  RE2 = null;
}

export interface AuditTarget extends AuditFileTarget {}

export interface AuditReport {
  findings: AuditFinding[];
  score: number;
  verdict: Verdict;
}

const EXCERPT_LIMIT = 200;
export const MAX_AUDIT_MATCH_LINE_LENGTH = 2 * 1024;

// ── Matcher 统一接口 ──────────────────────────────────────────────────────────
/**
 * 统一匹配接口:RE2 和原生 RegExp 均满足 { test(s: string): boolean }。
 * engine 内部只用 test(),因此两者可互换。
 */
interface Matcher {
  test(s: string): boolean;
}

interface MatcherResult {
  matcher: Matcher;
  engine: 're2' | 'fallback';
}

// WeakMap 缓存:同一 RegExp 对象只调用一次 compileMatcher,避免重复 RE2 construction 开销。
// 键为 RegExp 实例;值为编译结果。垃圾回收友好。
const _matcherCache = new WeakMap<RegExp, MatcherResult>();

/**
 * compileMatcher:对 RegExp 模式尝试编译 RE2(线性时间引擎)。
 *
 * RE2 不支持 lookahead / lookbehind / backreference,且内部量词上限约 1000;
 * 若编译失败则回退原生 RegExp。
 * 回退规则:
 *   - rules/prompt-injection.ts 的 zero-width-chars 模式已重写为 RE2 兼容形式(无 lookaround)
 *   - rules/base64-payload.ts 的 DANGEROUS_DECODED_PATTERNS 中 rm-rf 模式已重写
 *   - 含 {0,2048} 大量词的规则(exfiltration/sensitive-file-exfil 等)RE2 量词超限,
 *     自动回退原生 RegExp + 行截断(已有 r23a-redos-guard 实测保护)
 *
 * flags 处理:
 *   - 剥离 g/y(有状态标志),只保留 i/m/s/u
 *   - RE2 在编译时自动加 u(unicode);原生 RegExp 保持原 flags
 *
 * 结果通过 WeakMap 缓存;同一 RegExp 对象只编译一次。
 * @export 供测试文件直接断言 RE2 / fallback 行为
 */
export function compileMatcher(pattern: RegExp): MatcherResult {
  // 缓存命中
  const cached = _matcherCache.get(pattern);
  if (cached !== undefined) return cached;

  // 剥离 g/y(有状态标志),保留其余 flags
  const safeFlags = pattern.flags.replace(/[gy]/g, '');

  let result: MatcherResult;

  if (RE2 !== null) {
    try {
      const re2Instance = new RE2(pattern.source, safeFlags);
      result = { matcher: re2Instance, engine: 're2' };
    } catch {
      // RE2 编译失败(lookaround / backreference / 量词超限等),回退原生 RegExp
      const jsRe = safeFlags === pattern.flags
        ? pattern
        : new RegExp(pattern.source, safeFlags);
      result = { matcher: jsRe, engine: 'fallback' };
    }
  } else {
    // RE2 不可用时整体降级
    const jsRe = safeFlags === pattern.flags
      ? pattern
      : new RegExp(pattern.source, safeFlags);
    result = { matcher: jsRe, engine: 'fallback' };
  }

  _matcherCache.set(pattern, result);
  return result;
}

// ── 同形字归一化 ──────────────────────────────────────────────────────────
// 使用 confusables-data.ts 中的扩展映射表(覆盖 Cyrillic 全集 + 希腊字母 +
// 全角 ASCII + 常见 Latin lookalike,共数百条)。
// NFKC 先处理全宽字符(如 ．→.)再做同形字替换。
// 仅用于规则匹配;原文保留用于 excerpt。
// 向后兼容:HOMOGLYPH_MAP 为 CONFUSABLES_MAP 的别名(内部使用,不 export)。
const HOMOGLYPH_MAP: ReadonlyMap<string, string> = CONFUSABLES_MAP;

/** 判断字符串是否含非 ASCII 字符(codePoint > 127)。 */
function hasNonAscii(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    if ((s.codePointAt(i) ?? 0) > 127) return true;
  }
  return false;
}

/**
 * NFKC 归一化后再做同形字映射。
 * 输入必须已截断到 MAX_AUDIT_MATCH_LINE_LENGTH 以内。
 */
export function normalizeForMatch(line: string): string {
  const nfkc = line.normalize('NFKC');
  // 快速路径:若不含非 ASCII 字符则无需逐字扫描
  if (!hasNonAscii(nfkc)) return nfkc;
  let out = '';
  for (const ch of nfkc) {
    out += HOMOGLYPH_MAP.get(ch) ?? ch;
  }
  return out;
}

/** 剥离 g/y 标志:有状态的 lastIndex 会让同一规则跨行漏报。(仅用于纯 RegExp 路径兼容) */
function statelessPattern(pattern: RegExp): RegExp {
  const flags = pattern.flags.replace(/[gy]/g, '');
  return flags === pattern.flags ? pattern : new RegExp(pattern.source, flags);
}

function matchableLine(line: string): string {
  return line.length > MAX_AUDIT_MATCH_LINE_LENGTH
    ? line.slice(0, MAX_AUDIT_MATCH_LINE_LENGTH)
    : line;
}

// ── 字符串字面量拼接折叠(Wave-H:闭合最后一个审计漏判) ────────────────────────
//
// 攻击者把外渗 endpoint 用字符串字面量拼接拆开,绕过所有基于整串匹配的规则。
// 本模块做零误报风险的最小子集:手写线性扫描器,只折叠单行内纯字面量之间的
// `+` 拼接。链条中出现任何标识符、模板字符串(反引号)、`${`、数字、函数调用
// → 该链条整体不折叠(保守优先,漏折不误折)。折叠后,把折叠行作为第三种匹配
// 变体交给既有规则——良性代码折叠出来还是良性字符串,误报面为零。
//
// 性能:线性字符扫描,无正则、无回溯;单链上限 16 段,与既有
// MAX_AUDIT_MATCH_LINE_LENGTH(2KB)截断逻辑配合,杜绝病态输入 DoS。

/** 单链允许的最大段数(超过此数的额外段不并入,留在行原文中)。 */
const MAX_FOLD_SEGMENTS = 16;

/**
 * 扫描一个字符串字面量,返回其 JS 解码后的值与结束下标(指向闭引号之后一格)。
 * 只识别 `'` / `"` 包裹的字面量;反引号模板直接返回 null(交由外层判为非字面量)。
 * 转义仅按规格要求处理 `\'`、`\"`、`\`\`\\`\`,其它转义(如 `\n`、`\t`、`\u00ff`)
 * 保留原两字符,编码时由 encodeForLiteral 通过 `\\` 重新包装,保证往返一致。
 * 未闭合(行内找不到闭引号)返回 null,外层把开引号作为普通字符保留。
 */
function scanStringLiteral(line: string, start: number): { value: string; end: number } | null {
  if (start >= line.length) return null;
  const quote = line[start];
  if (quote !== "'" && quote !== '"') return null;

  let i = start + 1;
  let value = '';
  while (i < line.length) {
    const ch = line[i];
    if (ch === quote) {
      return { value, end: i + 1 };
    }
    if (ch === '\\') {
      if (i + 1 >= line.length) return null;
      const esc = line[i + 1];
      if (esc === "'" || esc === '"' || esc === '\\') {
        value += esc;
        i += 2;
      } else {
        // 其它转义原样保留两字符,编码侧会统一重新加 `\\`,不影响 JS 语义。
        value += line.slice(i, i + 2);
        i += 2;
      }
    } else {
      value += ch;
      i++;
    }
  }
  return null;
}

/**
 * 把已解码的 JS 字符串值重新包装为指定引号风格的字面量源文本。
 * 规则:反斜杠一律 `\\` 转义,所选引号一律 `\<quote>` 转义,其它字符原样。
 * 手写字符循环,不用正则(与本模块扫描器约束一致)。
 */
function encodeForLiteral(value: string, quote: string): string {
  let out = '';
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (ch === '\\') {
      out += '\\\\';
    } else if (ch === quote) {
      out += `\\${quote}`;
    } else {
      out += ch;
    }
  }
  return out;
}

/**
 * 尝试从 start 处开始折叠一条纯字面量链。
 * 读取首段字面量后,反复:跳过空白 → 期待 `+` → 跳过空白 → 期待下一个字面量。
 * 任意一步遇到非字面量(标识符、反引号、`${`、数字、函数调用等)→ 整体不折叠,
 * 返回 null(由外层保留原文);链长达到 MAX_FOLD_SEGMENTS 后停止扩展,多余段
 * 留在行原文中(避免单链无限扩张导致折叠行膨胀)。
 * 返回非 null 时,text 为新字面量源文本,end 为链在原行中的结束下标(独占位置)。
 */
function tryFoldChain(
  line: string,
  start: number,
): { text: string; end: number } | null {
  const firstLit = scanStringLiteral(line, start);
  if (firstLit === null) return null;

  const quoteStyle = line[start]!;
  const segments: string[] = [firstLit.value];
  let end = firstLit.end;
  // 标记是否在 `+` 之后遇到非字面量;一旦遇到,整条链放弃(规格:整体不折叠)。
  let abortedByNonLiteral = false;

  while (segments.length < MAX_FOLD_SEGMENTS) {
    let pp = end;
    while (pp < line.length && (line[pp] === ' ' || line[pp] === '\t')) pp++;
    if (pp >= line.length || line[pp] !== '+') break;
    pp++;
    while (pp < line.length && (line[pp] === ' ' || line[pp] === '\t')) pp++;
    if (pp >= line.length) break;

    const nextCh = line[pp]!;
    // 只接受 `'` / `"` 引号包裹的字面量;反引号、字母、数字、`(`、`$` 等一律视为
    // 非字面量,触发"整体不折叠"保守分支。
    if (nextCh !== "'" && nextCh !== '"') {
      abortedByNonLiteral = true;
      break;
    }

    const lit = scanStringLiteral(line, pp);
    if (lit === null) {
      abortedByNonLiteral = true;
      break;
    }

    segments.push(lit.value);
    end = lit.end;
  }

  if (abortedByNonLiteral) return null;
  if (segments.length < 2) return null;

  const joined = segments.join('');
  const foldedText = quoteStyle + encodeForLiteral(joined, quoteStyle) + quoteStyle;
  return { text: foldedText, end };
}

/**
 * 单行内折叠纯字符串字面量的 `+` 拼接链,无可折叠时返回 null。
 *
 * 手写线性扫描器(不用正则)。逐字符扫:遇到 `'` 或 `"` 起始的字面量,正确处理
 * 转义(`\'`、`\"`、`\\`);字面量结束后跳过空白,若下一个非空白字符是 `+` 且其后
 * (跳过空白)又是引号字面量,则并入链条。链条中一旦出现标识符、反引号、`${`、
 * 数字或函数调用 → 该链条整体不折叠(保守优先)。一行内可有多个独立链条,都折叠。
 * 单链上限 16 段,行长沿用既有 MAX_AUDIT_MATCH_LINE_LENGTH 截断。
 *
 * 返回的折叠行:把每条折叠链替换为单一字面量(用原链第一段的引号风格),
 * 行其余部分原样保留。无可折叠时返回 null,引擎跳过第三轮匹配。
 */
export function foldStringConcatLiterals(line: string): string | null {
  let result = '';
  let i = 0;
  let changed = false;

  while (i < line.length) {
    const ch = line[i]!;
    if (ch === "'" || ch === '"') {
      const firstLit = scanStringLiteral(line, i);
      if (firstLit === null) {
        // 未闭合字面量:把开引号当普通字符保留,继续往后扫(防御性,正常 SKILL 文档
        // 不会触发)。
        result += ch;
        i++;
        continue;
      }

      const folded = tryFoldChain(line, i);
      if (folded !== null) {
        result += folded.text;
        i = folded.end;
        changed = true;
      } else {
        // 不可折叠(单字面量或遇非字面量阻断):原样复制首段字面量,继续扫后续。
        result += line.slice(i, firstLit.end);
        i = firstLit.end;
      }
    } else {
      result += ch;
      i++;
    }
  }

  return changed ? result : null;
}

function matchableContent(content: string): string {
  if (content.length <= MAX_AUDIT_MATCH_LINE_LENGTH) return content;
  return content.split('\n').map(matchableLine).join('\n');
}

// ── Markdown 围栏代码块检测 ───────────────────────────────────────────────────
// 构建一个布尔数组:lines[i] 所在行是否在 ``` 围栏代码块内(true)。
// 规则:连续三个反引号(可选语言标识符)开始围栏,相同数量的反引号关闭围栏。
// 只处理 ``` 风格(不处理 ~~~ 或缩进块),与 GitHub Markdown 行为一致。
// 标注行为:围栏开始行本身也标为 inCodeBlock,与 VSCode/GH 渲染一致。
// 此函数为纯函数,无副作用。
function buildCodeBlockMap(lines: string[]): boolean[] {
  const map: boolean[] = new Array(lines.length).fill(false);
  let inBlock = false;
  let fenceChar = '';   // 当前围栏使用的字符('`')
  let fenceLen = 0;     // 当前围栏的反引号数量(>= 3)

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const trimmed = line.trimStart();

    if (!inBlock) {
      // 检测开始围栏:行首(可有 0-3 空格缩进)跟着 3 个或以上的 `
      const m = /^(`{3,})/.exec(trimmed);
      if (m) {
        inBlock = true;
        fenceChar = '`';
        fenceLen = m[1]!.length;
        map[i] = true; // 围栏开始行本身也标注
      }
    } else {
      // 在围栏内:检测关闭围栏(同字符、同数量或更多、行尾无其他内容)
      map[i] = true;
      const closeRe = new RegExp(`^${fenceChar}{${fenceLen},}\\s*$`);
      if (closeRe.test(trimmed)) {
        inBlock = false;
        fenceChar = '';
        fenceLen = 0;
      }
    }
  }
  return map;
}

export function runRules(rules: AuditRule[], targets: AuditTarget[]): AuditFinding[] {
  const findings: AuditFinding[] = [];
  // W3:每条规则用 compileMatcher 尝试 RE2(结果已 WeakMap 缓存,多次调用无额外开销)。
  const compiled = rules.map((rule) => {
    const { matcher } = compileMatcher(rule.pattern);
    return { rule, matcher };
  });

  for (const target of targets) {
    const lines = target.content.split('\n');
    // 构建代码块映射(additive:仅用于给 finding 添加 inCodeBlock 标注)
    const codeBlockMap = buildCodeBlockMap(lines);

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      // 行截断作为 defense-in-depth 保留:RE2 也限大输入,原生 RegExp 更需保护。
      const lineForMatch = matchableLine(line);
      const lineNormalized = normalizeForMatch(lineForMatch);
      // Wave-H:第三轮——若本行可折叠为纯字面量链(lineForMatch 与 lineNormalized
      // 都没命中时再触发,避免对良性代码重复开销),把折叠行也喂给匹配器。
      // 折叠不产生自身 finding,只是把折叠后的行作为第三种匹配变体交给既有规则。
      // excerpt 仍用原始行(lineForMatch):证据保留攻击者的原样拼接写法。
      const lineFolded =
        foldStringConcatLiterals(lineForMatch) ?? null;
      const foldedActive =
        lineFolded !== null && lineFolded !== lineForMatch && lineFolded !== lineNormalized;
      // 先在原始行上匹配;若原始行无命中则在归一化行上再试一次;仍无命中再试折叠行。
      // 归一化只改变同形字/全宽字符,折叠只组合相邻纯字面量,二者都不会把良性内容
      // 变成恶意内容;三轮去重结构同构,同一 (行,规则) 至多一条 finding。
      for (const { rule, matcher } of compiled) {
        if (
          !matcher.test(lineForMatch) &&
          !matcher.test(lineNormalized) &&
          !(foldedActive && matcher.test(lineFolded!))
        ) {
          continue;
        }
        const finding: AuditFinding = {
          ruleId: rule.id,
          severity: rule.severity,
          file: target.file,
          line: i + 1,
          excerpt: excerpt(lineForMatch),
          message: rule.message,
        };
        // additive 标注:仅在 true 时才写 inCodeBlock 字段,保持输出最小化
        if (codeBlockMap[i]) {
          finding.inCodeBlock = true;
        }
        findings.push(finding);
      }
    }
  }
  return findings;
}

function excerpt(text: string): string {
  const safe = sanitizeOutputText(text);
  return safe.length > EXCERPT_LIMIT ? `${safe.slice(0, EXCERPT_LIMIT)}…` : safe;
}

export function runFileRules(fileRules: AuditFileRule[], targets: AuditTarget[]): AuditFinding[] {
  const findings: AuditFinding[] = [];
  for (const target of targets) {
    const targetForMatch: AuditFileTarget = {
      ...target,
      content: matchableContent(target.content),
    };
    for (const rule of fileRules) {
      const match = rule.evaluate(targetForMatch);
      if (!match) continue;
      findings.push({
        ruleId: rule.id,
        severity: rule.severity,
        file: target.file,
        line: match.line,
        excerpt: excerpt(match.excerpt),
        message: rule.message,
      });
    }
  }
  return findings;
}

export function auditContents(rules: AuditRule[], targets: AuditTarget[], fileRules: AuditFileRule[] = []): AuditReport {
  const findings = [...runRules(rules, targets), ...runFileRules(fileRules, targets)];
  const score = scoreFindings(findings);
  return { findings, score, verdict: verdictForScore(score) };
}

// 内部工具:暴露 statelessPattern 供测试验证降级路径(不影响公开 API)
export { statelessPattern as _statelessPatternForTest };
