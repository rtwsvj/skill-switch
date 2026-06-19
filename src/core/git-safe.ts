// Git source safety guard shared by install/drift before invoking git.
//
// Git transport-helper syntax (`<helper>::<address>`, for example ext::) can run
// helper commands before any repository content is fetched. Treat lock/install
// sources using that syntax as invalid input rather than an unreachable remote.
export function assertSafeGitSource(source: string): void {
  if (source.startsWith('-')) {
    throw new Error(`不安全的 git 来源(不能以 '-' 开头): ${source}`);
  }
  if (/^[a-z][a-z0-9+.-]*::/i.test(source)) {
    throw new Error(`不支持的 git 传输形式(可能在安全检查前执行命令,已拒绝): ${source}`);
  }
}
