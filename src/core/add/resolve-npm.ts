// add 的 npm 解析层:把 npm 包名 → 它的源码仓库 git 地址。
//
// 只读:对 registry.npmjs.org 发一次 GET 拿包元数据,**绝不安装、绝不执行包**。
// 拿到 repository 地址后,真正的安全把关仍在后续「克隆 → 审计」管线(且 assertSafeGitSource 兜底)。
// fetchImpl 可注入,便于测试。

const REGISTRY = 'https://registry.npmjs.org';
const FETCH_TIMEOUT_MS = 10_000;

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
 * 查询 npm registry,解析一个包名 → 源码仓库 git 地址。
 * 纯只读;不安装、不执行。
 */
export async function resolveNpmPackage(
  pkg: string,
  fetchImpl: typeof fetch = fetch,
): Promise<NpmResolution> {
  // 包名形如 name 或 @scope/name;registry 路径里斜杠保留即可。
  const url = `${REGISTRY}/${pkg}`;
  let body: unknown;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetchImpl(url, { signal: ctrl.signal, headers: { accept: 'application/json' } });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      return { error: `npm registry 查询失败(${res.status}):找不到包 ${pkg}` };
    }
    body = await res.json();
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
