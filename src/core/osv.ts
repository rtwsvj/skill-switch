// osv.ts — OSV.dev CVE 扫描(供应链漂移检测辅助模块)
//
// ⚠ 新网络出口:本模块是项目中唯一主动向外部网络发出请求的模块。
//   设计纪律:
//     1. 严格 opt-in:调用方必须显式传入 fetchFn(或运行时传递的全局 fetch),
//        默认值 undefined 表示"不联网"。
//     2. 在 drift 命令里仅当 --osv 标志出现时才调用本模块;
//        其余所有代码路径不会 import 本模块内的联网逻辑。
//     3. 超时兜底:所有请求强制 10 秒超时(AbortController),避免 CI 挂死。
//     4. 容错降级:网络失败、解析失败均返回空结果 + 诊断信息,不抛出。
//
// 📌 对编排者的说明(是否设默认):
//   当前设计是"默认关闭 / 仅 --osv 触发"。建议维持此默认:
//     - OSV 查询会暴露被扫描项目的依赖名+版本给第三方 API(隐私)
//     - CI 环境对网络连通性不一定有保证(代理、防火墙)
//     - 建议仅在安全审查流程中显式启用(e.g., --osv 或专属 CI step)
//
// 无新依赖:仅使用 Node.js 内置(node:fs/promises、node:path)和全局 fetch。

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

// ─── 公共类型 ──────────────────────────────────────────────────────────────────

/** 单个依赖包版本说明(供 OSV querybatch 格式) */
export interface OsvPackageQuery {
  /** 包名,例如 "lodash" */
  name: string;
  /** 精确版本,例如 "4.17.20" */
  version: string;
  /** 生态系统:npm / PyPI / crates.io 等 */
  ecosystem: string;
}

/** 单条 CVE 命中结果 */
export interface OsvVulnerability {
  /** CVE/GHSA ID,例如 "GHSA-xxxx-yyyy-zzzz" */
  id: string;
  /** 漏洞简介(可能缺失) */
  summary?: string;
  /** 严重程度别名(如 CVSS)*/
  severity?: string;
}

/** 单个包的扫描结果 */
export interface OsvPackageResult {
  pkg: OsvPackageQuery;
  /** 命中的漏洞列表;为空表示无已知 CVE */
  vulns: OsvVulnerability[];
}

/** 整体扫描结果(多个 skill 目录汇总) */
export interface OsvScanResult {
  /** 被扫描的 skill 目录 */
  skillDir: string;
  /** 各包的扫描结果 */
  packages: OsvPackageResult[];
  /** 诊断信息(联网失败、解析失败等) */
  diagnostics: string[];
}

// ─── 依赖文件解析 ──────────────────────────────────────────────────────────────

/**
 * 尝试从 skill 目录中解析依赖声明。
 * 支持:package.json(npm)、requirements.txt(PyPI)、Cargo.toml(crates.io)。
 * 纯本地读文件,无网络。
 */
