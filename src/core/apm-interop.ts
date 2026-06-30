// 任务 D:microsoft/apm 的 apm.yml / apm.lock.yaml 互操作(只读)。
//
// 定位:skill-switch 不与 APM(Agent Package Manager)硬刚,而是"互操作"——
//   读 APM 生态的声明/锁,只挑出其中的 **skill 类原语**,映射到 skill-switch 的
//   声明模型(SkillDeclaration),做整个链条里"最强安全 + 治理"那一环。
//
// 安全姿态(硬约束):
//   - 纯本地文件解析,只读。绝不执行 apm.yml 里的任何命令 / 脚本 / install,绝不联网。
//   - 不依赖任何 YAML 库(仓库无 YAML 依赖):手写一个 **极小子集** 解析器,
//     只认 apm.yml/apm.lock.yaml 用到的结构(2 空格缩进的 map、`- ` 序列、标量、
//     `#` 注释、引号字符串)。锚点 / 别名 / 标签 / 多行块 / 流式 {a: b} 一律不支持,
//     遇到就稳健报错(InvalidApmYamlError),绝不抛未捕获异常、绝不"猜"。
//   - 字段缺失 / 类型不对 / 缩进非法 → 抛 InvalidApmYamlError(带行号),调用方可捕获。
//
// 非 skill 原语(prompts / agents / hooks / mcp 等)**明确跳过并记录**,见 mapApmToImports
// 返回的 skipped 列表,命令层据此告诉用户"跳过了什么、为什么"。

import type { AgentType } from '../vendor/vercel-skills/types.ts';
import { isSafeSkillName } from './skill-name.ts';
import type { SkillDeclaration } from './sync.ts';

export class InvalidApmYamlError extends Error {
  /** 1-based 行号(若可定位) */
  readonly line?: number;
  constructor(message: string, line?: number) {
    super(line === undefined ? message : `第 ${line} 行: ${message}`);
    this.name = 'InvalidApmYamlError';
    this.line = line;
  }
}

// ---------------------------------------------------------------------------
// 极小 YAML 子集解析器
//
// 支持:
//   - 2 空格缩进的嵌套 map(key: value / key:)
//   - `- ` 序列项(标量项,或 `- key: value` 起头的内联 map 项)
//   - 标量:裸标量、单/双引号字符串(双引号支持 \" \\ \n \t 转义)、
//     true/false/null、整数 / 浮点
//   - 整行注释(以可选空白 + `#`)与行尾注释(标量之后、引号外的 ` #`)
// 不支持(遇到即报错,而非静默放过):制表符缩进、奇数缩进、流式集合 `{}`/`[]`、
//   锚点 `&` / 别名 `*` / 合并键 `<<` / 标签 `!!` / 多行块 `|` `>`。
// ---------------------------------------------------------------------------

export type YamlValue =
  | string
  | number
  | boolean
  | null
  | YamlValue[]
  | { [key: string]: YamlValue };

interface RawLine {
  /** 1-based 源行号 */
  lineNo: number;
  /** 缩进空格数 */
  indent: number;
  /** 去掉缩进与行尾注释后的内容 */
  content: string;
}

function stripInlineComment(text: string): string {
  // 在引号外遇到 ` #`(或行首 `#`)即视为注释起点。
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inSingle) {
      if (ch === "'") inSingle = false;
      continue;
    }
    if (inDouble) {
      if (ch === '\\') {
        i += 1; // 跳过被转义字符
        continue;
      }
      if (ch === '"') inDouble = false;
      continue;
    }
    if (ch === "'") inSingle = true;
    else if (ch === '"') inDouble = true;
    else if (ch === '#' && (i === 0 || text[i - 1] === ' ' || text[i - 1] === '\t')) {
      return text.slice(0, i);
    }
  }
  return text;
}

function tokenizeLines(source: string): RawLine[] {
  const out: RawLine[] = [];
  const lines = source.split(/\r\n|\r|\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const lineNo = i + 1;
    const raw = lines[i] ?? '';
    if (raw.includes('\t')) {
      // 制表符缩进在 YAML 里非法且语义易错,直接拒绝(但纯注释/空行容忍)。
      const trimmedForComment = raw.trim();
      if (trimmedForComment === '' || trimmedForComment.startsWith('#')) continue;
      throw new InvalidApmYamlError('缩进含制表符(只支持空格缩进)', lineNo);
    }
    const stripped = stripInlineComment(raw);
    if (stripped.trim() === '') continue; // 空行 / 纯注释行
    const indent = stripped.length - stripped.trimStart().length;
    if (indent % 2 !== 0) {
      throw new InvalidApmYamlError(`缩进必须是 2 的倍数(实际 ${indent} 空格)`, lineNo);
    }
    out.push({ lineNo, indent, content: stripped.slice(indent) });
  }
  return out;
}

