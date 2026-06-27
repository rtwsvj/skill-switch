// 「一键安装」解析层:把一段粘贴内容(GitHub 链接 / git clone / npx·npm 指令)
// 解析成规范化的 git 来源。**纯函数、零网络、零执行**。
//
// 关键安全点:遇到 curl|bash、bash <(…)、任意 shell 安装片段 → 一律 unsupported(拒绝),
// 绝不尝试执行;npm 包名只标记出来,实际仓库地址交给 resolveNpmPackage(只读 registry)。
import type { ParsedSource } from './types.ts';

/** 危险/无法静态审计的 shell 执行形态(出现即拒绝)。 */
const SHELL_EXEC_MARKERS = [
  /\|\s*(ba)?sh\b/, // … | bash / | sh
  /<\(\s*(curl|wget)/, // bash <(curl …)
  /\beval\b/,
  /\bsudo\b/,
];

/** 看起来像「下载并执行」的命令前缀。 */
const FETCH_EXEC_PREFIX = /^(curl|wget|bash|sh|zsh|source|\.)\b/;

/** 从 GitHub 网页/仓库链接抽出 owner/repo/ref/subdir。失败返回 null。 */
function parseGithubUrl(url: string): ParsedSource | null {
  // 容忍无 scheme 的 github.com/…
  const normalized = /^https?:\/\//.test(url) ? url : `https://${url}`;
  let u: URL;
  try {
    u = new URL(normalized);
  } catch {
    return null;
  }
  if (!/(^|\.)github\.com$/i.test(u.hostname)) return null;

  const segs = u.pathname.split('/').filter(Boolean);
  if (segs.length < 2) return null;
  const owner = segs[0]!;
  const repo = segs[1]!.replace(/\.git$/i, '');
  if (!owner || !repo) return null;

  const gitSource = `https://github.com/${owner}/${repo}.git`;
  const result: ParsedSource = { kind: 'github-url', raw: url, gitSource };

  // /tree/<ref>/<subdir…> 或 /blob/<ref>/<path…>
  if (segs.length >= 4 && (segs[2] === 'tree' || segs[2] === 'blob')) {
    result.ref = decodeURIComponent(segs[3]!);
    const rest = segs.slice(4).map((s) => decodeURIComponent(s));
    if (rest.length > 0) {
      // blob 指向具体文件 → 取其所在目录作为子目录
      const sub = segs[2] === 'blob' ? rest.slice(0, -1) : rest;
      if (sub.length > 0) result.subdir = sub.join('/');
    }
  }
  return result;
}

/** 判断是否是泛型 git 源(.git 结尾 / git@host:… / ssh:// / file://)。 */
function parseGenericGitUrl(token: string): ParsedSource | null {
  if (/^git@[^:]+:.+/.test(token) || /^ssh:\/\//.test(token)) {
    return { kind: 'git-url', raw: token, gitSource: token };
  }
  if (/^file:\/\//.test(token)) {
    return { kind: 'git-url', raw: token, gitSource: token };
  }
  if (/^https?:\/\/\S+\.git$/i.test(token)) {
    return { kind: 'git-url', raw: token, gitSource: token };
  }
  return null;
}

/** 把 npm/npx 风格的 `github:owner/repo` 简写转成 github 源。 */
function parseGithubShorthand(spec: string): ParsedSource | null {
  const m = /^github:([\w.-]+)\/([\w.-]+?)(?:#([\w./-]+))?$/.exec(spec);
  if (!m) return null;
  const owner = m[1]!;
  const repo = m[2]!.replace(/\.git$/i, '');
  const ref = m[3];
  const out: ParsedSource = {
    kind: 'github-url',
    raw: spec,
    gitSource: `https://github.com/${owner}/${repo}.git`,
  };
  if (ref) out.ref = ref;
  return out;
}

/** 从 `git clone …` 命令里抽出 URL(+ --branch ref)。 */
function parseGitClone(line: string): ParsedSource | null {
  const tokens = line.trim().split(/\s+/);
  if (tokens[0] !== 'git' || tokens[1] !== 'clone') return null;
  let ref: string | undefined;
  let url: string | undefined;
  for (let i = 2; i < tokens.length; i++) {
    const tk = tokens[i]!;
    if (tk === '--branch' || tk === '-b') {
      ref = tokens[++i];
      continue;
    }
    if (tk.startsWith('-')) {
      // 形如 --depth=1 跳过;--depth 1 跳过其值
      if (!tk.includes('=') && tokens[i + 1] && !tokens[i + 1]!.startsWith('-')) i++;
      continue;
    }
    if (!url) url = tk; // 第一个非 flag 即仓库地址(其后是目标目录,忽略)
  }
  if (!url) return null;
  const parsed = parseGithubUrl(url) ?? parseGenericGitUrl(url);
  if (!parsed) return null;
  return { ...parsed, kind: 'git-clone', raw: line, ...(ref ? { ref } : parsed.ref ? {} : {}) };
}

/** 从 `npx/npm/pnpm/yarn …` 命令里抽出包规格。 */
function parseNpmCommand(line: string): ParsedSource | null {
  const tokens = line.trim().split(/\s+/);
  const head = tokens[0];
  let idx = -1;
  if (head === 'npx') idx = 1;
  else if ((head === 'npm' || head === 'pnpm') && (tokens[1] === 'install' || tokens[1] === 'i' || tokens[1] === 'add'))
    idx = 2;
  else if (head === 'yarn' && tokens[1] === 'add') idx = 2;
  if (idx === -1) return null;

  // 跳过 flags,取第一个像包规格的 token。
  // 注意:npm/npx 的 flag 绝大多数是布尔(-g/--global/-y/-D…),不吃值,
  // 所以这里只跳 flag token 本身,绝不顺带跳下一个(否则会误吞 `-g <包名>` 里的包名)。
  let spec: string | undefined;
  for (let i = idx; i < tokens.length; i++) {
    const tk = tokens[i]!;
    if (tk.startsWith('-')) continue;
    spec = tk;
    break;
  }
  if (!spec) return null;

  // github: 简写 → 直接当 github 源
  const gh = parseGithubShorthand(spec);
  if (gh) return { ...gh, raw: line };
  // 直接是 URL?
  const asUrl = parseGithubUrl(spec) ?? parseGenericGitUrl(spec);
  if (asUrl) return { ...asUrl, raw: line };

  // 真·npm 包名(去掉 @version 后缀;保留 scope 的前导 @)
  const name = spec.replace(/^(@[^/]+\/[^@]+|[^@/][^@]*)@.*/, '$1');
  return {
    kind: 'npm',
    raw: line,
    npmPackage: name,
    note: '这是一个 npm 包名;将只读查询 npm registry 拿到它的源码仓库地址,再克隆审计该仓库。',
    provenanceWarning:
      '注意:npm 上发布的包内容可能与其源码仓库不完全一致(发布时可被改动)。这里审计的是源码仓库,不是 npm 包的实际产物。',
  };
}

/**
 * 把一段粘贴内容解析成规范化来源。纯函数,无网络、无执行。
 *
 * 支持:GitHub 仓库/子目录链接、`git clone …`、`npx/npm/pnpm/yarn …`(含 github: 简写)、泛型 git 源。
 * 拒绝:curl|bash、bash <(…)、任意下载即执行的 shell 片段 → kind 'unsupported'。
 */
export function parseSource(rawInput: string): ParsedSource {
  const raw = rawInput.trim();
  if (!raw) {
    return { kind: 'unsupported', raw: rawInput, note: '输入为空。' };
  }

  // 多行/带说明文字:逐行找出第一条能识别的;都不行再整体判断。
  const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const single = lines.length === 1 ? raw : '';

  // 1) 明确的危险执行形态 → 直接拒绝(优先于一切)
  const dangerous = (s: string) =>
    SHELL_EXEC_MARKERS.some((re) => re.test(s)) || FETCH_EXEC_PREFIX.test(s);

  // 单行命令优先按结构解析
  for (const line of lines.length ? lines : [raw]) {
    if (dangerous(line)) {
      // 危险行里若恰好嵌了 github 链接,也不放行——避免「curl … github.com … | bash」被误抽
      continue;
    }
    const clone = parseGitClone(line);
    if (clone) return clone;
    const npm = parseNpmCommand(line);
    if (npm) return npm;
    const gh = parseGithubUrl(line);
    if (gh) return gh;
    const generic = parseGenericGitUrl(line);
    if (generic) return generic;
  }

  // 若整体含危险执行形态 → 不做任何"兜底抽链接"(那个 github 链接极可能是危险命令的参数)。
  const anyDangerous = dangerous(raw) || lines.some(dangerous);

  // 2) 没有危险形态时,才在整段文本里兜底找一个 github 链接(粘了带说明的代码块时)
  if (!anyDangerous) {
    const ghMatch = /(https?:\/\/github\.com\/[\w.-]+\/[\w.-]+(?:\/(?:tree|blob)\/[\w./-]+)?)/i.exec(
      raw,
    );
    if (ghMatch) {
      const gh = parseGithubUrl(ghMatch[1]!);
      if (gh) return gh;
    }
  }

  // 3) 走到这里:要么是 curl|bash 这类,要么无法识别 → 拒绝并解释
  const looksLikeShell = anyDangerous || (single !== '' && dangerous(single));
  return {
    kind: 'unsupported',
    raw,
    note: looksLikeShell
      ? '这是一条会「下载并执行」的命令(如 curl … | bash)。skill-switch 绝不执行任意命令,也无法对它静态审计。请改贴该 skill 的 GitHub 链接,或 `git clone` 地址。'
      : '无法从输入里识别出可审计的 git 来源。请贴 GitHub 仓库/子目录链接、`git clone <url>`,或 `npx/npm` 安装命令。',
  };
}