export async function parseSkillDependencies(skillDir: string): Promise<OsvPackageQuery[]> {
  const result: OsvPackageQuery[] = [];

  // ── package.json (npm) ──
  const pkgJsonPath = join(skillDir, 'package.json');
  try {
    const raw = await readFile(pkgJsonPath, 'utf8');
    const parsed = JSON.parse(raw) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    // 只扫 dependencies(生产依赖);devDependencies 一般不进生产
    const deps = { ...parsed.dependencies };
    for (const [name, versionRaw] of Object.entries(deps)) {
      // 去掉 ^、~、>=、> 等范围符号,取第一个点号分隔版本号段
      const version = versionRaw.replace(/^[^0-9]*/, '').split(' ')[0] ?? '';
      if (name && version) {
        result.push({ name, version, ecosystem: 'npm' });
      }
    }
  } catch {
    // 不存在或解析失败:跳过
  }

  // ── requirements.txt (PyPI) ──
  const reqTxtPath = join(skillDir, 'requirements.txt');
  try {
    const raw = await readFile(reqTxtPath, 'utf8');
    for (const line of raw.split('\n')) {
      // 去掉注释和空行;格式: package==version 或 package>=version 等
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      // 取 == 后的版本(最精确);若无 ==,取 >= 或 ~= 后的版本作近似
      const exactMatch = trimmed.match(/^([A-Za-z0-9_.-]+)==([0-9][A-Za-z0-9._-]*)/);
      if (exactMatch) {
        result.push({ name: exactMatch[1]!, version: exactMatch[2]!, ecosystem: 'PyPI' });
        continue;
      }
      // 宽松匹配:任意比较符后的版本
      const looseMatch = trimmed.match(/^([A-Za-z0-9_.-]+)[>~!<]=?([0-9][A-Za-z0-9._-]*)/);
      if (looseMatch) {
        result.push({ name: looseMatch[1]!, version: looseMatch[2]!, ecosystem: 'PyPI' });
      }
    }
  } catch {
    // 不存在或读取失败:跳过
  }

  // ── Cargo.toml (crates.io) ──
  const cargoPath = join(skillDir, 'Cargo.toml');
  try {
    const raw = await readFile(cargoPath, 'utf8');
    // 极简 TOML 解析:只匹配 [dependencies] 节内的 name = "version" 形式
    // 不引入 TOML 解析库;Cargo.toml 的简单形式已足够 skill 使用场景
    let inDeps = false;
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (trimmed === '[dependencies]') { inDeps = true; continue; }
      if (trimmed.startsWith('[') && trimmed !== '[dependencies]') { inDeps = false; continue; }
      if (!inDeps) continue;
      if (trimmed.startsWith('#') || !trimmed) continue;
      // 格式: name = "version" 或 name = { version = "1.0" }
      const simpleMatch = trimmed.match(/^([A-Za-z0-9_-]+)\s*=\s*"([0-9][A-Za-z0-9._-]*)"/);
      if (simpleMatch) {
        result.push({ name: simpleMatch[1]!, version: simpleMatch[2]!, ecosystem: 'crates.io' });
        continue;
      }
      const tableMatch = trimmed.match(/^([A-Za-z0-9_-]+)\s*=\s*\{[^}]*version\s*=\s*"([0-9][A-Za-z0-9._-]*)"/);
      if (tableMatch) {
        result.push({ name: tableMatch[1]!, version: tableMatch[2]!, ecosystem: 'crates.io' });
      }
    }
  } catch {
    // 不存在或读取失败:跳过
  }

  return result;
}

// ─── OSV querybatch API ────────────────────────────────────────────────────────

// OSV.dev batch 查询端点(无认证,公开 API)
const OSV_QUERYBATCH_URL = 'https://api.osv.dev/v1/querybatch';

/** OSV querybatch 请求格式 */
interface OsvQueryBatchRequest {
  queries: Array<{
    version: string;
    package: { name: string; ecosystem: string };
  }>;
}

/** OSV querybatch 响应格式(节选,只取必要字段) */
interface OsvQueryBatchResponse {
  results: Array<{
    vulns?: Array<{
      id: string;
      summary?: string;
      severity?: Array<{ score?: string; type?: string }>;
    }>;
  }>;
}

/** fetch 函数类型(方便测试注入假 fetch) */
export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * 向 OSV.dev 发起 querybatch 请求,返回各包的漏洞命中情况。
 *
 * ⚠ 网络出口:仅当调用方显式传入 fetchFn 时才发起请求。
 *   在 drift 命令中仅当 --osv 标志出现时才传入全局 fetch。
 *   不传 fetchFn 时本函数抛出(不隐式联网)。
 *
 * @param packages 要查询的包列表
 * @param fetchFn  必须显式传入:全局 fetch 或测试用假 fetch
 * @param timeoutMs 请求超时毫秒数(默认 10000)
 */
