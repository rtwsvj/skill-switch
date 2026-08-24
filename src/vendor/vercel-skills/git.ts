// [skill-switch 本地改动] 上游为 `import simpleGit from 'simple-git'`(默认导入)。
// 在 NodeNext + esModuleInterop 下 tsc 不认 CJS 默认导出可调用,改用等价的具名导出。见 UPSTREAM.md。
import { simpleGit } from 'simple-git';
import { join, normalize, resolve, sep } from 'path';
import { mkdtemp, mkdir, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';

const DEFAULT_CLONE_TIMEOUT_MS = 300_000; // 5 minutes
const CLONE_TIMEOUT_MS = (() => {
  const raw = process.env.SKILLS_CLONE_TIMEOUT_MS;
  if (!raw) return DEFAULT_CLONE_TIMEOUT_MS;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_CLONE_TIMEOUT_MS;
})();
const execFileAsync = promisify(execFile);

interface GitHubRepoInfo {
  owner: string;
  repo: string;
  slug: string;
  sshUrl: string;
}

export class GitCloneError extends Error {
  readonly url: string;
  readonly isTimeout: boolean;
  readonly isAuthError: boolean;

  constructor(message: string, url: string, isTimeout = false, isAuthError = false) {
    super(message);
    this.name = 'GitCloneError';
    this.url = url;
    this.isTimeout = isTimeout;
    this.isAuthError = isAuthError;
  }
}

export function parseGitHubRepoUrl(url: string): GitHubRepoInfo | null {
  const sshMatch = url.match(/^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/i);
  if (sshMatch) {
    const owner = sshMatch[1]!;
    const repo = sshMatch[2]!;
    return {
      owner,
      repo,
      slug: `${owner}/${repo}`,
      sshUrl: `git@github.com:${owner}/${repo}.git`,
    };
  }

  try {
    const parsed = new URL(url);
    if (parsed.hostname !== 'github.com') return null;

    const match = parsed.pathname.match(/^\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/);
    if (!match) return null;

    const owner = match[1]!;
    const repo = match[2]!;
    return {
      owner,
      repo,
      slug: `${owner}/${repo}`,
      sshUrl: `git@github.com:${owner}/${repo}.git`,
    };
  } catch {
    return null;
  }
}

export function isGitHubHttpsCloneUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && parsed.hostname === 'github.com';
  } catch {
    return false;
  }
}

export function isGitHubSsoAuthError(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes('saml sso') ||
    lower.includes('enforced sso') ||
    lower.includes('enabled or enforced saml') ||
    lower.includes('re-authorize the oauth application')
  );
}

function isAuthFailure(message: string): boolean {
  return (
    message.includes('Authentication failed') ||
    message.includes('could not read Username') ||
    message.includes('Permission denied') ||
    message.includes('Repository not found') ||
    message.includes('requested URL returned error: 403') ||
    isGitHubSsoAuthError(message)
  );
}

// simple-git 3.3x 的 @simple-git/argv-parser 守卫按「小写名」检查一批环境变量
// (editor/git_editor/pager/git_pager/git_askpass/ssh_askpass/git_ssh(_command)/
// git_config*/prefix 等),命中即抛
//   Use of "X" is not permitted without enabling allowUnsafeXxx
// 开发者终端、agent 运行时、以及 npm/npx(注入默认 EDITOR=vi)普遍携带这些变量;
// 克隆是非交互操作全部用不到,统一剥离。守卫表来源:
// @simple-git/argv-parser@1.1.1 src/env/parse-env.ts(GitEnvKeys)。
const GUARDED_ENV_KEYS: Record<string, true> = {
  editor: true,
  git_editor: true,
  git_sequence_editor: true,
  pager: true,
  git_pager: true,
  visual: true,
  git_askpass: true,
  ssh_askpass: true,
  git_ssh: true,
  git_ssh_command: true,
  git_proxy_command: true,
  git_exec_path: true,
  git_external_diff: true,
  git_template_dir: true,
  prefix: true,
  git_config: true,
  git_config_global: true,
  git_config_system: true,
};

