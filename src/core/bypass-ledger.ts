// M0-5.8:force 安装(越过 audit 拦截)的留痕账本。
// 这是安全审计记录,不是可丢弃缓存 —— 用 fail-loud 的 readJsonState(损坏要报,不静默)。
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentType } from '../vendor/vercel-skills/types.ts';
import { readJsonState, writeJsonState } from './state-io.ts';

export interface BypassRecord {
  name: string;
  agent: AgentType;
  auditBypassed: true;
  bypassedAt: string;
  bypassReason?: string;
  score: number;
  bypassedFindings: Array<{ ruleId: string; severity: string }>;
  cliVersion: string;
}

export interface BypassLedgerFile {
  version: 1;
  bypasses: BypassRecord[];
}

export function getBypassLedgerPath(home: string): string {
  return join(home, '.skill-switch', 'bypass-ledger.json');
}

export async function readBypassLedger(home: string): Promise<BypassLedgerFile> {
  const data = await readJsonState<BypassLedgerFile>(getBypassLedgerPath(home), {
    version: 1,
    bypasses: [],
  });
  if (typeof data !== 'object' || data === null || !Array.isArray(data.bypasses)) {
    return { version: 1, bypasses: [] };
  }
  return data;
}

export async function recordBypasses(home: string, records: BypassRecord[]): Promise<void> {
  if (records.length === 0) return;
  const ledger = await readBypassLedger(home);
  await writeJsonState(getBypassLedgerPath(home), {
    version: 1,
    bypasses: [...ledger.bypasses, ...records],
  });
}

/** best-effort 读取 CLI 版本(SEA 包里读不到 package.json 时回退 unknown)。 */
export async function getCliVersion(): Promise<string> {
  try {
    const coreDir = fileURLToPath(new URL('.', import.meta.url));
    const pkg = JSON.parse(await readFile(join(coreDir, '..', '..', 'package.json'), 'utf8')) as {
      version?: string;
    };
    return pkg.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}