function parseScalar(token: string, lineNo: number): YamlValue {
  const t = token.trim();
  if (t === '') return null;
  if (t === '~' || t === 'null' || t === 'Null' || t === 'NULL') return null;
  if (t === 'true' || t === 'True' || t === 'TRUE') return true;
  if (t === 'false' || t === 'False' || t === 'FALSE') return false;

  if (t.startsWith('"')) {
    if (!t.endsWith('"') || t.length < 2) {
      throw new InvalidApmYamlError('双引号字符串未正确闭合', lineNo);
    }
    return decodeDoubleQuoted(t.slice(1, -1), lineNo);
  }
  if (t.startsWith("'")) {
    if (!t.endsWith("'") || t.length < 2) {
      throw new InvalidApmYamlError('单引号字符串未正确闭合', lineNo);
    }
    // 单引号里 '' 表示一个字面单引号
    return t.slice(1, -1).replace(/''/g, "'");
  }

  // 不支持流式集合,避免误把 `[a, b]` / `{a: b}` 当成裸标量。
  if (t.startsWith('[') || t.startsWith('{')) {
    throw new InvalidApmYamlError('不支持流式集合([] 或 {}),请用块式写法', lineNo);
  }
  if (t.startsWith('&') || t.startsWith('*') || t.startsWith('!')) {
    throw new InvalidApmYamlError('不支持锚点 / 别名 / 标签(& * !)', lineNo);
  }

  // 数字
  if (/^[+-]?\d+$/.test(t)) {
    const n = Number(t);
    if (Number.isSafeInteger(n)) return n;
    return t; // 超大整数保留为字符串,避免精度丢失
  }
  if (/^[+-]?(\d+\.\d*|\.\d+|\d+)([eE][+-]?\d+)?$/.test(t)) {
    return Number(t);
  }

  return t;
}

function decodeDoubleQuoted(body: string, lineNo: number): string {
  let out = '';
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (ch !== '\\') {
      out += ch;
      continue;
    }
    const next = body[i + 1];
    i += 1;
    switch (next) {
      case 'n':
        out += '\n';
        break;
      case 't':
        out += '\t';
        break;
      case 'r':
        out += '\r';
        break;
      case '"':
        out += '"';
        break;
      case '\\':
        out += '\\';
        break;
      case '0':
        out += '\0';
        break;
      default:
        throw new InvalidApmYamlError(`不支持的转义序列 \\${next ?? ''}`, lineNo);
    }
  }
  return out;
}

interface Cursor {
  i: number;
}

/**
 * 解析一个 block —— 由缩进 === minIndent 的连续行组成的 map 或 sequence。
 * 调用时 lines[cursor.i] 的缩进必须 >= minIndent;返回时 cursor.i 指向第一条
 * 缩进 < minIndent 的行(或末尾)。
 */
function parseBlock(lines: RawLine[], cursor: Cursor, minIndent: number): YamlValue {
  const first = lines[cursor.i];
  if (!first) return null;
  if (first.indent < minIndent) return null;
  if (first.indent > minIndent) {
    throw new InvalidApmYamlError('意外的缩进增加', first.lineNo);
  }

  if (first.content.startsWith('- ') || first.content === '-') {
    return parseSequence(lines, cursor, minIndent);
  }
  return parseMap(lines, cursor, minIndent);
}

