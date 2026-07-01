// SkillsMP 客户端(C 线,opt-in + 用户自带 token)。
//
// 接口:GET https://skillsmp.com/api/v1/skills/search?q=<q>&limit=<n>
//   与 MCP Registry / marketplace 两源不同,SkillsMP **需要 Bearer token 鉴权**
//   (见 https://skillsmp.com/docs/api)。因此它是**严格 opt-in、用户自带 token** 的源:
//     - token 只来自用户设置的环境变量 SKILLSMP_TOKEN(skill-switch 绝不存储 / 写日志 / 内置);
//     - token 只经 fetch.ts 的 bearerToken 附加进请求头,只发往 skillsmp.com(HTTPS);
//     - 未设 token 时该源被跳过(见 index.ts searchRegistries),不影响其它源。
//
// 响应形状未公开文档化(docs 页对匿名 UA 返回 403),故**最大限度防御式解析**:
// 在多种可能的容器键 / 字段名里找条目与 GitHub 来源,缺字段一律安全降级,绝不抛。
// 安全:只读、HTTPS-only(底层 fetchJson 把关)。不 import node:http(s)/net,不引用模块 URL 元数据(SEA 安全)。
import { type FetchJsonOptions, fetchJson } from './fetch.ts';
import type { RegistryEntry } from './index.ts';

/** SkillsMP 默认 base。 */
export const SKILLSMP_BASE = 'https://skillsmp.com';
/** 用户自带 token 的环境变量名。 */
export const SKILLSMP_TOKEN_ENV = 'SKILLSMP_TOKEN';

export interface SkillsMpSearchOptions extends FetchJsonOptions {
  /** 覆盖 base(测试);仍必须 https://。 */
  base?: string;
  /** 取多少条(默认 30)。 */
  limit?: number;
}

/**
 * 解析 SkillsMP token:优先显式传入,否则读环境变量 SKILLSMP_TOKEN。
 * 返回去空白后的非空 token,或 undefined(未配置)。绝不打印 / 存储。
 */
export function resolveSkillsmpToken(explicit?: string): string | undefined {
  const t = explicit ?? process.env[SKILLSMP_TOKEN_ENV];
  return typeof t === 'string' && t.trim().length > 0 ? t.trim() : undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/** 在对象里按一组候选键找第一个非空字符串。 */
function pick(obj: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) {
    const s = str(obj[k]);
    if (s) return s;
  }
  return undefined;
}

/** 是否像一个可克隆审计的 GitHub / git 仓库 URL。 */
function looksLikeRepoUrl(u: string): boolean {
  return /^https?:\/\/(www\.)?github\.com\/[^/]+\/[^/]+/i.test(u) || /\.git($|[?#])/i.test(u);
}

/**
 * 把 SkillsMP 的一个 skill 条目归一化成 RegistryEntry。
 * 防御式:字段名未知,遍历多种可能;拿不到名字则丢弃,拿不到仓库则 sourceType=unknown。
 */
export function normalizeSkill(raw: unknown): RegistryEntry | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const o = raw as Record<string, unknown>;

  const name = pick(o, ['name', 'title', 'slug', 'id', 'skillName']);
  if (!name) return undefined;

  const description = pick(o, ['description', 'summary', 'excerpt', 'about']) ?? '';
  const version = pick(o, ['version', 'ref', 'rev']);

  // 仓库 URL:直接字段,或嵌套 repository/source 对象里的 url。
  let repositoryUrl = pick(o, [
    'repositoryUrl',
    'repository_url',
    'repoUrl',
    'repo_url',
    'githubUrl',
    'github_url',
    'github',
    'sourceUrl',
    'source_url',
  ]);
  const nestedRepo = o.repository ?? o.source ?? o.repo;
  if (!repositoryUrl && nestedRepo && typeof nestedRepo === 'object') {
    repositoryUrl = pick(nestedRepo as Record<string, unknown>, ['url', 'html_url', 'git_url', 'href']);
  }
  // 有些源把裸 url 放在通用 url 字段——仅当它像仓库地址才采信(避免把详情页 URL 当来源)。
  if (!repositoryUrl) {
    const generic = pick(o, ['url', 'link', 'href']);
    if (generic && looksLikeRepoUrl(generic)) repositoryUrl = generic;
  }

  const subdir = pick(o, ['subdir', 'subpath', 'path', 'dir', 'subfolder']);

  const entry: RegistryEntry = {
    id: name,
    name,
    description,
    source: 'skillsmp',
    sourceType: repositoryUrl ? 'git' : 'unknown',
    ...(version ? { version } : {}),
  };
  if (repositoryUrl) {
    entry.repositoryUrl = repositoryUrl;
    entry.installHint = repositoryUrl;
    if (subdir) entry.subdir = subdir;
  }
  return entry;
}

/** 从响应体里找条目数组(防御式:尝试多种容器键)。 */
function extractItems(body: unknown): unknown[] {
  if (Array.isArray(body)) return body;
  if (body && typeof body === 'object') {
    const o = body as Record<string, unknown>;
    for (const key of ['skills', 'data', 'results', 'items', 'hits', 'entries']) {
      if (Array.isArray(o[key])) return o[key] as unknown[];
    }
    // 有些 API 包一层 data.{skills|results}
    const data = o.data;
    if (data && typeof data === 'object') {
      const d = data as Record<string, unknown>;
      for (const key of ['skills', 'results', 'items']) {
        if (Array.isArray(d[key])) return d[key] as unknown[];
      }
    }
  }
  return [];
}

/**
 * 只读搜索 SkillsMP,返回归一化条目。纯 opt-in:本函数被调用才联网。
 * token 必传(由 index.ts 从环境变量解析后传入),经 fetch.ts bearerToken 只发往 skillsmp.com。
 */
export async function searchSkillsMp(
  query: string,
  token: string,
  opts: SkillsMpSearchOptions = {},
): Promise<RegistryEntry[]> {
  const base = (opts.base ?? SKILLSMP_BASE).replace(/\/+$/, '');
  const url = new URL(`${base}/api/v1/skills/search`);
  if (query) url.searchParams.set('q', query);
  url.searchParams.set('limit', String(opts.limit ?? 30));

  const body = await fetchJson<unknown>(url.toString(), { ...opts, bearerToken: token });

  const out: RegistryEntry[] = [];
  for (const item of extractItems(body)) {
    const e = normalizeSkill(item);
    if (e) out.push(e);
  }
  return out;
}
