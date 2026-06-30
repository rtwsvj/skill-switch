// Claude Code marketplace.json 客户端(C 线)。
//
// 标准:GitHub 仓库根下的 `.claude-plugin/marketplace.json`(如 anthropics/skills)。
//   用户给 --marketplace <owner/repo>,从
//   https://raw.githubusercontent.com/<owner>/<repo>/HEAD/.claude-plugin/marketplace.json 拉取。
// 实测形状(2026-06):
//   { name, owner: {name,email}, metadata: {description,version},
//     plugins: [ { name, description, source, strict?, skills?: ["./skills/foo", ...] } ] }
//   source 多为 "./"(指该仓库自身),也可能是外部 owner/repo 或 git URL。
//
// 归一化:每个 plugin 一条 RegistryEntry;若 plugin 列了多个 skills,额外为每个 skill 子目录派生条目,
//   便于用户精确装某个 skill。防御式解析:缺字段不崩。
// 安全:只读、HTTPS-only(底层 fetchJson 把关),零遥测。不 import node:http(s)/net,不引用模块 URL 元数据(SEA 安全)。
import { type FetchJsonOptions, fetchJson } from './fetch.ts';
import type { RegistryEntry } from './index.ts';

/** raw.githubusercontent 基址。 */
const RAW_BASE = 'https://raw.githubusercontent.com';

export interface MarketplaceOptions extends FetchJsonOptions {
  /** 覆盖 raw 基址(测试 / 镜像);仍必须 https://。 */
  rawBase?: string;
  /** 覆盖默认引用(HEAD)。 */
  ref?: string;
}

/** 校验 owner/repo 形态,防路径穿越 / 注入。 */
export function parseOwnerRepo(spec: string): { owner: string; repo: string } | undefined {
  const m = /^([\w.-]+)\/([\w.-]+)$/.exec(spec.trim());
  if (!m) return undefined;
  const owner = m[1]!;
  const repo = m[2]!.replace(/\.git$/i, '');
  // 拒绝 . / .. 这类异常段。
  if (owner === '.' || owner === '..' || repo === '.' || repo === '..') return undefined;
  return { owner, repo };
}

/** 构造 marketplace.json 的 raw URL。 */
export function marketplaceUrl(owner: string, repo: string, ref = 'HEAD', rawBase = RAW_BASE): string {
  return `${rawBase.replace(/\/+$/, '')}/${owner}/${repo}/${ref}/.claude-plugin/marketplace.json`;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/** 把 plugin.source 解析成可安装的来源串(GitHub URL)。 */
function resolvePluginSource(source: string | undefined, fallbackRepo: string): string {
  // "./" 或空 / "." → 指 marketplace 仓库自身。
  if (!source || source === '.' || source === './' || source === '') {
    return `https://github.com/${fallbackRepo}.git`;
  }
  // 已是 URL / git@ → 原样(install 的解析层再校验)。
  if (/^https?:\/\//.test(source) || /^git@/.test(source) || /^git:\/\//.test(source)) {
    return source;
  }
  // owner/repo 简写。
  const or = parseOwnerRepo(source);
  if (or) return `https://github.com/${or.owner}/${or.repo}.git`;
  // 其它形态(本地相对路径等)无法远程克隆 → 退回仓库自身。
  return `https://github.com/${fallbackRepo}.git`;
}

/** 从 "./skills/foo" 这类 skill 路径里取出子目录(去前导 ./ 与首尾斜杠)。 */
function normalizeSkillPath(p: string): string | undefined {
  const cleaned = p.trim().replace(/^\.?\/+/, '').replace(/\/+$/, '');
  if (!cleaned || cleaned.includes('..')) return undefined; // 防穿越
  return cleaned;
}

/**
 * 把一个 plugin 条目归一化成一条(或多条,按 skills 拆)RegistryEntry。
 * 防御式:任何字段缺失都安全降级。
 */
export function normalizePlugin(raw: unknown, marketplaceRepo: string): RegistryEntry[] {
  if (!raw || typeof raw !== 'object') return [];
  const p = raw as Record<string, unknown>;
  const name = str(p.name);
  if (!name) return [];
  const description = str(p.description) ?? '';
  const version = str(p.version);
  const installSource = resolvePluginSource(str(p.source), marketplaceRepo);

  const base: RegistryEntry = {
    id: name,
    name,
    description,
    source: 'marketplace',
    sourceType: 'git',
    repositoryUrl: installSource,
    installHint: installSource,
    marketplaceRepo,
    ...(version ? { version } : {}),
  };

  const skills = p.skills;
  if (!Array.isArray(skills) || skills.length === 0) {
    return [base];
  }

  // plugin 列了具体 skill 子目录:派生「<plugin>/<skill>」精确条目,同时保留 plugin 总条目。
  const out: RegistryEntry[] = [base];
  for (const sp of skills) {
    if (typeof sp !== 'string') continue;
    const subdir = normalizeSkillPath(sp);
    if (!subdir) continue;
    const skillName = subdir.split('/').pop() ?? subdir;
    out.push({
      id: `${name}/${skillName}`,
      name: skillName,
      description: description ? `${description}(skill: ${skillName})` : `skill: ${skillName}`,
      source: 'marketplace',
      sourceType: 'git',
      repositoryUrl: installSource,
      installHint: installSource,
      subdir,
      marketplaceRepo,
      ...(version ? { version } : {}),
    });
  }
  return out;
}

/** 把整个 marketplace.json 文档归一化成条目列表。防御式:顶层非对象 / plugins 非数组 → 空。 */
export function normalizeMarketplaceDoc(doc: unknown, marketplaceRepo: string): RegistryEntry[] {
  if (!doc || typeof doc !== 'object') return [];
  const plugins = (doc as { plugins?: unknown }).plugins;
  if (!Array.isArray(plugins)) return [];
  const out: RegistryEntry[] = [];
  for (const pl of plugins) out.push(...normalizePlugin(pl, marketplaceRepo));
  return out;
}

/** 匹配查询:名称 / 描述 / id 含 query(忽略大小写);空 query 返回全部。 */
function matchesQuery(e: RegistryEntry, query: string): boolean {
  if (!query) return true;
  const q = query.toLowerCase();
  return (
    e.id.toLowerCase().includes(q) ||
    e.name.toLowerCase().includes(q) ||
    e.description.toLowerCase().includes(q)
  );
}

/**
 * 拉取并搜索某个 GitHub 仓库的 marketplace.json,返回匹配的归一化条目。
 * 纯 opt-in:本函数被调用才联网。
 */
export async function searchMarketplace(
  repoSpec: string,
  query: string,
  opts: MarketplaceOptions = {},
): Promise<RegistryEntry[]> {
  const or = parseOwnerRepo(repoSpec);
  if (!or) {
    throw new Error(`marketplace 仓库格式应为 owner/repo:${repoSpec}`);
  }
  const url = marketplaceUrl(or.owner, or.repo, opts.ref ?? 'HEAD', opts.rawBase ?? RAW_BASE);
  const doc = await fetchJson<unknown>(url, opts);
  const all = normalizeMarketplaceDoc(doc, `${or.owner}/${or.repo}`);
  return all.filter((e) => matchesQuery(e, query));
}
