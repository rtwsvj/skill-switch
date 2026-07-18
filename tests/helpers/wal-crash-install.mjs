// WAL kill 矩阵子进程:跑真实 installFromSource,在指定步骤后 SIGKILL 自杀,
// 模拟断电/强杀。由 tests/wal-install-kill.test.ts spawn。
import { register } from 'tsx/esm/api';

register();
const { installFromSource } = await import('../../src/core/install.ts');

const home = process.env.WAL_HOME;
const source = process.env.WAL_SOURCE;
const crashAfter = process.env.WAL_CRASH_AFTER; // 缺省 = 正常跑完

if (!home || !source) {
  console.error('wal-crash-install: missing WAL_HOME / WAL_SOURCE');
  process.exit(2);
}

await installFromSource(source, {
  home,
  agent: process.env.WAL_AGENT || 'claude-code',
  mode: 'copy',
  onStep: (stepId) => {
    if (crashAfter && stepId === crashAfter) {
      process.kill(process.pid, 'SIGKILL');
    }
  },
});
