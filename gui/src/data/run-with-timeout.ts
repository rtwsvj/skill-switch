// M0-5.5:统一的命令运行编排 —— per-command timeout + 可取消(AbortSignal)。
// 与 Tauri 解耦成纯逻辑,便于单测:调用方给一个 spawn(),返回 { result, kill }。
export interface SpawnHandle {
  result: Promise<{ code: number | null; stdout: string; stderr: string }>;
  kill: () => void;
}

export class CommandTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CommandTimeoutError';
  }
}

export class CommandCancelledError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CommandCancelledError';
  }
}

export async function runWithTimeout(
  spawn: () => SpawnHandle,
  label: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const handle = spawn();
  return await new Promise((resolve, reject) => {
    let settled = false;
    const finish = (run: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      run();
    };
    const timer = setTimeout(() => {
      handle.kill();
      finish(() => reject(new CommandTimeoutError(`${label} 超时(${timeoutMs}ms),已终止`)));
    }, timeoutMs);
    const onAbort = () => {
      handle.kill();
      finish(() => reject(new CommandCancelledError(`${label} 已取消`)));
    };
    if (signal?.aborted) {
      handle.kill();
      finish(() => reject(new CommandCancelledError(`${label} 已取消`)));
      return;
    }
    signal?.addEventListener('abort', onAbort);
    handle.result.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error)),
    );
  });
}
