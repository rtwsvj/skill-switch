// M0-5.5:统一的命令运行编排 —— per-command timeout + 可取消(AbortSignal)。
// 与 Tauri 解耦成纯逻辑,便于单测:调用方给一个 spawn(),返回 { result, kill }。
import { CommandCancelledError, CommandTimeoutError } from './errors';

export { CommandCancelledError, CommandTimeoutError } from './errors';

export interface SpawnHandle {
  result: Promise<{ code: number | null; stdout: string; stderr: string }>;
  kill: () => void;
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
      finish(() => reject(new CommandTimeoutError(label, timeoutMs)));
    }, timeoutMs);
    const onAbort = () => {
      handle.kill();
      finish(() => reject(new CommandCancelledError(label)));
    };
    if (signal?.aborted) {
      handle.kill();
      finish(() => reject(new CommandCancelledError(label)));
      return;
    }
    signal?.addEventListener('abort', onAbort);
    handle.result.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error)),
    );
  });
}
