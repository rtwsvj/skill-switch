// Registry 归一化类型 + 聚合搜索(C 线)。
//
// 两源(MCP Registry / marketplace.json)各自归一化成统一的 RegistryEntry,
// searchRegistries 聚合两源结果。纯 opt-in:只有显式调用才联网(底层 fetchJson 把关)。
//
// 安全:本文件不直接联网,只编排 mcp-registry / marketplace 两个客户端;
// 不 import node:http(s)/net;不引用模块 URL 元数据(SEA 安全)。
import { type FetchJsonOptions, RegistryFetchError } from './fetch.ts';
import { searchMarketplace } from './marketplace.ts';
import { searchMcpServers } from './mcp-registry.ts';
import { resolveSkillsmpToken, searchSkillsMp } from './skillsmp.ts';

/** 归一化的注册表条目来源。 */
export type RegistrySource = 'mcp' | 'marketplace' | 'skillsmp';

/** 条目落地安装时,来源指向的是 git 仓库还是 npm 包。 */
export type RegistrySourceType = 'git' | 'npm' | 'unknown';

/**
 * 归一化的注册表条目(两源统一形状)。
 * 纯数据,绝不含可执行内容;install 时仍走现有"克隆→审计→安装"管线再次把关。
 */
export interface RegistryEntry {
  /** 稳定 id(供 `registry install <id>` 选取):MCP 用 server name;marketplace 用 plugin/skill 名。 */
  id: string;
  /** 展示名。 */
  name: string;
  /** 描述(可空)。 */
  description: string;
  /** 来源注册表。 */
  source: RegistrySource;
  /** 源码仓库 URL(可空;install 时若无则无法克隆审计)。 */
  repositoryUrl?: string;
  /** 落地来源类型(git / npm / unknown)。 */
  sourceType: RegistrySourceType;
  /** 安装时可直接喂解析层的原始来源串(GitHub URL / npm 包规格);可空。 */
  installHint?: string;
  /** 仓库内子目录(若条目指向某个子目录里的 skill)。 */
  subdir?: string;
  /** 版本(若源提供)。 */
  version?: string;
  /** marketplace 条目所属仓库 owner/repo(便于 install 复查)。 */
  marketplaceRepo?: string;
}

export interface SearchOptions extends FetchJsonOptions {
  /** 只查某一源;缺省查所有可用源(marketplace 需配 marketplaceRepo;skillsmp 需 token)。 */
  source?: RegistrySource;
  /** marketplace 源要拉的 GitHub 仓库,形如 owner/repo。 */
  marketplaceRepo?: string;
  /**
   * SkillsMP token(可选;缺省读环境变量 SKILLSMP_TOKEN)。skill-switch 绝不存储此值;
   * 仅经 fetch.ts bearerToken 只发往 skillsmp.com。未配置则 skillsmp 源被跳过。
   */
  skillsmpToken?: string;
}

/** 单源搜索的结果(成功条目 + 跳过/出错说明)。 */
export interface SourceResult {
  source: RegistrySource;
  entries: RegistryEntry[];
  /** 该源被跳过的原因(如 marketplace 未给仓库);跳过时 entries 为空。 */
  skipped?: string;
  /** 该源出错的原因(网络 / 解析);出错时 entries 为空。 */
  error?: string;
}

export interface SearchResult {
  /** 两源合并、去重后的条目。 */
  entries: RegistryEntry[];
  /** 每个被查询源的明细(便于 UX 提示哪源跳过 / 出错)。 */
  perSource: SourceResult[];
}

/** 简单稳定去重键:同 source + id 视为同一条目。 */
function entryKey(e: RegistryEntry): string {
  return `${e.source}::${e.id}`;
}

/**
 * 聚合搜索两源。纯 opt-in:本函数被调用才联网。
 *
 * - source 指定时只查该源;否则两源都查。
 * - marketplace 源需要 marketplaceRepo(owner/repo);未给则跳过并在 perSource 标注(不报错)。
 * - 任一源出错不影响另一源:错误装进该源的 perSource.error,整体仍返回成功条目。
 */
export async function searchRegistries(
  query: string,
  opts: SearchOptions = {},
): Promise<SearchResult> {
  const wantMcp = !opts.source || opts.source === 'mcp';
  const wantMarketplace = !opts.source || opts.source === 'marketplace';
  const wantSkillsmp = !opts.source || opts.source === 'skillsmp';
  const perSource: SourceResult[] = [];

  if (wantMcp) {
    try {
      const entries = await searchMcpServers(query, opts);
      perSource.push({ source: 'mcp', entries });
    } catch (e) {
      perSource.push({ source: 'mcp', entries: [], error: describeError(e) });
    }
  }

  if (wantMarketplace) {
    if (!opts.marketplaceRepo) {
      perSource.push({
        source: 'marketplace',
        entries: [],
        skipped: '未指定 marketplace 仓库(加 --marketplace <owner/repo> 才会查市场清单)。',
      });
    } else {
      try {
        const entries = await searchMarketplace(opts.marketplaceRepo, query, opts);
        perSource.push({ source: 'marketplace', entries });
      } catch (e) {
        perSource.push({ source: 'marketplace', entries: [], error: describeError(e) });
      }
    }
  }

  if (wantSkillsmp) {
    const token = resolveSkillsmpToken(opts.skillsmpToken);
    if (!token) {
      perSource.push({
        source: 'skillsmp',
        entries: [],
        skipped:
          'SkillsMP 需鉴权:设置环境变量 SKILLSMP_TOKEN(在 skillsmp.com 申请)后才会查此源。token 只发往 skillsmp.com,skill-switch 不存储。',
      });
    } else {
      try {
        const entries = await searchSkillsMp(query, token, opts);
        perSource.push({ source: 'skillsmp', entries });
      } catch (e) {
        perSource.push({ source: 'skillsmp', entries: [], error: describeError(e) });
      }
    }
  }

  // 合并 + 去重(保序:先 mcp,后 marketplace,后 skillsmp)。
  const seen = new Set<string>();
  const entries: RegistryEntry[] = [];
  for (const sr of perSource) {
    for (const e of sr.entries) {
      const k = entryKey(e);
      if (seen.has(k)) continue;
      seen.add(k);
      entries.push(e);
    }
  }

  return { entries, perSource };
}

/** 在已搜出的条目里按 id 精确取一条(install 用)。 */
export function findEntryById(entries: RegistryEntry[], id: string): RegistryEntry | undefined {
  return entries.find((e) => e.id === id);
}

function describeError(e: unknown): string {
  if (e instanceof RegistryFetchError) return e.message;
  return e instanceof Error ? e.message : String(e);
}

export { RegistryFetchError } from './fetch.ts';