function parseSequence(lines: RawLine[], cursor: Cursor, indent: number): YamlValue[] {
  const items: YamlValue[] = [];
  while (cursor.i < lines.length) {
    const line = lines[cursor.i]!;
    if (line.indent < indent) break;
    if (line.indent > indent) {
      throw new InvalidApmYamlError('序列项缩进非法', line.lineNo);
    }
    if (line.content !== '-' && !line.content.startsWith('- ')) {
      // 同缩进下从序列切回 map —— 结束本序列,交回上层。
      break;
    }

    const rest = line.content === '-' ? '' : line.content.slice(2);
    if (rest.trim() === '') {
      // `-` 单独成行:子块在更深缩进。
      cursor.i += 1;
      const child = parseBlock(lines, cursor, indent + 2);
      items.push(child);
      continue;
    }

    // `- key: value` 这类内联 map 项:把这一行重写成同缩进的 map 起始行,
    // 让 parseMap 接管(它会把后续 indent+2 的行并进同一个 map)。
    const colonAt = findKeyColon(rest);
    if (colonAt >= 0) {
      const synthetic: RawLine = {
        lineNo: line.lineNo,
        indent: indent + 2,
        content: rest,
      };
      const tmp = [...lines];
      tmp[cursor.i] = synthetic;
      const subCursor: Cursor = { i: cursor.i };
      const mapVal = parseMap(tmp, subCursor, indent + 2);
      cursor.i = subCursor.i;
      items.push(mapVal);
      continue;
    }

    // `- scalar`
    items.push(parseScalar(rest, line.lineNo));
    cursor.i += 1;
  }
  return items;
}

/** 找到键与值之间的冒号位置(`key: value`),引号外、其后须为空格或行尾。返回 -1 表示不是 map 行。 */
function findKeyColon(content: string): number {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < content.length; i += 1) {
    const ch = content[i];
    if (inSingle) {
      if (ch === "'") inSingle = false;
      continue;
    }
    if (inDouble) {
      if (ch === '\\') {
        i += 1;
        continue;
      }
      if (ch === '"') inDouble = false;
      continue;
    }
    if (ch === "'") inSingle = true;
    else if (ch === '"') inDouble = true;
    else if (ch === ':' && (i + 1 >= content.length || content[i + 1] === ' ')) {
      return i;
    }
  }
  return -1;
}

function parseMap(lines: RawLine[], cursor: Cursor, indent: number): { [key: string]: YamlValue } {
  const map: { [key: string]: YamlValue } = {};
  while (cursor.i < lines.length) {
    const line = lines[cursor.i]!;
    if (line.indent < indent) break;
    if (line.indent > indent) {
      throw new InvalidApmYamlError('意外的缩进增加', line.lineNo);
    }
    if (line.content === '-' || line.content.startsWith('- ')) {
      // 同缩进出现序列项:本 map 结束,交回上层处理。
      break;
    }

    const colonAt = findKeyColon(line.content);
    if (colonAt < 0) {
      throw new InvalidApmYamlError(`期望 "key: value" 结构,得到: ${line.content}`, line.lineNo);
    }
    const rawKey = line.content.slice(0, colonAt).trim();
    const key = normalizeKey(rawKey, line.lineNo);
    if (Object.hasOwn(map, key)) {
      throw new InvalidApmYamlError(`重复的键: ${key}`, line.lineNo);
    }
    const valuePart = line.content.slice(colonAt + 1).trim();

    if (valuePart !== '') {
      // 行内值
      map[key] = parseScalar(valuePart, line.lineNo);
      cursor.i += 1;
      continue;
    }

    // 值在下一层缩进
    cursor.i += 1;
    const child = lines[cursor.i];
    if (!child || child.indent <= indent) {
      map[key] = null; // 空值键
      continue;
    }
    if (child.indent !== indent + 2) {
      throw new InvalidApmYamlError('子块缩进必须比父键多 2 空格', child.lineNo);
    }
    map[key] = parseBlock(lines, cursor, indent + 2);
  }
  return map;
}

function normalizeKey(rawKey: string, lineNo: number): string {
  if (rawKey === '') {
    throw new InvalidApmYamlError('空键', lineNo);
  }
  if (rawKey.startsWith('"') || rawKey.startsWith("'")) {
    const scalar = parseScalar(rawKey, lineNo);
    if (typeof scalar !== 'string') {
      throw new InvalidApmYamlError('键必须是字符串', lineNo);
    }
    return scalar;
  }
  // 防御:禁止把锚点 / 标签当键。
  if (rawKey.startsWith('&') || rawKey.startsWith('*') || rawKey.startsWith('!')) {
    throw new InvalidApmYamlError('不支持锚点 / 别名 / 标签(& * !)', lineNo);
  }
  return rawKey;
}

