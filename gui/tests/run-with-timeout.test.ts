// M0-5.5:超时/取消编排逻辑单测(纯逻辑,不依赖 Tauri)。
import { describe, expect, it, vi } from 'vitest';
import {
  CommandCancelledError,
  CommandTimeoutError,
  runWithTimeout,
  type SpawnHandle,
} from '../src/data/run-with-timeout';

function handle(result: Promise<{ code: number | null; stdout: string; stderr: string }>) {
  const kill = vi.fn();
  const spawn = (): SpawnHandle => ({ result, kill });
  return { spawn, kill };
}

describe('runWithTimeout', () => {
  it('resolves with the command result and never kills when it finishes in time', async () => {
    const { spawn, kill } = handle(Promise.resolve({ code: 0, stdout: '{}', stderr: '' }));
    const out = await runWithTimeout(spawn, 'scan', 1000);
    expect(out).toEqual({ code: 0, stdout: '{}', stderr: '' });
    expect(kill).not.toHaveBeenCalled();
  });

  it('kills the child and rejects with CommandTimeoutError on timeout', async () => {
    const { spawn, kill } = handle(new Promise(() => {})); // 永不结束
    await expect(runWithTimeout(spawn, 'stats', 20)).rejects.toBeInstanceOf(CommandTimeoutError);
    expect(kill).toHaveBeenCalledTimes(1);
  });

  it('kills the child and rejects with CommandCancelledError when the signal aborts', async () => {
    const { spawn, kill } = handle(new Promise(() => {}));
    const controller = new AbortController();
    const promise = runWithTimeout(spawn, 'install', 10_000, controller.signal);
    controller.abort();
    await expect(promise).rejects.toBeInstanceOf(CommandCancelledError);
    expect(kill).toHaveBeenCalledTimes(1);
  });

  it('rejects immediately if the signal is already aborted', async () => {
    const { spawn, kill } = handle(new Promise(() => {}));
    const controller = new AbortController();
    controller.abort();
    await expect(runWithTimeout(spawn, 'sync', 10_000, controller.signal)).rejects.toBeInstanceOf(
      CommandCancelledError,
    );
    expect(kill).toHaveBeenCalledTimes(1);
  });

  it('propagates the underlying command failure', async () => {
    const { spawn } = handle(Promise.reject(new Error('spawn boom')));
    await expect(runWithTimeout(spawn, 'audit', 1000)).rejects.toThrow('spawn boom');
  });
});
