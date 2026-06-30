// 官方 MCP Registry 客户端(C 线)。
//
// 接口:GET https://registry.modelcontextprotocol.io/v0/servers?search=<q>&limit=<n>
//   v0 已冻结、读免鉴权(见 docs/registry-integration-plan.md §1)。
// 响应形状(实测 2026-06):
//   { servers: [ { server: { name, description, version, repository?: {url, source, subfolder?},
//                            packages?: [ {registryType, identifier, version, runtimeHint, ...} ],
//                            remotes?: [...] }, _meta: {...} } ],
//     metadata: { nextCursor?, count } }
//
// 防御式解析:任何字段缺失都不崩,缺 repository/packages 的条目照常归一化(只是 install 时可能无来源)。
// 安全:只读、HTTPS-only(底层 fetchJson 把关),零遥测。不 import node:http(s)/net,不引用模块 URL 元数据(SEA 安全)。
import { type FetchJsonOptions, fetchJson } from './fetch.ts';
import type { RegistryEntry } from './index.ts';

/** 官方 MCP Registry 默认 base。 */
export const MCP_REGISTRY_BASE = 'https://registry.modelcontextprotocol.io';

export interface McpSearchOptions extends FetchJsonOptions {
  /** 覆盖 registry base(测试 / 自托管);仍必须是 https://。 */
  base?: string;
  /** 取多少条(默认 30)。 */
  limit?: number;
}

/** 安全取字符串字段(非字符串 → undefined)。 */
function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/**
 * 把 MCP Registry 的一个 server 条目归一化成 RegistryEntry。
 * 防御式:任何子字段缺失都安全降级,绝不抛。
 */
export function normalizeServer(raw: unknown): RegistryEntry | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  // 兼容两种形状:{ server: {...} } 外层信封,或直接就是 server 对象。
  const outer = raw as Record<string, unknown>;
  const server = (outer.server && typeof outer.server === 'object' ? outer.server : outer) as Record<
    string,
    unknown
  >;

  const name = str(server.name);
  if (!name) return undefined; // 没名字的条目无法引用 → 丢弃

  const description = str(server.description) ?? str(server.title) ?? '';
  const version = str(server.version);

  // repository:取 url + 可选 subfolder。
  const repo = server.repository;
  let repositoryUrl: string | undefined;
  let subdir: string | undefined;
  if (repo && typeof repo === 'object') {
    const r = repo as Record<string, unknown>;
    repositoryUrl = str(r.url);
    subdir = str(r.subfolder);
  }

  // packages:取第一个有 identifier 的 npm 包,作为可选 npm 安装提示(仅当无仓库 URL 时才更有意义)。
  let npmIdentifier: string | undefined;
  let npmVersion: string | undefined;
  const packages = server.packages;
  if (Array.isArray(packages)) {
    for (const p of packages) {
      if (p && typeof p === 'object') {
        const pkg = p as Record<string, unknown>;
        const regType = str(pkg.registryType);
        const ident = str(pkg.identifier);
        if (ident && (regType === 'npm' || regType === undefined)) {
          npmIdentifier = ident;
          npmVersion = str(pkg.version);
          break;
        }
      }
    }
  }

  // 决定落地来源:优先源码仓库(git,可克隆审计);否则退而用 npm 包(经现有 npm 解析→克隆审计)。
  const entry: RegistryEntry = {
    id: name,
    name,
    description,
    source: 'mcp',
    sourceType: repositoryUrl ? 'git' : npmIdentifier ? 'npm' : 'unknown',
    ...(version ? { version } : {}),
  };
  if (repositoryUrl) {
    entry.repositoryUrl = repositoryUrl;
    entry.installHint = repositoryUrl;
    if (subdir) entry.subdir = subdir;
  } else if (npmIdentifier) {
    entry.installHint = npmVersion ? `${npmIdentifier}@${npmVersion}` : npmIdentifier;
  }
  return entry;
}

/**
 * 只读搜索官方 MCP Registry,返回归一化条目。
 * 纯 opt-in:本函数被调用才联网。
 */
export async function searchMcpServers(
  query: string,
  opts: McpSearchOptions = {},
): Promise<RegistryEntry[]> {
  const base = (opts.base ?? MCP_REGISTRY_BASE).replace(/\/+$/, '');
  const url = new URL(`${base}/v0/servers`);
  if (query) url.searchParams.set('search', query);
  url.searchParams.set('limit', String(opts.limit ?? 30));

  const body = await fetchJson<unknown>(url.toString(), opts);

  // 防御式:servers 不是数组就当空。
  const servers =
    body && typeof body === 'object' && Array.isArray((body as { servers?: unknown }).servers)
      ? ((body as { servers: unknown[] }).servers)
      : [];

  const out: RegistryEntry[] = [];
  for (const s of servers) {
    const e = normalizeServer(s);
    if (e) out.push(e);
  }
  return out;
}
