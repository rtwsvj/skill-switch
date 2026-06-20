// M0-5.6/A1:dashboard 装配 —— 任一区块加载失败时用安全默认值兜底,只记录 loadErrors,
// 绝不让一个读命令(典型是 stats 解析 transcript)失败就把整个 GUI 变白错误屏。
import type {
  AuditReport,
  DashboardData,
  DoctorReport,
  LockVerifyReport,
  ScanReport,
  StatsReport,
} from './types';

export const emptyScan: ScanReport = { home: '', total: 0, skills: [] };
export const emptyDoctor: DoctorReport = {
  findings: [],
  clean: true,
  checked: { declared: 0, locked: 0 },
  declarations: [],
};
export const emptyStats: StatsReport = { scannedFiles: 0, invocations: 0, usage: [], zombies: [] };
export const emptyLockVerify: LockVerifyReport = { ok: true, lockPath: '', entries: [] };

export interface DashboardParts {
  scan: PromiseSettledResult<ScanReport>;
  audit: PromiseSettledResult<AuditReport[]>;
  doctor: PromiseSettledResult<DoctorReport>;
  stats: PromiseSettledResult<StatsReport>;
  lockVerify: PromiseSettledResult<LockVerifyReport>;
}

function reasonMessage(result: PromiseSettledResult<unknown>): string | undefined {
  if (result.status !== 'rejected') return undefined;
  return result.reason instanceof Error ? result.reason.message : String(result.reason);
}

function valueOr<T>(result: PromiseSettledResult<T>, fallback: T): T {
  return result.status === 'fulfilled' ? result.value : fallback;
}

export function assembleDashboard(
  parts: DashboardParts,
  source: 'fixtures' | 'tauri',
): DashboardData {
  const loadErrors: Record<string, string> = {};
  for (const [key, result] of Object.entries(parts)) {
    const message = reasonMessage(result);
    if (message) loadErrors[key] = message;
  }

  return {
    scan: valueOr(parts.scan, emptyScan),
    audit: valueOr(parts.audit, []),
    doctor: valueOr(parts.doctor, emptyDoctor),
    stats: valueOr(parts.stats, emptyStats),
    lockVerify: valueOr(parts.lockVerify, emptyLockVerify),
    source,
    loadedAt: new Date().toISOString(),
    ...(Object.keys(loadErrors).length > 0 ? { loadErrors } : {}),
  };
}
