// osv.ts — OSV.dev CVE 扫描(供应链漂移检测辅助模块)
//
// ⚠ 网络出口:本模块在被调用时向 OSV.dev 发起 POST querybatch。
//   设计纪律:
//     1. 严格 opt-in:仅 drift 命令在 --osv 标志出现时才动态 import 并调用;
//        其余所有代码路径不会加载本模块的联网逻辑。
//     2. 传输默认 pinnedFetch(连接时 DNS 钉扎);POST 为非幂等,pinned-http
//        只试第一个已验证地址(单地址不重放),属有意语义。
//     3. fetchFn 可注入(测试 mock);不传则走模块级 pinnedFetch。
//     4. 超时兜底:所有请求强制 10 秒超时(AbortController),避免 CI 挂死。
//     5. 容错降级:网络失败、解析失败均返回空结果 + 诊断信息,不抛出
//        (scanSkillOsv);queryOsvBatch 自身抛出由上层捕获。
//
// 📌 对编排者的说明(是否设默认):
//   当前设计是"默认关闭 / 仅 --osv 触发"。建议维持此默认:
//     - OSV 查询会暴露被扫描项目的依赖名+版本给第三方 API(隐私)
//     - CI 环境对网络连通性不一定有保证(代理、防火墙)
//     - 建议仅在安全审查流程中显式启用(e.g., --osv 或专属 CI step)
//
// 无新依赖:仅使用 Node.js 内置与 pinned-http。

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  createPinnedFetch,
  pinnedFetch,
  type PinnedFetchInit,
  type PinnedResponse,
} from './security/pinned-http.ts';
import {
  HostResolutionPolicyError,
  type HostResolver,
} from './security/url-safety.ts';

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

/**
 * 可注入的 fetch 形状:PinnedResponse 是 Response 的受控子集(无 text()/json())。
 * 测试注入的假 fetch 返回标准 Response(超集)必须继续可用。
 */
export type FetchFn = (
  url: string,
  init?: PinnedFetchInit,
) => Promise<PinnedResponse | Response>;

export interface OsvFetchOptions {
  /** 注入 fetch(测试用);默认 pinnedFetch。 */
  fetchFn?: FetchFn;
  /**
   * DNS resolver 注入(测试)。仅在未注入 fetchFn 时生效:经 createPinnedFetch
   * 构造一次性钉扎实例。
   */
  hostResolver?: HostResolver;
}

/** 响应体读取面:只依赖 headers + body 流(PinnedResponse 无 text()/json())。 */
type ReadableBodyResponse = {
  headers: { get(name: string): string | null };
  body: ReadableStream<Uint8Array> | null;
};

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
/** 响应体大小上限(字节);与 registry 取数层同量级。 */
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024; // 5 MiB

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

/**
 * 解析出本次使用的 fetch 实现:
 *   - 显式 fetchFn → 原样用(测试 mock)
 *   - 仅 hostResolver → createPinnedFetch 一次性实例
 *   - 都无 → 模块级 pinnedFetch(生产)
 */
function resolveFetchImpl(opts: OsvFetchOptions): FetchFn {
  if (opts.fetchFn) return opts.fetchFn;
  if (opts.hostResolver) return createPinnedFetch({ resolver: opts.hostResolver });
  return pinnedFetch;
}

/**
 * 读响应体但设字节上限:一律经 body 流累加(超限立刻中止)。
 * PinnedResponse 无 text()/json(),且无上限整体读取是 DoS 面。
 */
async function readBodyCapped(
  res: ReadableBodyResponse,
  maxBytes: number,
): Promise<string> {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new Error(`响应体过大(声明 ${declared} > 上限 ${maxBytes} 字节)`);
  }

  const body = res.body;
  if (!body || typeof body.getReader !== 'function') {
    return '';
  }

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let received = 0;
  let out = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        received += value.byteLength;
        if (received > maxBytes) {
          await reader.cancel().catch(() => {});
          throw new Error(`响应体超过上限 ${maxBytes} 字节,已中止`);
        }
        out += decoder.decode(value, { stream: true });
      }
    }
    out += decoder.decode();
    return out;
  } finally {
    reader.releaseLock?.();
  }
}

/**
 * 向 OSV.dev 发起 querybatch 请求,返回各包的漏洞命中情况。
 *
 * ⚠ 网络出口:默认经 pinnedFetch 出站(连接时 DNS 钉扎)。
 *   在 drift 命令中仅当 --osv 标志出现时才调用本函数。
 *   POST 为非幂等:pinned-http 只试第一个已验证地址(不重放),属有意语义;
 *   结果聚合按请求顺序一一对应,不依赖地址级重试。
 *
 * @param packages 要查询的包列表
 * @param fetchFnOrOpts  注入 fetch,或 {fetchFn, hostResolver};默认 pinnedFetch
 * @param timeoutMs 请求超时毫秒数(默认 10000)
 */
export async function queryOsvBatch(
  packages: OsvPackageQuery[],
  fetchFnOrOpts?: FetchFn | OsvFetchOptions,
  timeoutMs = 10_000,
): Promise<OsvPackageResult[]> {
  if (packages.length === 0) return [];

  const opts: OsvFetchOptions =
    typeof fetchFnOrOpts === 'function'
      ? { fetchFn: fetchFnOrOpts }
      : (fetchFnOrOpts ?? {});
  const fetchFn = resolveFetchImpl(opts);

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
    let response: PinnedResponse | Response;
    try {
      response = await fetchFn(OSV_QUERYBATCH_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
        redirect: 'manual',
        credentials: 'omit',
      });
    } catch (error) {
      if (error instanceof HostResolutionPolicyError) {
        throw new Error(`OSV querybatch 请求失败: ${error.message}`);
      }
      throw error;
    }
    clearTimeout(timer);

    if (!response.ok) {
      throw new Error(`OSV API 返回 HTTP ${response.status}`);
    }
    const text = await readBodyCapped(response, DEFAULT_MAX_BYTES);
    try {
      data = JSON.parse(text) as OsvQueryBatchResponse;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(`OSV querybatch 响应 JSON 解析失败: ${msg}`);
    }
  } catch (err) {
    clearTimeout(timer);
    const msg = err instanceof Error ? err.message : String(err);
    // 超时或网络错误:抛出让上层捕获并记录 diagnostics
    // 若已是我们包装过的消息则不再套一层
    if (msg.startsWith('OSV ')) throw err instanceof Error ? err : new Error(msg);
    throw new Error(`OSV querybatch 请求失败: ${msg}`);
  }

  // 将 API 结果与输入包列表对应(按顺序一一对应;不依赖地址级重试/重放)
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
 * @param fetchFnOrOpts 注入 fetch 或选项;默认 pinnedFetch
 * @param timeoutMs 网络请求超时(默认 10s)
 */
export async function scanSkillOsv(
  skillDir: string,
  fetchFnOrOpts?: FetchFn | OsvFetchOptions,
  timeoutMs = 10_000,
): Promise<OsvScanResult> {
  const diagnostics: string[] = [];

  // 解析本地依赖(纯读文件,无网络)
  const packages = await parseSkillDependencies(skillDir);
  if (packages.length === 0) {
    return { skillDir, packages: [], diagnostics: ['未找到依赖声明文件(跳过 OSV 扫描)'] };
  }

  // querybatch(网络出口,默认 pinned-http)
  let packageResults: OsvPackageResult[] = [];
  try {
    packageResults = await queryOsvBatch(packages, fetchFnOrOpts, timeoutMs);
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