/** 剥离会触发 simple-git 守卫的环境变量(大小写不敏感,含 git_config_* 通配)。导出仅供测试。 */
export function stripGuardedEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  for (const key of Object.keys(env)) {
    const lower = key.toLowerCase();
    if (GUARDED_ENV_KEYS[lower] === true || lower.startsWith('git_config_')) {
      delete env[key];
    }
  }
  return env;
}

function createGitClient(sshCommand?: string) {
  // [skill-switch 本地改动 ×2] 上游锁 simple-git ^3.27;本仓库用 3.36:
  // 1) `env` 不再是构造选项 → 下移为链式 .env(...)(语义等价);
  // 2) 3.3x 给 filter.* config 加了安全守卫,会在调用 git 前抛
  //    "Configuring filter.smudge is not permitted without enabling allowUnsafeFilter"。
  //    下面的 filter.lfs.* 是上游有意传入的 LFS 规避配置,故显式放行;
  //    typings 未暴露 unsafe 选项,经 Parameters<> 断言传入。见 UPSTREAM.md。
  const config = [
    // When git-lfs is NOT installed, GIT_LFS_SKIP_SMUDGE has no effect —
    // git sees `filter=lfs` in .gitattributes, tries to run
    // `git-lfs filter-process`, and aborts the checkout with:
    //   git-lfs filter-process: git-lfs: command not found
    //   fatal: the remote end hung up unexpectedly
    //   warning: Clone succeeded, but checkout failed.
    // Overriding filter.lfs.* at the command level disables the filter
    // entirely for this clone, so checkout succeeds regardless of whether
    // git-lfs is installed. LFS-tracked files are left as ~130-byte
    // pointer files, which the skills installer doesn't read anyway
    // (skills are plain text — HTML/MD/JSON — never LFS-tracked).
    //
    // Reported downstream: heygen-com/hyperframes#407.
    'filter.lfs.required=false',
    'filter.lfs.smudge=',
    'filter.lfs.clean=',
    'filter.lfs.process=',
  ];
  if (sshCommand !== undefined) {
    // SSH 回退经 -c core.sshCommand 注入而非 GIT_SSH_COMMAND 环境变量:
    // 后者同样在守卫表里会被剥离;-c 的命令行优先级高于环境变量且不受守卫检查。
    config.push(`core.sshCommand=${sshCommand}`);
  }
  const options = {
    timeout: { block: CLONE_TIMEOUT_MS },
    unsafe: { allowUnsafeFilter: true },
    config,
  };
  const env = stripGuardedEnv({
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    // When git-lfs IS installed, tell it not to download LFS content
    // during checkout. See #952 for context and empirical impact.
    GIT_LFS_SKIP_SMUDGE: '1',
  });
  return simpleGit(options as Parameters<typeof simpleGit>[0]).env(env);
}

async function resetTempDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true }).catch(() => {});
  await mkdir(dir, { recursive: true });
}

