// F2 lock 子命令:只读 skills.lock;--verify 时重算磁盘安装产物哈希用于 CI。
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Command } from 'commander';
import { computeSkillFolderHash } from '../../vendor/vercel-skills/local-lock.ts';
import type { AgentType } from '../../vendor/vercel-skills/types.ts';
import {
  getSkillsLockPath,
  readSkillsLock,
  type SkillsLockEntry,
  type SkillsLockFile,
} from '../../core/lock.ts';
import { getAgentSkillsLocations, resolveGlobalSkillsDir, resolveHomeRoot } from '../../core/paths.ts';

interface LockCliOptions {
  home?: string;
  json?: boolean;
  verify?: boolean;
}

type VerifyStatus = 'ok' | 'missing' | 'mismatch' | 'unknown-agent';

interface LockVerifyEntry {
  name: string;
  agent: AgentType;
  target?: string;
  expectedSha256: string;
  actualSha256?: string;
  status: VerifyStatus;
}

interface LockVerifyReport {
  ok: boolean;
  lockPath: string;
  entries: LockVerifyEntry[];
}

function targetFor(home: string, entry: SkillsLockEntry): string | undefined {
  const location = getAgentSkillsLocations().find((l) => l.agent === entry.agent);
  if (!location) return undefined;
  return join(resolveGlobalSkillsDir(home, location), entry.name);
}

async function verifyLock(home: string, lockPath: string, lock: SkillsLockFile): Promise<LockVerifyReport> {
  const entries: LockVerifyEntry[] = [];

  for (const entry of lock.skills) {
    const target = targetFor(home, entry);
    if (!target) {
      entries.push({
        name: entry.name,
        agent: entry.agent,
        expectedSha256: entry.sha256,
        status: 'unknown-agent',
      });
      continue;
    }

    if (!existsSync(target)) {
      entries.push({
        name: entry.name,
        agent: entry.agent,
        target,
        expectedSha256: entry.sha256,
        status: 'missing',
      });
      continue;
    }

    const actualSha256 = await computeSkillFolderHash(target);
    entries.push({
      name: entry.name,
      agent: entry.agent,
      target,
      expectedSha256: entry.sha256,
      actualSha256,
      status: actualSha256 === entry.sha256 ? 'ok' : 'mismatch',
    });
  }

  return {
    ok: entries.every((entry) => entry.status === 'ok'),
    lockPath,
    entries,
  };
}

function printLock(lockPath: string, lock: SkillsLockFile): void {
  if (lock.skills.length === 0) {
    console.log(`skills.lock 空: ${lockPath}`);
    return;
  }

  console.log(`skills.lock: ${lockPath}`);
  for (const entry of lock.skills) {
    const commit = entry.commit ? ` commit=${entry.commit.slice(0, 12)}` : '';
    console.log(
      `  ${entry.agent}/${entry.name}  ${entry.mode}  ${entry.sourceType}  sha=${entry.sha256.slice(0, 12)}${commit}`,
    );
  }
}

function printVerify(report: LockVerifyReport): void {
  if (report.ok) {
    console.log(`✓ skills.lock 校验通过(${report.entries.length} 条): ${report.lockPath}`);
    return;
  }

  console.log(`✗ skills.lock 校验失败(${report.entries.length} 条): ${report.lockPath}`);
  for (const entry of report.entries.filter((e) => e.status !== 'ok')) {
    console.log(`  [${entry.status}] ${entry.agent}/${entry.name}${entry.target ? `  ${entry.target}` : ''}`);
    if (entry.actualSha256) {
      console.log(`    磁盘 ${entry.actualSha256.slice(0, 12)}… ≠ 锁内 ${entry.expectedSha256.slice(0, 12)}…`);
    }
  }
}

export function registerLockCommand(program: Command): void {
  program
    .command('lock')
    .description('查看 skills.lock;--verify 时重算磁盘哈希并在不一致时 exit 1')
    .option('--home <dir>', '覆盖 home 根目录(默认取系统 home)')
    .option('--verify', '重算安装产物哈希,与 skills.lock 比对')
    .option('--json', '机器可读 JSON 输出')
    .action(async (options: LockCliOptions, command: Command) => {
      const home = resolveHomeRoot(options.home ?? command.parent?.opts<{ home?: string }>().home);
      const lockPath = getSkillsLockPath(home);
      const lock = await readSkillsLock(lockPath);

      if (!options.verify) {
        if (options.json) console.log(JSON.stringify({ lockPath, ...lock }, null, 2));
        else printLock(lockPath, lock);
        return;
      }

      const report = await verifyLock(home, lockPath, lock);
      if (options.json) console.log(JSON.stringify(report, null, 2));
      else printVerify(report);
      if (!report.ok) process.exitCode = 1;
    });
}