/** 解析任意 YAML 子集文本为 JS 值;空文档 → null。 */
export function parseYamlSubset(source: string): YamlValue {
  const lines = tokenizeLines(source);
  if (lines.length === 0) return null;
  if (lines[0]!.indent !== 0) {
    throw new InvalidApmYamlError('文档顶层不能有缩进', lines[0]!.lineNo);
  }
  const cursor: Cursor = { i: 0 };
  const value = parseBlock(lines, cursor, 0);
  if (cursor.i < lines.length) {
    throw new InvalidApmYamlError('文档结构非法(残留未解析的行)', lines[cursor.i]!.lineNo);
  }
  return value;
}

// ---------------------------------------------------------------------------
// APM schema(从 microsoft/apm 公开文档推断的子集)→ skill-switch 声明映射
//
// apm.yml 大致形态(只取我们需要的字段,容忍其它字段存在):
//   sources:                       # 命名的源仓库 / registry
//     official:
//       url: https://github.com/...
//   dependencies:                  # 或 primitives:,声明各类原语
//     skills:                      # ← 我们只要这一类
//       - name: code-review
//         source: official         # 引用 sources 里的键(可选)
//         path: skills/code-review # 源内子路径(可选)
//         version: 1.2.0           # 可选
//       - some-other-skill         # 也允许纯标量项(只有名字)
//     prompts: [...]               # ← 跳过
//     agents: [...]                # ← 跳过
//     hooks: [...]                 # ← 跳过
//   primitives:                    # 与 dependencies 同义,二选一或都有
//     skills: [...]
//
// apm.lock.yaml 大致形态(只读取 integrity / version 做 provenance / 报告):
//   skills:
//     code-review:
//       version: 1.2.0
//       integrity: sha256-...
//       resolved: https://...
// ---------------------------------------------------------------------------

/** APM 原语类别 → 是否属于 skill 类(我们要纳管的)。 */
const SKILL_PRIMITIVE_KEYS = new Set(['skills', 'skill']);

/** 已知但非 skill 的原语类别(报告里据此说明跳过原因)。 */
const KNOWN_NON_SKILL_PRIMITIVES = new Set([
  'prompts',
  'prompt',
  'agents',
  'agent',
  'hooks',
  'hook',
  'mcp',
  'mcps',
  'mcp-servers',
  'mcpServers',
  'tools',
  'tool',
  'instructions',
  'chatmodes',
  'commands',
]);

export interface ApmSkillImport {
  /** 规范化后的 skill 名(已过安全护栏) */
  name: string;
  /** 源:解析出的 url/path 字符串(provenance,不会被执行/抓取),无则 undefined */
  source?: string;
  /** apm.yml 里引用的命名源键(sources 里的键) */
  sourceRef?: string;
  /** 源内子路径(若声明) */
  path?: string;
  /** 版本(若声明) */
  version?: string;
  /** 来自 apm.lock.yaml 的完整性哈希(若有锁) */
  integrity?: string;
}

export interface ApmSkippedPrimitive {
  /** 原语类别(prompts / agents / hooks / 未知类别名) */
  category: string;
  /** 该类别下声明的条目数(无法计数时为 undefined) */
  count?: number;
  /** 跳过原因(给用户看的大白话) */
  reason: string;
}

export interface ApmMapping {
  /** 映射出的 skill 导入意图(尚未写盘) */
  skills: ApmSkillImport[];
  /** 明确跳过的非 skill 原语 */
  skipped: ApmSkippedPrimitive[];
  /** 解析过程中的非致命提醒(如命名不安全被丢弃、字段被忽略) */
  warnings: string[];
}

function asRecord(value: YamlValue | undefined): { [key: string]: YamlValue } | undefined {
  if (value !== null && value !== undefined && typeof value === 'object' && !Array.isArray(value)) {
    return value as { [key: string]: YamlValue };
  }
  return undefined;
}

function asString(value: YamlValue | undefined): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return undefined;
}

/** 从 sources 里把命名源解析成一个可读的 url/path 字符串(纯 provenance)。 */
function resolveSourceRef(
  sources: { [key: string]: YamlValue } | undefined,
  ref: string | undefined,
): string | undefined {
  if (!ref || !sources) return undefined;
  const entry = sources[ref];
  if (entry === undefined) return undefined;
  const rec = asRecord(entry);
  if (rec) {
    return asString(rec.url) ?? asString(rec.path) ?? asString(rec.repo) ?? undefined;
  }
  return asString(entry);
}