async function tryGhClone(repo: GitHubRepoInfo, tempDir: string, ref?: string): Promise<boolean> {
  let cloneTarget = repo.slug;

  try {
    const { stdout, stderr } = await execFileAsync('gh', ['auth', 'status', '-h', 'github.com'], {
      timeout: 5000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
    const statusOutput = `${stdout}${stderr}`;
    if (/Git operations protocol:\s+ssh/i.test(statusOutput)) {
      cloneTarget = repo.sshUrl;
    }
  } catch {
    return false;
  }

  const gitFlags = ref ? ['--depth=1', '--branch', ref] : ['--depth=1'];
  await execFileAsync('gh', ['repo', 'clone', cloneTarget, tempDir, '--', ...gitFlags], {
    timeout: CLONE_TIMEOUT_MS,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  return true;
}

function buildGitHubAuthError(url: string, repo: GitHubRepoInfo | null, message: string): string {
  if (repo && isGitHubSsoAuthError(message)) {
    return (
      `GitHub blocked HTTPS access to ${url} because the organization enforces SAML SSO.\n` +
      `  skills tried your existing git credentials and available fallbacks, but none succeeded.\n` +
      `  - Re-authorize your GitHub credentials/app for that org's SSO policy\n` +
      `  - Or rerun with SSH: npx skills add ${repo.sshUrl}\n` +
      `  - Verify access with: gh auth status -h github.com or ssh -T git@github.com`
    );
  }

  if (repo) {
    return (
      `Authentication failed for ${url}.\n` +
      `  - For private repos, ensure you have access\n` +
      `  - Retry with SSH: npx skills add ${repo.sshUrl}\n` +
      `  - Check access with: gh auth status -h github.com or ssh -T git@github.com`
    );
  }

  return (
    `Authentication failed for ${url}.\n` +
    `  - For private repos, ensure you have access\n` +
    `  - For SSH: Check your keys with 'ssh -T git@github.com'\n` +
    `  - For HTTPS: Run 'gh auth login' or configure git credentials`
  );
}

export async function cloneRepo(url: string, ref?: string): Promise<string> {
  const tempDir = await mkdtemp(join(tmpdir(), 'skills-'));
  const cloneOptions = ref ? ['--depth', '1', '--branch', ref] : ['--depth', '1'];
  const repo = parseGitHubRepoUrl(url);

  try {
    await createGitClient().clone(url, tempDir, cloneOptions);
    return tempDir;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const isTimeout = errorMessage.includes('block timeout') || errorMessage.includes('timed out');
    const isAuthError = isAuthFailure(errorMessage);

    if (isTimeout) {
      await rm(tempDir, { recursive: true, force: true }).catch(() => {});
      const seconds = Math.round(CLONE_TIMEOUT_MS / 1000);
      throw new GitCloneError(
        `Clone timed out after ${seconds}s. Common causes:\n` +
          `  - Large repository: raise the timeout with SKILLS_CLONE_TIMEOUT_MS=600000 (10m)\n` +
          `  - Slow network: retry, or clone manually and pass the local path to 'skills add'\n` +
          `  - Private repo without credentials: ensure auth is configured\n` +
          `      - For SSH: ssh-add -l (to check loaded keys)\n` +
          `      - For HTTPS: gh auth status (if using GitHub CLI)`,
        url,
        true,
        false
      );
    }

    if (isAuthError && repo && isGitHubHttpsCloneUrl(url)) {
      try {
        await resetTempDir(tempDir);
        if (await tryGhClone(repo, tempDir, ref)) {
          return tempDir;
        }
      } catch {
        // Fall through to SSH retry.
      }

      try {
        await resetTempDir(tempDir);
        await createGitClient(
          process.env.GIT_SSH_COMMAND ?? 'ssh -o BatchMode=yes',
        ).clone(repo.sshUrl, tempDir, cloneOptions);
        return tempDir;
      } catch {
        // Fall through to the targeted auth error below.
      }
    }

    await rm(tempDir, { recursive: true, force: true }).catch(() => {});

    if (isAuthError) {
      throw new GitCloneError(buildGitHubAuthError(url, repo, errorMessage), url, false, true);
    }

    throw new GitCloneError(`Failed to clone ${url}: ${errorMessage}`, url, false, false);
  }
}

export async function cleanupTempDir(dir: string): Promise<void> {
  // Validate that the directory path is within tmpdir to prevent deletion of arbitrary paths
  const normalizedDir = normalize(resolve(dir));
  const normalizedTmpDir = normalize(resolve(tmpdir()));

  if (!normalizedDir.startsWith(normalizedTmpDir + sep) && normalizedDir !== normalizedTmpDir) {
    throw new Error('Attempted to clean up directory outside of temp directory');
  }

  await rm(dir, { recursive: true, force: true });
}