export async function queryOsvBatch(
  packages: OsvPackageQuery[],
  fetchFn: FetchFn,
  timeoutMs = 10_000,
): Promise<OsvPackageResult[]> {
  if (packages.length === 0) return [];

  // 构造 querybatch 请求体
  const body: OsvQueryBatchRequest = {
    queries: packages.map((p) => ({
      version: p.version,
      package: { name: p.name, ecosystem: p.ecosystem },
    })),
  };

  // AbortController 实现超时兜底(避免 CI 挂死)
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let data: OsvQueryBatchResponse;
  try {
    const response = await fetchFn(OSV_QUERYBATCH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal as RequestInit['signal'],
    });
    clearTimeout(timer);

    if (!response.ok) {
      throw new Error(`OSV API 返回 HTTP ${response.status}`);
    }
    data = (await response.json()) as OsvQueryBatchResponse;
  } catch (err) {
    clearTimeout(timer);
    const msg = err instanceof Error ? err.message : String(err);
    // 超时或网络错误:抛出让上层捕获并记录 diagnostics
    throw new Error(`OSV querybatch 请求失败: ${msg}`);
  }

  // 将 API 结果与输入包列表对应(按顺序一一对应)
  const results: OsvPackageResult[] = [];
  const rawResults = data.results ?? [];
  for (let i = 0; i < packages.length; i++) {
    const pkg = packages[i]!;
    const raw = rawResults[i];
    const vulns: OsvVulnerability[] = (raw?.vulns ?? []).map((v) => ({
      id: v.id,
      summary: v.summary,
      // 取第一个 severity score(如有)
      severity: v.severity?.[0]?.score,
    }));
    results.push({ pkg, vulns });
  }
  return results;
}

// ─── 高阶入口:扫描 skill 目录 ────────────────────────────────────────────────

/**
 * 扫描单个 skill 目录的供应链 CVE。
 *
 * 全流程:解析依赖 → querybatch → 汇总结果。
 * 网络故障会被捕获并记录到 diagnostics,不抛出,允许调用方降级处理。
 *
 * @param skillDir  skill 安装产物目录路径
 * @param fetchFn   显式传入 fetch(在 --osv 路径中传入全局 fetch)
 * @param timeoutMs 网络请求超时(默认 10s)
 */
export async function scanSkillOsv(
  skillDir: string,
  fetchFn: FetchFn,
  timeoutMs = 10_000,
): Promise<OsvScanResult> {
  const diagnostics: string[] = [];

  // 解析本地依赖(纯读文件,无网络)
  const packages = await parseSkillDependencies(skillDir);
  if (packages.length === 0) {
    return { skillDir, packages: [], diagnostics: ['未找到依赖声明文件(跳过 OSV 扫描)'] };
  }

  // querybatch(网络出口)
  let packageResults: OsvPackageResult[] = [];
  try {
    packageResults = await queryOsvBatch(packages, fetchFn, timeoutMs);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    diagnostics.push(`OSV 扫描失败(已跳过): ${msg}`);
    // 降级:返回空结果 + 诊断
    packageResults = packages.map((pkg) => ({ pkg, vulns: [] }));
  }

  return { skillDir, packages: packageResults, diagnostics };
}

// ─── 格式化输出辅助 ──────────────────────────────────────────────────────────

/**
 * 将 OSV 扫描结果格式化为人类可读的摘要行列表。
 * 供 drift 命令直接 console.log 打印。
 */
export function formatOsvResults(results: OsvScanResult[]): string[] {
  const lines: string[] = [];
  for (const result of results) {
    const skillName = result.skillDir.split('/').at(-1) ?? result.skillDir;
    const vulnPackages = result.packages.filter((p) => p.vulns.length > 0);

    if (result.diagnostics.length > 0) {
      for (const diag of result.diagnostics) {
        lines.push(`[OSV] ${skillName}: ${diag}`);
      }
    }

    if (vulnPackages.length === 0) {
      if (result.packages.length > 0) {
        lines.push(`[OSV] ${skillName}: 扫描 ${result.packages.length} 个依赖,无已知 CVE`);
      }
    } else {
      for (const pr of vulnPackages) {
        const ids = pr.vulns.map((v) => v.id).join(', ');
        lines.push(
          `[OSV] ${skillName}: ${pr.pkg.name}@${pr.pkg.version} 命中 ${pr.vulns.length} 个 CVE: ${ids}`,
        );
      }
    }
  }
  return lines;
}