interface LockIndex {
  /** skill 名 → { integrity?, version? } */
  bySkill: Map<string, { integrity?: string; version?: string }>;
}

function indexLock(lockDoc: YamlValue | undefined): LockIndex {
  const bySkill = new Map<string, { integrity?: string; version?: string }>();
  const root = asRecord(lockDoc);
  if (!root) return { bySkill };

  // 锁里 skill 信息可能在 skills: 顶层,或在 primitives.skills / dependencies.skills。
  const candidates: YamlValue[] = [];
  for (const key of ['skills', 'skill']) {
    if (root[key] !== undefined) candidates.push(root[key]!);
  }
  for (const container of ['primitives', 'dependencies', 'packages']) {
    const sub = asRecord(root[container]);
    if (sub) {
      for (const key of ['skills', 'skill']) {
        if (sub[key] !== undefined) candidates.push(sub[key]!);
      }
    }
  }

  for (const cand of candidates) {
    const rec = asRecord(cand);
    if (rec) {
      // map 形态:{ skillName: { integrity, version } }
      for (const [name, info] of Object.entries(rec)) {
        const infoRec = asRecord(info);
        bySkill.set(name, {
          integrity: infoRec ? asString(infoRec.integrity) : undefined,
          version: infoRec ? asString(infoRec.version) : undefined,
        });
      }
      continue;
    }
    if (Array.isArray(cand)) {
      // 数组形态:[{ name, integrity, version }]
      for (const item of cand) {
        const itemRec = asRecord(item);
        if (!itemRec) continue;
        const name = asString(itemRec.name);
        if (!name) continue;
        bySkill.set(name, {
          integrity: asString(itemRec.integrity),
          version: asString(itemRec.version),
        });
      }
    }
  }
  return { bySkill };
}

/** 找声明里承载各原语类别的容器:优先 dependencies / primitives,容忍二者并存。 */
function collectPrimitiveContainers(
  root: { [key: string]: YamlValue },
): Array<{ [key: string]: YamlValue }> {
  const containers: Array<{ [key: string]: YamlValue }> = [];
  for (const key of ['dependencies', 'primitives', 'packages']) {
    const rec = asRecord(root[key]);
    if (rec) containers.push(rec);
  }
  return containers;
}

/** 把单条 skill 声明(map 或裸标量)解析成 ApmSkillImport;不安全名返回 undefined 并写 warning。 */
function parseSkillEntry(
  entry: YamlValue,
  sources: { [key: string]: YamlValue } | undefined,
  lock: LockIndex,
  warnings: string[],
): ApmSkillImport | undefined {
  let name: string | undefined;
  let sourceRef: string | undefined;
  let pathField: string | undefined;
  let version: string | undefined;

  if (typeof entry === 'string') {
    name = entry;
  } else {
    const rec = asRecord(entry);
    if (!rec) {
      warnings.push('跳过一条 skill 声明:既不是名字也不是对象。');
      return undefined;
    }
    name = asString(rec.name) ?? asString(rec.id);
    sourceRef = asString(rec.source) ?? asString(rec.from) ?? asString(rec.registry);
    pathField = asString(rec.path) ?? asString(rec.subpath) ?? asString(rec.dir);
    version = asString(rec.version) ?? asString(rec.ref) ?? asString(rec.rev);
  }

  if (!name) {
    warnings.push('跳过一条 skill 声明:缺少 name。');
    return undefined;
  }
  if (!isSafeSkillName(name)) {
    warnings.push(`跳过 skill "${name}":名字未通过安全护栏(可能含路径分隔符 / 控制字符 / 保留名)。`);
    return undefined;
  }

  const resolvedSource = resolveSourceRef(sources, sourceRef);
  const lockInfo = lock.bySkill.get(name);
  const finalVersion = version ?? lockInfo?.version;

  return {
    name,
    ...(resolvedSource !== undefined ? { source: resolvedSource } : {}),
    ...(sourceRef !== undefined ? { sourceRef } : {}),
    ...(pathField !== undefined ? { path: pathField } : {}),
    ...(finalVersion !== undefined ? { version: finalVersion } : {}),
    ...(lockInfo?.integrity !== undefined ? { integrity: lockInfo.integrity } : {}),
  };
}

