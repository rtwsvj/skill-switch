// WAL kill 矩阵子进程:按 WAL_OPERATION 分发到 toggle/remove/sync 核心写操作,
// 在指定步骤后 SIGKILL 自杀,模拟断电/强杀。由 tests/wal-mutations-kill.test.ts spawn。
// fixture 准备在测试进程内完成;本子进程只跑目标操作。
import { register } from 'tsx/esm/api';

register();

const home = process.env.WAL_HOME;
const operation = process.env.WAL_OPERATION;
const crashAfter = process.env.WAL_CRASH_AFTER; // 缺省 = 正常跑完

if (!home || !operation) {
  console.error('wal-crash-mutation: missing WAL_HOME / WAL_OPERATION');
  process.exit(2);
}

const onStep = (stepId) => {
  if (crashAfter && stepId === crashAfter) {
    process.kill(process.pid, 'SIGKILL');
  }
};

if (operation === 'toggle') {
  const { toggleSkill } = await import('../../src/core/toggle.ts');
  const name = process.env.WAL_NAME;
  const enabled = process.env.WAL_ENABLED === 'true';
  if (!name) {
    console.error('wal-crash-mutation toggle: missing WAL_NAME');
    process.exit(2);
  }
  await toggleSkill(home, name, enabled, { onStep });
} else if (operation === 'remove') {
  const { removeSkill } = await import('../../src/core/remove.ts');
  const name = process.env.WAL_NAME;
  const agent = process.env.WAL_AGENT || 'claude-code';
  if (!name) {
    console.error('wal-crash-mutation remove: missing WAL_NAME');
    process.exit(2);
  }
  await removeSkill(home, name, agent, { onStep });
} else if (operation === 'sync') {
  // 声明已由测试进程改好;子进程只跑带锁 applySync。
  const { applySync, getSkillsJsonPath, readDeclaration } = await import('../../src/core/sync.ts');
  const declaration = await readDeclaration(getSkillsJsonPath(home));
  await applySync(home, declaration, { onStep });
} else {
  console.error(`wal-crash-mutation: unknown WAL_OPERATION=${operation}`);
  process.exit(2);
}
