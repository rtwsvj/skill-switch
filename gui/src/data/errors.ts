// 数据层的结构化命令错误:携带 i18n code + 插值参数,数据层不硬编码任何本地化文案。
// error.message 保留稳定的英文兜底(给日志/控制台/堆栈),用户可见文案由 UI 用
// localizedErrorDetail(reason, t) → t(`errors.${code}`, params) 按当前语言渲染。
// 这样英文/日文/西语模式下不会再泄漏中文。

export type CommandErrorParams = Record<string, string | number>;

/** 任何「应翻译后展示」的命令错误的基类:带 code + 插值参数。 */
export class LocalizedCommandError extends Error {
  readonly code: string;
  readonly params: CommandErrorParams;

  constructor(code: string, params: CommandErrorParams, fallback: string) {
    super(fallback);
    this.name = 'LocalizedCommandError';
    this.code = code;
    this.params = params;
  }
}

/** per-command 超时上限触发,子进程已被终止。 */
export class CommandTimeoutError extends LocalizedCommandError {
  constructor(label: string, timeoutMs: number) {
    super('commandTimeout', { label, timeoutMs }, `${label} timed out after ${timeoutMs}ms`);
    this.name = 'CommandTimeoutError';
  }
}

/** 调用方通过 AbortSignal 取消。 */
export class CommandCancelledError extends LocalizedCommandError {
  constructor(label: string) {
    super('commandCancelled', { label }, `${label} cancelled`);
    this.name = 'CommandCancelledError';
  }
}

/** 命令退出码 0 但 stdout 为空,拿不到可解析的 JSON。 */
export class NoJsonOutputError extends LocalizedCommandError {
  constructor(label: string, stderr: string) {
    const detail = stderr.slice(0, 300);
    super('noJsonOutput', { label, stderr: detail }, `${label} produced no JSON output. stderr: ${detail}`);
    this.name = 'NoJsonOutputError';
  }
}

/** stdout 非空但不是合法 JSON(截断 / 非 JSON 输出等)。 */
export class InvalidJsonError extends LocalizedCommandError {
  constructor(label: string, cause: string, stdout: string, stderr: string) {
    const stdoutSnippet = stdout.slice(0, 300);
    const stderrSnippet = stderr.slice(0, 300);
    super(
      'invalidJson',
      { label, cause, stdout: stdoutSnippet, stderr: stderrSnippet },
      `${label} output is not valid JSON: ${cause}\nstdout: ${stdoutSnippet}\nstderr: ${stderrSnippet}`,
    );
    this.name = 'InvalidJsonError';
  }
}

type ErrorTranslate = (key: string, params?: CommandErrorParams) => string;

/**
 * 把任意 reason 解析成可展示的、已本地化的 detail 文本。
 * 结构化命令错误走 t(`errors.${code}`, params);其余回退到 message/String。
 */
export function localizedErrorDetail(reason: unknown, translate: ErrorTranslate): string {
  if (reason instanceof LocalizedCommandError) {
    return translate(`errors.${reason.code}`, reason.params);
  }
  return reason instanceof Error ? reason.message : String(reason);
}