/**
 * 解析(已 parse 的)apm.yml 文档 + 可选 apm.lock.yaml 文档,产出映射结果。
 * 纯函数,不读写文件、不联网、不执行任何东西。
 */
export function mapApmToImports(apmDoc: YamlValue, lockDoc?: YamlValue): ApmMapping {
  const warnings: string[] = [];
  const skipped: ApmSkippedPrimitive[] = [];
  const skills: ApmSkillImport[] = [];

  const root = asRecord(apmDoc);
  if (!root) {
    throw new InvalidApmYamlError('apm.yml 顶层必须是一个映射(key: value 结构)');
  }

  const sources = asRecord(root.sources);
  const lock = indexLock(lockDoc);

  const containers = collectPrimitiveContainers(root);
  if (containers.length === 0) {
    warnings.push('apm.yml 未发现 dependencies / primitives 段,没有可纳管的原语。');
  }

  const seenSkillNames = new Set<string>();
  const addSkill = (entry: YamlValue): void => {
    const parsed = parseSkillEntry(entry, sources, lock, warnings);
    if (!parsed) return;
    if (seenSkillNames.has(parsed.name)) {
      warnings.push(`重复的 skill "${parsed.name}":只保留首条。`);
      return;
    }
    seenSkillNames.add(parsed.name);
    skills.push(parsed);
  };

  for (const container of containers) {
    for (const [category, value] of Object.entries(container)) {
      if (SKILL_PRIMITIVE_KEYS.has(category)) {
        if (Array.isArray(value)) {
          for (const item of value) addSkill(item);
          continue;
        }
        // 也允许 map 形态:{ skillName: {...} }
        const rec = asRecord(value);
        if (rec) {
          for (const [skillName, info] of Object.entries(rec)) {
            const infoRec = asRecord(info);
            addSkill(infoRec ? { name: skillName, ...infoRec } : skillName);
          }
          continue;
        }
        warnings.push(`原语类别 "${category}" 的值不是序列也不是映射,已忽略。`);
        continue;
      }

      // 非 skill 原语:明确跳过并记录。
      const count = Array.isArray(value)
        ? value.length
        : asRecord(value)
          ? Object.keys(asRecord(value)!).length
          : undefined;
      const known = KNOWN_NON_SKILL_PRIMITIVES.has(category);
      skipped.push({
        category,
        ...(count !== undefined ? { count } : {}),
        reason: known
          ? `非 skill 原语(${category});skill-switch 只纳管 skill 类,做安全 + 治理那一环。`
          : `未知原语类别(${category});保守起见跳过,不纳管。`,
      });
    }
  }

  return { skills, skipped, warnings };
}

export interface MapToDeclarationsOptions {
  /** 把这些 skill 声明到哪些 agent(默认 ['claude-code'])。 */
  agents?: AgentType[];
  /** symlink 还是 copy(默认 copy,跨 agent 复现更稳)。 */
  mode?: 'symlink' | 'copy';
  /**
   * 把 ApmSkillImport 的 source / path 解析成 skill-switch 需要的本地内容目录(绝对路径或相对 home)。
   * 不提供时,source 直接取 import 的 path ?? source ?? "apm:<name>" 占位 —— 因为我们绝不抓取远端,
   * 真正落盘安装由后续 skill-switch add/install 流程在用户明确授权下进行。
   */
  resolveSource?: (skill: ApmSkillImport) => string;
}

/**
 * 把 ApmSkillImport[] 映射为 skill-switch 的 SkillDeclaration[]。
 * 仅做模型映射,不写盘。默认 enabled=false —— 互操作导入的东西默认"已纳管但未启用",
 * 让用户显式启用,符合"治理优先、最小惊讶"的安全姿态。
 */
export function toSkillDeclarations(
  imports: ApmSkillImport[],
  options: MapToDeclarationsOptions = {},
): SkillDeclaration[] {
  const agents =
    options.agents && options.agents.length > 0 ? options.agents : (['claude-code'] as AgentType[]);
  const mode = options.mode ?? 'copy';
  const resolveSource =
    options.resolveSource ??
    ((skill: ApmSkillImport): string => skill.path ?? skill.source ?? `apm:${skill.name}`);

  return imports.map((skill) => ({
    name: skill.name,
    source: resolveSource(skill),
    agents: [...agents],
    enabled: false,
    mode,
  }));
}
