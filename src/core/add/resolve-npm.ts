// add 的 npm 解析层:把 npm 包名 → 它的源码仓库 git 地址。
//
// 只读:对 registry.npmjs.org 发一次 GET 拿包元数据,**绝不安装、绝不执行包**。
// 拿到 repository 地址后,真正的安全把关仍在后续「克隆 → 审计」管线(且 assertSafeGitSource 兜底)。
// 传输:默认 pinnedFetch(连接时 DNS 钉扎);fetchImpl 可注入,便于测试。

import {
  createPinnedFetch,
  pinnedFetch,
  type PinnedFetchInit,
  type PinnedResponse,
} from '../security/pinned-http.ts';
import {
  HostResolutionPolicyError,
  type HostResolver,
} from '../security/url-safety.ts';

const REGISTRY = 'https://registry.npmjs.org';
const FETCH_TIMEOUT_MS = 10_000;
/** 响应体大小上限(字节);与 registry 取数层同量级。 */
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024; // 5 MiB

/**
 * 可注入的 fetch 形状:PinnedResponse 是 Response 的受控子集(无 text()/json())。
 * 测试注入的假 fetch 返回标准 Response(超集)必须继续可用。
 */
export type NpmFetchImpl = (
  url: string,
  init?: PinnedFetchInit,
) => Promise<PinnedResponse | Response>;

/** 响应体读取面:只依赖 headers + body 流(PinnedResponse 无 text()/json())。 */
type ReadableBodyResponse = {
  headers: { get(name: string): string | null };
  body: ReadableStream<Uint8Array> | null;
};

export interface ResolveNpmOptions {
  /** 注入 fetch(测试用);默认 pinnedFetch。 */
  fetchImpl?: NpmFetchImpl;
  /**
   * DNS resolver 注入(测试)。仅在未注入 fetchImpl 时生效:经 createPinnedFetch
   * 构造一次性钉扎实例。
   */
  hostResolver?: HostResolver;
  /** 请求超时(毫秒)。 */
  timeoutMs?: number;
  /** 响应体大小上限(字节)。 */
  maxBytes?: number;
}

export interface NpmResolution {
  /** 规范化后的 git 源(可喂 cloneRepo);解析失败为空。 */
  gitSource?: string;
  /** registry 里原始的 repository 字段值。 */
  repositoryUrl?: string;
  /** 失败原因(网络错误 / 无 repository 字段等)。 */
  error?: string;
}

/** 把 package.json repository.url 的各种写法规范成可克隆的 https git 源。 */
export function normalizeRepoUrl(raw: string): string | undefined {
  let s = raw.trim();
  if (!s) return undefined;

  // github:owner/repo 简写
  const short = /^github:([\w.-]+)\/([\w.-]+)$/.exec(s);
  if (short) return `https://github.com/${short[1]}/${short[2]!.replace(/\.git$/i, '')}.git`;

  s = s.replace(/^git\+/, ''); // git+https://… → https://…
  if (s.startsWith('git://')) s = `https://${s.slice('git://'.length)}`; // git:// → https://

  // git@github.com:owner/repo(.git) → https://github.com/owner/repo.git
  const scp = /^git@([^:]+):(.+?)(\.git)?$/.exec(s);
  if (scp) return `https://${scp[1]}/${scp[2]}.git`;

  if (/^https?:\/\//.test(s)) return s;
  return undefined;
}

/**
 * 解析出本次使用的 fetch 实现:
 *   - 显式 fetchImpl → 原样用(测试 mock)
 *   - 仅 hostResolver → createPinnedFetch 一次性实例(测试 DNS 路径)
 *   - 都无 → 模块级 pinnedFetch(生产)
 */
function resolveFetchImpl(opts: ResolveNpmOptions): NpmFetchImpl {
  if (opts.fetchImpl) return opts.fetchImpl;
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
 * 查询 npm registry,解析一个包名 → 源码仓库 git 地址。
 * 纯只读;不安装、不执行。默认经 pinnedFetch 出站(连接时 DNS 钉扎)。
 *
 * 第二参兼容两种形态:直接传 fetchImpl(历史/测试),或 ResolveNpmOptions。
 */
export async function resolveNpmPackage(
  pkg: string,
  fetchImplOrOpts?: NpmFetchImpl | ResolveNpmOptions,
): Promise<NpmResolution> {
  const opts: ResolveNpmOptions =
    typeof fetchImplOrOpts === 'function'
      ? { fetchImpl: fetchImplOrOpts }
      : (fetchImplOrOpts ?? {});
  const fetchImpl = resolveFetchImpl(opts);
  const timeoutMs = opts.timeoutMs ?? FETCH_TIMEOUT_MS;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;

  // 包名形如 name 或 @scope/name;registry 路径里斜杠保留即可。
  const url = `${REGISTRY}/${pkg}`;
  let body: unknown;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let res: PinnedResponse | Response;
    try {
      res = await fetchImpl(url, {
        signal: ctrl.signal,
        headers: { accept: 'application/json' },
        redirect: 'manual',
        credentials: 'omit',
      });
    } catch (error) {
      if (error instanceof HostResolutionPolicyError) {
        return { error: `查询 npm registry 出错:${error.message}` };
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      return { error: `npm registry 查询失败(${res.status}):找不到包 ${pkg}` };
    }
    const text = await readBodyCapped(res, maxBytes);
    try {
      body = JSON.parse(text) as unknown;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { error: `查询 npm registry 出错:响应 JSON 解析失败:${msg}` };
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { error: `查询 npm registry 出错:${msg}` };
  }

  const meta = body as { repository?: unknown };
  const repo = meta?.repository;
  const repoUrl =
    typeof repo === 'string'
      ? repo
      : repo && typeof repo === 'object' && typeof (repo as { url?: unknown }).url === 'string'
        ? (repo as { url: string }).url
        : undefined;

  if (!repoUrl) {
    return {
      error: `包 ${pkg} 在 npm 上没有声明源码仓库(repository 字段缺失),无法克隆审计。请改贴它的 GitHub 链接。`,
    };
  }
  const gitSource = normalizeRepoUrl(repoUrl);
  if (!gitSource) {
    return { repositoryUrl: repoUrl, error: `无法识别仓库地址:${repoUrl}` };
  }
  return { gitSource, repositoryUrl: repoUrl };
}
